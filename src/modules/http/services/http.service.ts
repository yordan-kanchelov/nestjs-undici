import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Transform, type Readable } from 'node:stream';
import {
  request,
  ProxyAgent,
  Agent as UndiciAgent,
  EnvHttpProxyAgent,
} from 'undici';

import { Observable, defer, of } from 'rxjs';
import { mergeMap } from 'rxjs/operators';

import {
  UNDICI_INSTANCE_TOKEN,
  HTTP_MODULE_OPTIONS,
} from '../constants/http.constants';

import type { UrlObject } from 'node:url';
import type { Dispatcher } from 'undici';
import type { HttpModuleOptions, UndiciRequestOptionsType } from '../types';
import type {
  ResolvedHttpModuleOptions,
  ResolvedUndiciRequestOptions,
} from '../internal/resolved-config';
import type {
  HttpInterceptor,
  HttpInterceptorFunction,
  HttpInterceptorHandler,
  HttpInterceptorRequest,
  AxiosLikeRequestConfig,
  InternalAxiosLikeRequestConfig,
  AxiosLikeResponse,
  AxiosRef,
} from '../interfaces';
import {
  AxiosHeaders,
  sanitizeHeadersToByteString,
} from '../interfaces/axios-headers';
import {
  createAxiosRef,
  createAxiosRefDefaults,
  type AxiosInstanceContext,
} from '../adapters/axios-ref.factory';
import {
  createInterceptorStore,
  type AxiosInterceptorEntry,
  type AxiosInterceptorStore,
} from '../adapters/axios-interceptor.adapter';
import {
  buildAxiosConfig,
  buildFormRequestConfig,
  isAxiosRequestConfig,
  normalizeAxiosRequest,
  serializeAxiosConfig,
  SIGNAL_CLEANUP,
} from '../adapters/axios-request.adapter';
import {
  STATUS_TEXT_MAP,
  RequestInfo,
  joinDuplicateHeaders,
  toAxiosLikeResponse,
} from '../adapters/axios-response.adapter';
import {
  dataUrlString,
  resolveDataUrlRequest,
} from '../adapters/axios-data-url.adapter';
import {
  createInvalidSensitiveHeadersError,
  createInvalidUrlError,
  createStatusError,
  createTimeoutError,
  createUnparsableTimeoutError,
  createUnsupportedProtocolError,
  isDeadlineTimeoutReason,
  isUnparsableTimeout,
  toAxiosError,
  type DeadlineTimeoutReason,
} from '../errors/axios-error';
import {
  meterUploadBody,
  resolveMaxRates,
  resolveUploadTotal,
  type MeterOptions,
} from '../adapters/axios-progress.adapter';
import {
  DEFAULT_MAX_REDIRECTS,
  buildRedirectHop,
  createTooManyRedirectsError,
  dumpRedirectBody,
  isRedirectResponse,
  normalizeSensitiveHeaders,
  urlToString,
  type BeforeRedirect,
  type RedirectHopResult,
} from '../adapters/redirect.adapter';

/** The type `request()` (from `undici`) resolves with. */
type UndiciResponse = Dispatcher.ResponseData;

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * `defaults.adapter`/`config.adapter` may be a function, a string adapter
 * name (`'http'`/`'xhr'`/`'fetch'`, ignored - this library always dispatches
 * through undici) or an array of either (axios' fallback-list form; the
 * first function wins). Returns the function to call, if any.
 */
function resolveFunctionAdapter(
  adapter: unknown,
):
  | ((config: InternalAxiosLikeRequestConfig) => Promise<AxiosLikeResponse>)
  | undefined {
  if (typeof adapter === 'function') return adapter as any;
  if (Array.isArray(adapter)) {
    for (const candidate of adapter) {
      if (typeof candidate === 'function') return candidate as any;
    }
  }
  return undefined;
}

/** The one member of `http-cookie-agent/undici` this module needs. */
type CookieAgentCtor = new (options: {
  cookies?: { jar: unknown };
  factory?: () => Dispatcher;
  [key: string]: unknown;
}) => Dispatcher;

/**
 * Lazily loads `http-cookie-agent` (which itself requires `tough-cookie`),
 * only when a module-level `cookieJar` is actually configured. Both are
 * optional peers (see `package.json`): plan.md phase 2, "breaking:
 * `withCredentials` becomes a no-op; add cookieJar" - `withCredentials`
 * itself no longer touches either package, and requiring them unconditionally
 * at module load previously cost about 150ms (`plan/reports/package-quality.md`
 * item 7), so neither is `import`ed at the top of this file - only `require`d
 * here, and only from inside `setupDispatcher`, which runs once per
 * `HttpService`, never on the request path.
 */
function loadCookieAgent(): CookieAgentCtor {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load of an optional peer, see above
    return require('http-cookie-agent/undici').CookieAgent;
  } catch (cause) {
    throw new Error(
      'cookieJar requires the optional peer dependencies http-cookie-agent and tough-cookie; ' +
        'install them with npm i http-cookie-agent tough-cookie',
      { cause },
    );
  }
}

/**
 * Chains one axiosRef interceptor entry onto `source`, matching a single
 * `promise.then(onFulfilled, onRejected)` link in axios' own request/response
 * interceptor chain: `onRejected` only sees a rejection of `source` itself,
 * never one `onFulfilled` raises (that propagates to the *next* link, or
 * uncaught), and an entry with neither handler is a no-op pass-through.
 * Built on real Observables (not Promises) so unsubscribing the outer
 * Observable still tears down (and aborts) an in-flight dispatch reached
 * through one or more interceptors.
 */
function chainStep<T>(
  source: Observable<T>,
  onFulfilled?: (value: T) => T | Promise<T>,
  onRejected?: (error: any) => any,
): Observable<T> {
  if (!onFulfilled && !onRejected) return source;
  return new Observable<T>(subscriber => {
    // Suppresses `source`'s own (synchronous) completion while an async
    // `onFulfilled`/`onRejected` result is still pending, so a same-tick
    // source (e.g. the first link, `of(config)`) can't complete this
    // subscriber before the eventual `.then()` delivers its value.
    let resolving = false;
    const settle = (result: T | Promise<T>): void => {
      if (isPromiseLike<T>(result)) {
        resolving = true;
        result.then(
          value => {
            subscriber.next(value);
            subscriber.complete();
          },
          error => subscriber.error(error),
        );
      } else {
        subscriber.next(result);
        subscriber.complete();
      }
    };
    const subscription = source.subscribe({
      next: value => {
        if (!onFulfilled) {
          subscriber.next(value);
          return;
        }
        try {
          settle(onFulfilled(value));
        } catch (error) {
          subscriber.error(error);
        }
      },
      error: error => {
        if (!onRejected) {
          subscriber.error(error);
          return;
        }
        try {
          settle(onRejected(error));
        } catch (rejectedError) {
          subscriber.error(rejectedError);
        }
      },
      complete: () => {
        if (!resolving) subscriber.complete();
      },
    });
    return () => subscription.unsubscribe();
  });
}

/**
 * The interceptors that actually run for this request, in axios' own
 * execution order: request interceptors last-registered-first (LIFO, axios'
 * default `legacyInterceptorReqResOrdering`), response interceptors
 * first-registered-first (FIFO). `runWhen` (request interceptors only, as in
 * axios) is evaluated once here, against the config as built - before any
 * interceptor in the chain has run - exactly like axios' own filtering pass.
 */
function activeAxiosInterceptors<T>(
  entries: ReadonlyArray<AxiosInterceptorEntry<T> | null>,
  isRequest: boolean,
  config?: InternalAxiosLikeRequestConfig,
): AxiosInterceptorEntry<T>[] {
  const active: AxiosInterceptorEntry<T>[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (isRequest && entry.runWhen && entry.runWhen(config) === false) {
      continue;
    }
    active.push(entry);
  }
  return isRequest ? active.reverse() : active;
}

/**
 * The per-request abort signal passed to undici. undici only needs `aborted`,
 * `reason` and an 'abort' listener, so this is cheaper than a real
 * AbortController (no EventTarget) on every request. Review fix (PR #33):
 * needs *more than one* listener now - undici's own, plus
 * `meterDownloadBody`'s (`axios-progress.adapter.ts`), which reacts to this
 * same signal to reject a still-pending, `maxRate`-paced buffered read even
 * once the raw undici transfer underneath it has already finished (the
 * eager-drain mitigation there means that can now happen well before this
 * fires) - a plain array of listeners is still far cheaper than a real
 * EventTarget.
 */
/** Upper bound on cached per-request `socketPath` Agents (see `getSocketPathDispatcher`). */
const MAX_SOCKET_PATH_DISPATCHERS = 32;

/**
 * Grace period `closeDispatcher` gives an owned dispatcher's graceful
 * `close()` (finish in-flight requests, then resolve) before force-
 * `destroy()`-ing it instead (aborts whatever is left, including an
 * abandoned `responseType: 'stream'` body nobody ever read or `.destroy()`d
 * - see the `signal`/"Always consume or `.destroy()`" note in
 * `docs/axios-supported-options.md`). Without this, `onModuleDestroy` (and
 * `setDispatcher`, which closes the dispatcher it replaces the same way)
 * would wait on `close()` forever whenever such a stream is left open,
 * hanging application shutdown indefinitely (plan.md phase 2, "decide:
 * `HttpService.onModuleDestroy` waits forever...").
 *
 * 5 seconds: long enough that a normal in-flight request/response - even a
 * slow one - finishes gracefully well within it (this is not a per-request
 * timeout; it only bounds how long shutdown waits once `close()` itself is
 * called), short enough that a shutdown with something genuinely abandoned
 * doesn't hang for an unreasonable time. Matches the same order of
 * magnitude as Node's own default HTTP `keepAliveTimeout` (5s) and
 * Kubernetes' default `terminationGracePeriodSeconds` (30s, of which this
 * is a small fraction, leaving headroom for the rest of the shutdown
 * sequence).
 *
 * Deliberately not a public option - see plan.md: this bounds a resource-
 * cleanup implementation detail, not request behaviour a caller configures
 * per module/request. Overridable only for this package's own tests via an
 * internal, undocumented environment variable (never read outside this
 * function, never mentioned in the public docs) - the value itself is a
 * plain internal constant.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;
function shutdownGraceMs(): number {
  const override = process.env.__NESTJS_AXIOS_UNDICI_TEST_SHUTDOWN_GRACE_MS;
  if (override !== undefined) {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_SHUTDOWN_GRACE_MS;
}

/**
 * Closes `dispatcher` gracefully (`close()` - lets in-flight requests
 * finish), racing it against `shutdownGraceMs()`. If the grace period
 * elapses first, forces everything still outstanding to actually stop:
 *
 * - Aborts every request-level signal in `openStreamAborts` (see
 *   `HttpService#trackOpenStream`) - one per still-open, un-drained
 *   `responseType: 'stream'` body dispatched through `dispatcher`. This is
 *   the part that does the real work: confirmed directly against undici
 *   (`lib/dispatcher/agent.js`) that `Agent#close()` - and `ProxyAgent`/
 *   `EnvHttpProxyAgent`, both built on the same `Agent` - clears their own
 *   per-origin bookkeeping *synchronously*, the instant `close()` is
 *   called, before its promise ever settles. A `destroy()` call on that
 *   same instance afterward therefore has nothing left to reach (its own
 *   internals iterate an already-empty registry and resolve as a silent
 *   no-op) - `Agent#destroy()` alone, called after `close()`, does **not**
 *   force-abort an abandoned stream still open on it (verified with a real
 *   server: the socket stayed open indefinitely). Aborting the request's
 *   own `signal` instead works regardless: it's undici's own per-request
 *   abort path (the same one a caller's own `AbortSignal` or this
 *   library's deadline timeout already uses - see `executeRequest`), and a
 *   still-open, zero-listener body reacts to it without an unhandled
 *   `'error'` (confirmed directly against undici's `BodyReadable`).
 * - Calls `dispatcher.destroy()` too, for whatever it can still reach (a
 *   dispatcher with no tracked open stream at all, or a future undici
 *   version without the limitation above) - harmless either way, never
 *   awaited for its effect.
 *
 * Never rejects: every failure above is swallowed, matching
 * `closeDispatcher`'s existing "never fail the caller" contract. The grace
 * timer is `unref()`d (so it alone can't keep the process alive) and
 * cleared as soon as `close()` wins the race, so a clean shutdown is never
 * delayed by it and it never outlives this call.
 */
function closeDispatcherWithGrace(
  dispatcher: Dispatcher,
  openStreamAborts: Set<RequestAbortSignal> | undefined,
): Promise<void> {
  const closed = Promise.resolve(dispatcher.close()).then(
    () => undefined,
    () => undefined,
  );
  return new Promise<void>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (openStreamAborts) {
        for (const abortSignal of openStreamAborts) {
          abortSignal.abort(new ShutdownGraceAbortReason());
        }
      }
      Promise.resolve(dispatcher.destroy())
        .catch(() => undefined)
        .finally(resolve);
    }, shutdownGraceMs());
    timer.unref?.();
    void closed.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * `abortSignal.abort()`'s reason when `closeDispatcherWithGrace`'s grace
 * period forces an abandoned `responseType: 'stream'` body closed. A
 * distinct class (rather than a plain string/Error) only so anything that
 * inspects `error.cause`/a caught error can tell this apart from a real
 * network failure if it ever needs to - nothing in this library currently
 * reads it back (unlike `DeadlineTimeoutReason`/`isDeadlineTimeoutReason`,
 * which `fail()` does branch on): by the time this fires, the stream has
 * already been handed to the caller and the request Observable has long
 * since settled, so there's no `AxiosError` left to shape - the caller's
 * own stream just sees an aborted read, exactly as if they had called
 * `.destroy()` on it themselves.
 */
class ShutdownGraceAbortReason extends Error {
  constructor() {
    super('HttpService.onModuleDestroy: shutdown grace period elapsed');
    this.name = 'ShutdownGraceAbortReason';
  }
}

class RequestAbortSignal {
  aborted = false;
  reason: unknown = undefined;
  // One slot covers the common case (undici's own listener); the array is
  // only allocated when a second listener registers (the maxRate/progress
  // path), so ordinary requests pay no extra allocation.
  private listener: (() => void) | undefined;
  private extraListeners: Array<() => void> | undefined;

  addEventListener(_type: 'abort', listener: () => void): void {
    if (this.listener === undefined) this.listener = listener;
    else (this.extraListeners ??= []).push(listener);
  }

  removeEventListener(_type: 'abort', listener: () => void): void {
    if (this.listener === listener) {
      this.listener = undefined;
      return;
    }
    const extra = this.extraListeners;
    if (extra === undefined) return;
    const i = extra.indexOf(listener);
    if (i !== -1) extra.splice(i, 1);
  }

  abort(reason?: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    const listener = this.listener;
    const extra = this.extraListeners;
    this.listener = undefined;
    this.extraListeners = undefined;
    listener?.();
    if (extra !== undefined) for (const l of extra) l();
  }
}

/**
 * Axios-only `HttpModuleOptions` keys (plus the internal `__`-prefixed ones
 * `axios-config.adapter.ts` stashes resolved transport pieces under) that
 * exist only to build a dispatcher/transport at setup time
 * (`setupDispatcher`) and must never reach undici's own per-request dispatch
 * options - see plan.md phase 3 "Option mapping"/`plan/reports/
 * package-quality.md` ("Module config leaks into undici's `dispatch()`
 * options: raw `auth` (credentials), `proxy`, `baseURL`, `timeout` and
 * `__axiosCompat`"). Stripped once, in the constructor, into
 * `dispatchBaseOptions` - never filtered per request.
 */
const AXIOS_ONLY_DISPATCH_KEYS = [
  'auth',
  'httpAgent',
  'httpsAgent',
  'proxy',
  'httpVersion',
  'http2Options',
  'cookieJar',
  'withCredentials',
  'xsrfCookieName',
  'xsrfHeaderName',
  '__resolvedConfig',
] as const;

/** Protocols this library (like axios) can actually dispatch. */
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * True when `url` starts with `http://` or `https://`, checked
 * case-insensitively (axios itself always lowercases the protocol) via
 * `charCodeAt` rather than a regex or a `.slice().toLowerCase()` - no
 * substring/array allocation, just a handful of integer comparisons. This is
 * the overwhelming majority of requests, so `unsupportedProtocol` below
 * checks it first and skips the regex entirely once it matches.
 */
function isHttpOrHttpsPrefix(url: string): boolean {
  // 'h'/'H'
  if ((url.charCodeAt(0) | 0x20) !== 0x68) return false;
  // 't'/'T', 't'/'T', 'p'/'P'
  if (
    (url.charCodeAt(1) | 0x20) !== 0x74 ||
    (url.charCodeAt(2) | 0x20) !== 0x74 ||
    (url.charCodeAt(3) | 0x20) !== 0x70
  ) {
    return false;
  }
  const c4 = url.charCodeAt(4);
  if (c4 === 0x3a /* ':' */) {
    return url.charCodeAt(5) === 0x2f && url.charCodeAt(6) === 0x2f; // '//'
  }
  if ((c4 | 0x20) === 0x73 /* 's'/'S' */) {
    return (
      url.charCodeAt(5) === 0x3a &&
      url.charCodeAt(6) === 0x2f &&
      url.charCodeAt(7) === 0x2f
    );
  }
  return false;
}

/**
 * The URL's protocol, when it names one this library can't dispatch (e.g.
 * `tel:`, `ftp:`) - `undefined` for a supported protocol *or* a relative
 * URL/path (no scheme at all; resolved fine against a dispatcher's base).
 * Checked before ever calling undici's `request()`, which throws its own
 * (undici-flavoured, synchronous) error for the same input - axios instead
 * rejects with a proper `Unsupported protocol ${protocol}` `AxiosError`
 * (`createUnsupportedProtocolError`), checked against real axios 1.20.
 */
function unsupportedProtocol(
  url: string | URL | UrlObject,
): string | undefined {
  let protocol: string | undefined;
  if (url instanceof URL) {
    protocol = url.protocol;
  } else if (typeof url === 'string') {
    // Fast path: skip the regex entirely for a plain http(s) URL (see
    // `isHttpOrHttpsPrefix`).
    if (isHttpOrHttpsPrefix(url)) return undefined;
    // Cheap prefix check first: only a request whose URL *looks* absolute
    // (`<scheme>:...`) pays for anything more.
    const match = /^([a-z][a-z\d+\-.]*):/i.exec(url);
    if (match) protocol = match[1].toLowerCase() + ':';
  } else if (url && typeof url === 'object') {
    protocol = (url as UrlObject).protocol ?? undefined;
  }
  return protocol !== undefined && !SUPPORTED_PROTOCOLS.has(protocol)
    ? protocol
    : undefined;
}

/** axios' `buildFullPath.js`: an `http(s):` URL missing the `//` after its
 * protocol, once its own leading-whitespace/embedded-control-character
 * normalisation is applied (`normalizeURLForProtocolCheck`) - e.g. an
 * embedded null byte (`'\u0000https:example.com'`) or a bare `\n`
 * (`'h\nttp:example.com'`). undici (like Node's own `new URL()`, which is
 * WHATWG-forgiving about a missing `//` for a special scheme) silently
 * "fixes" and dispatches these instead of rejecting them, unlike axios -
 * checked against real axios 1.20's own "rejects malformed HTTP URLs before
 * Node URL normalization and preserves config" test.
 */
const MALFORMED_HTTP_PROTOCOL_RE = /^https?:(?!\/\/)/i;
// eslint-disable-next-line no-control-regex -- intentionally targets C0 controls/space, matching axios' own `normalizeURLForProtocolCheck`.
const LEADING_C0_OR_SPACE_RE = /^[\x00-\x20]+/;
const EMBEDDED_TAB_NEWLINE_CR_RE = /[\t\n\r]/g;

/**
 * Returns axios' own normalised form of `url` (`Invalid URL "..."` quotes
 * this, not the original string) when it's a malformed `http(s):` URL,
 * `undefined` otherwise. Guarded by `isHttpOrHttpsPrefix` first - the same
 * fast, allocation-free prefix check `unsupportedProtocol` above already
 * uses - so a clean `http://`/`https://` URL (the overwhelming majority)
 * never reaches the two `.replace()` calls or the regex test below.
 */
function malformedHttpProtocolUrl(url: string): string | undefined {
  if (isHttpOrHttpsPrefix(url)) return undefined;
  const normalized = url
    .replace(LEADING_C0_OR_SPACE_RE, '')
    .replace(EMBEDDED_TAB_NEWLINE_CR_RE, '');
  return MALFORMED_HTTP_PROTOCOL_RE.test(normalized) ? normalized : undefined;
}

/**
 * Enforces `maxBodyLength` on the *request* body, matching axios' own
 * precedence and codes (checked against real axios 1.20 and its default
 * `follow-redirects` transport):
 * - a string/Buffer body (known length upfront) is checked synchronously,
 *   before ever dispatching - `ERR_BAD_REQUEST`, "Request body larger than
 *   maxBodyLength limit".
 * - a stream body is checked as bytes are written, matching axios' default
 *   (redirects-following) transport - `ERR_FR_MAX_BODY_LENGTH_EXCEEDED`,
 *   same message. Only wraps the stream when a limit is actually set.
 *
 * Returns the (possibly wrapped) body to send, or a ready-to-throw `error`
 * when a known-length body already exceeds the limit (nothing is sent).
 */
function enforceMaxBodyLength(
  body: unknown,
  maxBodyLength: number | undefined,
): { body: unknown; error?: any } {
  if (maxBodyLength === undefined || maxBodyLength < 0) return { body };
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    const size =
      typeof body === 'string' ? Buffer.byteLength(body) : body.length;
    if (size > maxBodyLength) {
      const error: any = new Error(
        'Request body larger than maxBodyLength limit',
      );
      error.code = 'ERR_BAD_REQUEST';
      return { body, error };
    }
    return { body };
  }
  if (body && typeof (body as any).pipe === 'function') {
    let total = 0;
    const counted = new Transform({
      transform(chunk, _encoding, callback) {
        total += chunk.length;
        if (total > maxBodyLength) {
          const error: any = new Error(
            'Request body larger than maxBodyLength limit',
          );
          error.code = 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED';
          callback(error);
          return;
        }
        callback(null, chunk);
      },
    });
    (body as NodeJS.ReadableStream).on('error', error =>
      counted.destroy(error),
    );
    return { body: (body as NodeJS.ReadableStream).pipe(counted) };
  }
  return { body };
}

@Injectable()
export class HttpService implements OnModuleDestroy {
  private interceptors: Array<HttpInterceptor | HttpInterceptorFunction> = [];
  private _axiosRef: AxiosRef;
  private customDispatcher?: Dispatcher;
  // Per-service default `Agent`, built from this package's own undici copy
  // (plan.md phase 3 "Default dispatcher" / "Duplicate undici copy"):
  // created once here, used whenever no per-request `dispatcher`/
  // `socketPath` and no module `dispatcher`/module-built dispatcher apply -
  // see `executeRequest`'s dispatcher resolution. This replaces falling back
  // to undici's global dispatcher (`getGlobalDispatcher()`), which is what
  // let two copies of undici - this one and, on Node 22, the one bundled
  // with Node itself - end up owning separate connection pools, and let
  // `undici.setGlobalDispatcher()` affect requests this service never
  // configured a dispatcher for. **Breaking**: `setGlobalDispatcher()` from
  // undici no longer affects this service's requests at all; use
  // `HttpService#setDispatcher()` instead.
  //
  // `allowH2: false` unconditionally is correct here (not just the default):
  // whenever `httpVersion: 2` is configured, `setupDispatcher` already builds
  // a `customDispatcher` with `allowH2: true`, which always wins over this
  // one in the precedence order - so this default only ever serves the
  // plain, no-transport-options case, where axios (and this library) never
  // negotiates HTTP/2.
  private readonly defaultDispatcher: Dispatcher;
  // `socketPath` (module- or request-level) dispatchers, cached per path so
  // a request-level `socketPath` (checked on every request, see
  // `executeRequest`) never builds a new `Agent` once one exists for that
  // path.
  private socketPathDispatchers?: Map<string, Dispatcher>;
  // The undici request/dispatch options this service starts every request
  // from (`dispatchFastPath`'s `mergedOptions`): `instanceOptions` (the
  // module's resolved options) with the axios-only keys stripped - see
  // `AXIOS_ONLY_DISPATCH_KEYS`. Built once here, in the constructor, never
  // recomputed per request (plan.md phase 3 "Option mapping": "strip
  // axios-only keys before calling undici"). Typed the same as
  // `instanceOptions` (rather than a plain `Record<string, unknown>`) so it
  // spreads into `mergedOptions` exactly as `instanceOptions` used to -
  // deleting the axios-only keys is a runtime-only concern; none of them are
  // read back off this object anyway.
  private readonly dispatchBaseOptions: UndiciRequestOptionsType;
  // Guards against closing the same dispatcher twice (`onModuleDestroy`,
  // `setDispatcher` replacing a dispatcher it created) - `undici`'s
  // `Dispatcher#close()` is safe to call more than once, but this avoids
  // relying on that and keeps `Promise.allSettled` results in
  // `onModuleDestroy` free of the same object's rejection twice.
  private readonly closedDispatchers = new WeakSet<Dispatcher>();
  // Tracks every currently-open, un-drained `responseType: 'stream'` body
  // this service handed back, keyed by the dispatcher it was actually
  // dispatched through - populated by `trackOpenStream` (called from
  // `executeRequest`'s `onResponse`), and only ever read by
  // `closeDispatcher`/`closeDispatcherWithGrace` to force-abort what's left
  // once an owned dispatcher's shutdown grace period elapses (see that
  // function's doc comment for *why* this is needed - `Agent#destroy()`
  // alone, called after `Agent#close()`, can't reach it). A `Map`, not a
  // `WeakMap`: entries are removed explicitly (by `trackOpenStream`'s own
  // `'close'` listener) once each stream finishes, not left for GC - so
  // this never grows unbounded, and each entry holds only the streams
  // genuinely still open on that dispatcher. Populated the same way
  // regardless of which dispatcher a request resolves to, including a
  // user-supplied one - simpler than checking ownership on every stream
  // response, and harmless: `closeDispatcher` (the only reader) is never
  // called for a dispatcher the caller supplied, so that entry is simply
  // never looked at, and its own `'close'` listener still cleans it up
  // exactly the same either way.
  private readonly openStreamAbortsByDispatcher = new Map<
    Dispatcher,
    Set<RequestAbortSignal>
  >();
  // Perf item 2: `createInterceptorHandler` builds a linked list of one
  // handler object per interceptor; that chain never changes shape between
  // requests unless `this.interceptors` itself is replaced or grown, so it's
  // built once and reused until `interceptorsVersion` says otherwise (bumped
  // by `addInterceptor`/`setInterceptors`, module-registered interceptors
  // only - axiosRef's own request/response interceptors run through
  // `runAxiosPipeline` instead, over `axiosRequestInterceptors`/
  // `axiosResponseInterceptors` directly, so they need no such cache).
  private interceptorsVersion = 0;
  private cachedInterceptorHandler?: HttpInterceptorHandler;
  private cachedInterceptorHandlerVersion = -1;
  // axiosRef's own request/response interceptors (registered through
  // `axiosRef.interceptors.request/response.use()`). Unlike `this.interceptors`
  // above, these run over the single axios-shaped config object built by
  // `buildAxiosConfig`/`serializeAxiosConfig`, in axios' own order - see
  // `runAxiosPipeline`.
  private readonly axiosRequestInterceptors =
    createInterceptorStore<InternalAxiosLikeRequestConfig>();
  private readonly axiosResponseInterceptors =
    createInterceptorStore<AxiosLikeResponse>();
  // The context `request()` dispatches with by default: this service's own
  // `defaults`/interceptors (the same objects `this._axiosRef` exposes).
  // `axiosRef.create()`-derived instances dispatch through
  // `dispatch()` with their own context instead - see
  // `axios-ref.factory.ts`.
  private readonly axiosContext: AxiosInstanceContext;

  public constructor(
    // Typed with the plain, public `UndiciRequestOptionsType`/`HttpModuleOptions`
    // (not the internal `Resolved*` variants that also carry `__resolvedConfig`
    // - see `internal/resolved-config.ts`): both are constructor parameter
    // properties, so their declared type is part of this public class'
    // emitted `.d.ts` regardless of `protected`/`private` (api-extractor's
    // `ae-forgotten-export` catches exactly this - an internal-only type
    // reachable from a public signature). `setupDispatcher`/
    // `shouldUseEnvProxyAgent`/`undiciRef` each cast to the internal type
    // locally, at the one point they actually read `__resolvedConfig`.
    @Inject(UNDICI_INSTANCE_TOKEN)
    protected readonly instanceOptions: UndiciRequestOptionsType,
    @Optional()
    @Inject(HTTP_MODULE_OPTIONS)
    private readonly moduleOptions?: HttpModuleOptions,
    // Only `HttpModule.register()`/`.registerAsync()` pass this (as a plain
    // constructor argument, not through Nest DI - `@Optional()` here is only
    // so the bare, non-dynamic `HttpModule` import (no `.register()` call,
    // `HttpService` built by Nest's own DI instead) doesn't fail trying to
    // resolve a provider for it): the fully resolved interceptor list
    // (function, instance and DI-resolved class interceptors merged - see
    // `http.module.ts`). Keeping this a constructor-only parameter, instead
    // of the public `setInterceptors()` method the module used to call right
    // after `new HttpService(...)`, is what lets that method become internal
    // (plan.md phase 3 "HttpService members"): nothing outside this class
    // needs to call it any more.
    @Optional()
    resolvedInterceptors?: Array<HttpInterceptor | HttpInterceptorFunction>,
  ) {
    // Initialize interceptors from module options if available
    if (resolvedInterceptors) {
      this.setInterceptors(resolvedInterceptors);
    } else if (this.moduleOptions?.interceptors) {
      // For now, we'll only handle function interceptors in the constructor
      // Class-based interceptors need to be resolved by the DI container
      this.interceptors = this.moduleOptions.interceptors
        .filter(interceptor => typeof interceptor === 'function')
        .map(interceptor => interceptor as HttpInterceptorFunction);
    }

    // Initialize axios-compatible axiosRef (interceptors, defaults, promise
    // methods). `HttpModule.register()`/`.registerAsync()` options seed
    // `defaults` once here, exactly like `axios.create(moduleOptions)` -
    // from then on `defaults` is the single source of truth (see
    // `createAxiosRefDefaults`'s doc comment).
    const defaults = createAxiosRefDefaults(this.moduleOptions);
    // The host is a closure over the private `dispatch()`, not `this`, so
    // the bridge (and its internal context types) stays off the public API.
    this._axiosRef = createAxiosRef(
      {
        dispatchAxiosConfig: (config, context) =>
          this.dispatch(config, undefined, context),
      },
      defaults,
      this.axiosRequestInterceptors,
      this.axiosResponseInterceptors,
    );
    this.axiosContext = {
      defaults,
      requestInterceptors: this.axiosRequestInterceptors,
      responseInterceptors: this.axiosResponseInterceptors,
    };

    // Setup custom dispatcher based on axios compatibility options
    this.setupDispatcher();

    // Per-service default Agent (see the field's doc comment) - built from
    // this package's own undici copy, once, here; never on the request path.
    this.defaultDispatcher = new UndiciAgent({ allowH2: false });

    const dispatchBaseOptions: Record<string, unknown> = {
      ...this.instanceOptions,
    };
    for (const key of AXIOS_ONLY_DISPATCH_KEYS) {
      delete dispatchBaseOptions[key];
    }
    this.dispatchBaseOptions = dispatchBaseOptions as UndiciRequestOptionsType;
  }

  /**
   * Builds `this.customDispatcher` from the axios-style transport options
   * resolved at module setup (`axios-config.adapter.ts`), and only those:
   * TLS/keep-alive/maxSockets from `httpAgent`/`httpsAgent`, `socketPath`,
   * an explicit `proxy`, the `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
   * environment variables (axios reads them when `proxy` is unset; `proxy:
   * false` opts out, like axios), `httpVersion: 2`, and a `cookieJar` (not an
   * axios option - see below). Runs once, in the constructor - never on the
   * request path.
   *
   * Precedence: a `dispatcher` passed directly in module options always
   * wins and is left untouched - none of the branches below run.
   */
  private setupDispatcher(): void {
    // `mapAxiosConfigToUndici` (axios-config.adapter.ts) stashes the
    // resolved agent/proxy pieces under `__resolvedConfig` on the same
    // object `HTTP_MODULE_OPTIONS` provides - a typed cast, not `as any`,
    // right where this internal field is actually read (see the
    // constructor's doc comment on why the field itself stays typed with
    // the plain, public `HttpModuleOptions`).
    const options = this.moduleOptions as ResolvedHttpModuleOptions | undefined;
    if (!options) return;
    if (this.instanceOptions.dispatcher) return;

    let baseDispatcher: Dispatcher | undefined;

    // Pool and TLS settings from `httpAgent`/`httpsAgent`/`httpVersion`
    // apply whichever dispatcher is built below: through a proxy, the TLS
    // options go to the target (`requestTls`), as axios forwards an
    // `httpsAgent`'s TLS options through its proxy tunnel.
    const resolvedConfig = options.__resolvedConfig;
    const agentOptions = resolvedConfig?.agentOptions ?? {};
    const tls = agentOptions.tls;
    const hasTls = !!tls && Object.keys(tls).length > 0;
    const poolOptions: Record<string, unknown> = {
      pipelining: agentOptions.pipelining ?? options.pipelining ?? 1,
    };
    if (agentOptions.connections !== undefined) {
      poolOptions.connections = agentOptions.connections;
    }
    // Explicit either way: undici 8 negotiates HTTP/2 by default, undici 7
    // doesn't. axios only uses HTTP/2 with `httpVersion: 2`.
    poolOptions.allowH2 = !!agentOptions.allowH2;

    const proxyAgent = resolvedConfig?.proxyAgent;
    if (proxyAgent) {
      // Explicit `proxy: {...}` - highest priority among the auto-built
      // dispatchers. `proxyTunnel: false` matches axios: a plain HTTP
      // target is forwarded to the proxy in absolute form (`GET
      // http://host/path HTTP/1.1`), not CONNECT-tunnelled - undici's
      // default for every target. An HTTPS target still gets a real
      // CONNECT tunnel either way (this flag only affects http-to-http).
      baseDispatcher = new ProxyAgent({
        ...poolOptions,
        ...proxyAgent,
        proxyTunnel: false,
        ...(hasTls ? { requestTls: tls } : {}),
      });
    } else if (this.shouldUseEnvProxyAgent(options)) {
      // No explicit dispatcher/proxy/socketPath configured, and at least
      // one of HTTP_PROXY/HTTPS_PROXY (case-insensitive) is set - read once
      // here, matching axios' own default (`proxy-from-env`), which also
      // applies alongside a custom `httpAgent`/`httpsAgent`.
      // `EnvHttpProxyAgent` itself re-reads `NO_PROXY` per request origin;
      // `connect` covers targets it reaches directly, `requestTls` ones it
      // reaches through the proxy.
      baseDispatcher = new EnvHttpProxyAgent({
        ...poolOptions,
        proxyTunnel: false,
        ...(hasTls ? { connect: tls, requestTls: tls } : {}),
      } as any);
    } else if (options.socketPath || resolvedConfig?.agentOptions) {
      const connect: Record<string, unknown> = { ...tls };
      if (options.socketPath) connect.socketPath = options.socketPath;

      baseDispatcher = new UndiciAgent({
        ...poolOptions,
        ...(Object.keys(connect).length > 0 ? { connect } : {}),
      });
    }

    // Cookie support: opt-in only, through an explicit `cookieJar` (a
    // `tough-cookie` `CookieJar` instance). `withCredentials` is accepted
    // (kept in the types for axios compatibility) but is otherwise a no-op -
    // matching axios itself, which ignores it on Node.js - so it's not read
    // here at all any more (plan.md phase 2: "breaking: `withCredentials`
    // becomes a no-op; add cookieJar"). Only an instance is accepted, never
    // `true`: a shorthand that builds one jar per service would be exactly
    // the shared-jar-leaks-cookies-between-users problem this change fixes,
    // just with a different trigger, so the caller must own the jar (and
    // its scope - process-wide, per-request, per-user, ...) explicitly.
    // There's also no per-request `cookieJar`: wiring one up means building
    // a `CookieAgent` (wrapping `baseDispatcher`) for it, which only happens
    // once here, in the constructor - never on the request path.
    if (options.cookieJar) {
      const jar: any = options.cookieJar;
      if (
        typeof jar.setCookie !== 'function' ||
        typeof jar.getCookieString !== 'function'
      ) {
        throw new TypeError(
          'cookieJar must be a tough-cookie CookieJar instance (e.g. `new CookieJar()` from tough-cookie)',
        );
      }
      const CookieAgent = loadCookieAgent();
      const cookieAgentOptions: any = {
        cookies: { jar: options.cookieJar },
      };

      // If we have a base dispatcher (proxy or custom agent), wrap it
      if (baseDispatcher) {
        cookieAgentOptions.factory = () => baseDispatcher;
      }

      this.customDispatcher = new CookieAgent(cookieAgentOptions);
    } else if (baseDispatcher) {
      this.customDispatcher = baseDispatcher;
    }

    if (this.customDispatcher) {
      // Set as default dispatcher in instance options
      this.instanceOptions.dispatcher = this.customDispatcher;
    }
  }

  /**
   * True when no explicit dispatcher/proxy/agent/socketPath is configured
   * and `HTTP_PROXY`/`HTTP_proxy`/`HTTPS_PROXY`/`https_proxy` says a proxy
   * should be used by default - matching axios' own `proxy-from-env`
   * behaviour. `proxy: false` (as in axios) opts out entirely.
   *
   * This is a behaviour change from earlier versions, which never read
   * these variables: a request to `http://127.0.0.1:...` now goes through
   * whatever `HTTP_PROXY` the process has set unless `NO_PROXY` covers it,
   * `proxy: false` is passed, or a `dispatcher`/`proxy`/`socketPath` is
   * configured - see docs/axios-supported-options.md.
   */
  private shouldUseEnvProxyAgent(options: ResolvedHttpModuleOptions): boolean {
    if (options.proxy === false) return false;
    if (options.proxy || options.__resolvedConfig?.proxyAgent) return false;
    if (options.socketPath) return false;
    const env = process.env;
    return !!(
      env.HTTP_PROXY ||
      env.http_proxy ||
      env.HTTPS_PROXY ||
      env.https_proxy
    );
  }

  /**
   * `Agent({ connect: { socketPath } })`, cached per path so a per-request
   * `socketPath` (checked on every request - see `executeRequest`) never
   * allocates a new `Agent` once one exists for that path. The module's own
   * `socketPath` reuses the module dispatcher. The cache holds at most
   * `MAX_SOCKET_PATH_DISPATCHERS` paths; the oldest is closed (after its
   * in-flight requests finish) to make room, so a dynamic per-request
   * `socketPath` can't leak Agents.
   */
  private getSocketPathDispatcher(socketPath: string): Dispatcher {
    if (
      socketPath === this.moduleOptions?.socketPath &&
      this.customDispatcher
    ) {
      return this.customDispatcher;
    }
    this.socketPathDispatchers ??= new Map();
    let dispatcher = this.socketPathDispatchers.get(socketPath);
    if (!dispatcher) {
      if (this.socketPathDispatchers.size >= MAX_SOCKET_PATH_DISPATCHERS) {
        const [oldestPath, oldest] = this.socketPathDispatchers
          .entries()
          .next().value!;
        this.socketPathDispatchers.delete(oldestPath);
        oldest.close().catch(() => undefined);
      }
      dispatcher = new UndiciAgent({ connect: { socketPath } });
      this.socketPathDispatchers.set(socketPath, dispatcher);
    }
    return dispatcher;
  }

  /**
   * Sets this service's dispatcher - despite the name it never touches
   * undici's own global dispatcher, only this `HttpService` (**breaking**:
   * renamed from `setGlobalDispatcher`, which was equally misleading about
   * *undici's* global dispatcher but is removed outright, no alias - plan.md
   * phase 3 "HttpService members"). Takes precedence over the module's own
   * `dispatcher`/module-built dispatcher and the per-service default
   * (`undiciRef`/`defaultDispatcher`), but not over a per-request
   * `dispatcher`/`socketPath` - see `executeRequest`'s precedence order.
   *
   * If the dispatcher this call replaces is one this service created itself
   * (the module-built dispatcher from `setupDispatcher`, or - when nothing
   * else was configured - the per-service default `Agent`), it is closed
   * (gracefully, not awaited here - `close()` lets in-flight requests
   * finish). A dispatcher passed in by the caller, whether through module
   * options or an earlier `setDispatcher()` call, is never closed by this
   * library - only ones it created itself.
   */
  public setDispatcher(dispatcher: Dispatcher): void {
    const owned = this.ownedActiveDispatcher();
    this.customDispatcher = undefined;
    this.instanceOptions.dispatcher = dispatcher;
    if (owned && owned !== dispatcher) {
      this.closeDispatcher(owned);
    }
  }

  /**
   * The dispatcher currently in effect for this service (ignoring any
   * per-request override) that this service itself created, if any - used
   * by `setDispatcher` to decide what to close when it's replaced, and by
   * `onModuleDestroy` isn't needed separately since it always closes
   * `customDispatcher`/`defaultDispatcher` unconditionally (closing a
   * dispatcher that's no longer "active" but was still created by this
   * service is exactly what `onModuleDestroy` is for).
   */
  private ownedActiveDispatcher(): Dispatcher | undefined {
    if (this.instanceOptions.dispatcher) {
      // Only owned when it's the module-built one; a `dispatcher` passed in
      // module options directly, or set by an earlier `setDispatcher()`
      // call, is the caller's.
      return this.instanceOptions.dispatcher === this.customDispatcher
        ? this.customDispatcher
        : undefined;
    }
    // Nothing configured at all - the per-service default is what's
    // actually serving requests right now.
    return this.defaultDispatcher;
  }

  /** Closes `dispatcher` gracefully, at most once, swallowing any error - a
   * dispatcher this service is discarding is never awaited or allowed to
   * fail the caller (`setDispatcher`, `onModuleDestroy`'s per-dispatcher
   * catch). Bounded by `closeDispatcherWithGrace`'s grace period, so a
   * `close()` that never resolves (an unconsumed `responseType: 'stream'`
   * response keeps the dispatcher open) doesn't wait forever either -
   * falls back to `destroy()` instead. */
  private closeDispatcher(dispatcher: Dispatcher): Promise<void> {
    if (this.closedDispatchers.has(dispatcher)) return Promise.resolve();
    this.closedDispatchers.add(dispatcher);
    return closeDispatcherWithGrace(
      dispatcher,
      this.openStreamAbortsByDispatcher.get(dispatcher),
    );
  }

  /**
   * Registers `abortSignal` (`executeRequest`'s per-request
   * `RequestAbortSignal`, already wired as undici's own dispatch-level
   * `signal` option) against `dispatcher` for as long as `stream` (the
   * `responseType: 'stream'` body just handed back to the caller) stays
   * open - removed the instant it closes, however that happens (fully
   * read, `.destroy()`d, or errored - Node's `Readable` emits `'close'` in
   * every case). Only `closeDispatcher`'s shutdown-grace fallback
   * (`closeDispatcherWithGrace`) ever reads this back; see its doc comment
   * for why aborting the request's own signal, not the dispatcher's own
   * `destroy()`, is what actually frees an abandoned stream's connection.
   */
  private trackOpenStream(
    dispatcher: Dispatcher,
    abortSignal: RequestAbortSignal,
    stream: Readable,
  ): void {
    let aborts = this.openStreamAbortsByDispatcher.get(dispatcher);
    if (!aborts) {
      aborts = new Set();
      this.openStreamAbortsByDispatcher.set(dispatcher, aborts);
    }
    aborts.add(abortSignal);
    stream.once('close', () => {
      aborts!.delete(abortSignal);
    });
  }

  /**
   * Closes every dispatcher this service created - the per-service default
   * `Agent`, the module-built dispatcher (`Agent`/`ProxyAgent`/
   * `EnvHttpProxyAgent`/`CookieAgent`, whichever `setupDispatcher` built),
   * and every cached `socketPath` `Agent` - gracefully (`close()`, which lets
   * in-flight requests finish rather than aborting them, unlike
   * `destroy()`), all concurrently (so N cached `socketPath` Agents don't
   * add up to N times the grace period below - see `Promise.all`). A
   * `dispatcher` the caller supplied directly, through module options or
   * `setDispatcher()`, is never touched here (plan.md phase 3 "Resource
   * cleanup").
   *
   * Each `close()` is bounded by a grace period (`closeDispatcherWithGrace`/
   * `DEFAULT_SHUTDOWN_GRACE_MS`): past it, `destroy()` takes over and aborts
   * whatever is left, so an abandoned, never-consumed `responseType:
   * 'stream'` response can no longer keep this method - and application
   * shutdown - waiting forever (plan.md phase 2, "decide:
   * `HttpService.onModuleDestroy` waits forever...").
   */
  public async onModuleDestroy(): Promise<void> {
    const closing: Promise<void>[] = [
      this.closeDispatcher(this.defaultDispatcher),
    ];
    if (this.customDispatcher) {
      closing.push(this.closeDispatcher(this.customDispatcher));
    }
    if (this.socketPathDispatchers) {
      for (const dispatcher of this.socketPathDispatchers.values()) {
        closing.push(this.closeDispatcher(dispatcher));
      }
      this.socketPathDispatchers.clear();
    }
    await Promise.all(closing);
  }

  /**
   * Axios-style call form, as in `@nestjs/axios`: `request({ url, method, data, params, ... })`
   */
  public request<T = any, D = any>(
    config: AxiosLikeRequestConfig<D>,
  ): Observable<AxiosLikeResponse<T, D>>;
  public request<T = any, D = any>(
    url: string | URL | UrlObject,
    options?: AxiosLikeRequestConfig<D>,
  ): Observable<AxiosLikeResponse<T, D>>;
  public request<T = any, D = any>(
    urlOrConfig: string | URL | UrlObject | AxiosLikeRequestConfig<D>,
    requestOptions?: AxiosLikeRequestConfig<D>,
  ): Observable<AxiosLikeResponse<T, D>> {
    return this.dispatch<T, D>(urlOrConfig, requestOptions, this.axiosContext);
  }

  /**
   * Shared implementation behind `request()` and every axios-like instance
   * built by `createAxiosRef` (the top-level `axiosRef` and each
   * `axiosRef.create()` child), which pass their own `context`.
   * `defer()` makes the Observable cold and re-runs everything below (config
   * normalization, the axiosRef request interceptors, the actual request)
   * on every subscription, as `@nestjs/axios`' `makeObservable` does. This
   * matters for `get().pipe(retry())`: each attempt must build its own
   * headers/config rather than reusing the first attempt's.
   *
   * plan.md phase 2 "fix: remaining error-shape gaps", item 3 ("HTTP and
   * interceptor errors should keep the call-site stack, as axios does"):
   * tried and reverted a literal port of axios' own mechanism (`Axios
   * .prototype.request`'s `catch` block re-captures a fresh stack and
   * appends it - `lib/core/Axios.js`). Two things make it a bad fit here:
   * (1) axios' *entire* request path, start to finish, is a real, native
   * `await`/`.then()` chain, so a stack captured inside that `catch` already
   * reaches the original application call site for free, via V8's async
   * stack traces; this library's request path is an RxJS `Observable`
   * instead, whose `next`/`error`/`complete` notifications are delivered
   * through plain synchronous callbacks - confirmed with a minimal repro
   * (an `Observable` wrapping a promise, subscribed via `firstValueFrom`)
   * that V8 does *not* bridge an error notification back to wherever
   * `.subscribe()`/`firstValueFrom()` was itself called the way it does for
   * a plain `await` chain, so the same technique here would reach only this
   * library's own internals, never the caller - much less benefit than in
   * axios. (2) `Error.captureStackTrace`'s cost is real and dominated by
   * *walking* the actual (deep, RxJS + undici promise-chain) execution
   * stack, not by how many frames are ultimately formatted - measured
   * (`benchmarks/micro/compare.js --scenarios error`, a 100%-failure
   * workload, so every request pays this cost): even capped at
   * `Error.stackTraceLimit = 1`, it still added 40%+ CPU/req, far past the
   * 10% budget, for the much smaller benefit above. Given that, this
   * library's *existing* behaviour already covers the item's intent at zero
   * extra cost: an interceptor's own thrown error is never wrapped at all
   * (`toAxiosError`'s final, unconditional "anything else passes through"
   * branch), so it keeps the stack from wherever the *caller's own code*
   * threw it; every HTTP-originated error is built via `new AxiosError(...)`/
   * `AxiosError.from(...)` (`createStatusError`, `createTimeoutError`,
   * `toAxiosError`, ...), and a freshly-constructed `Error` already carries
   * a stack from its own construction site for free (an unavoidable,
   * pre-existing cost of building any error at all, not one this fix would
   * add) - showing where in this library's own error handling it was built,
   * which is the same depth of information the reverted mechanism would
   * have added, without an extra `Error.captureStackTrace` call.
   */
  private dispatch<T = any, D = any>(
    urlOrConfig: string | URL | UrlObject | AxiosLikeRequestConfig<D>,
    requestOptions: AxiosLikeRequestConfig<D> | undefined,
    context: AxiosInstanceContext,
  ): Observable<AxiosLikeResponse<T, D>> {
    return defer(() => {
      if (!this.hasAxiosPipeline(urlOrConfig, requestOptions, context)) {
        return this.dispatchFastPath<T>(urlOrConfig, requestOptions, context);
      }
      // axiosRef request/response interceptors (or a transformRequest/
      // transformResponse/adapter) are in play: build the single
      // axios-shaped config object up front and run it through the axios
      // pipeline, instead of the undici-options fast path below.
      const config = buildAxiosConfig(urlOrConfig, requestOptions, {
        defaults: context.defaults,
        instanceOptions: this.instanceOptions,
      });
      return this.runAxiosPipeline<T>(config, context);
    });
  }

  /**
   * True when this request needs the axiosRef pipeline (`runAxiosPipeline`):
   * a live axiosRef request/response interceptor, a function `adapter`
   * (module-, defaults- or request-level), or a `transformRequest`/
   * `transformResponse` (module-, defaults- or request-level). A plain
   * request with none of these keeps the fast path below, which never builds
   * a full axios config object.
   */
  private hasAxiosPipeline(
    urlOrConfig: string | URL | UrlObject | AxiosLikeRequestConfig,
    requestOptions: AxiosLikeRequestConfig | undefined,
    context: AxiosInstanceContext,
  ): boolean {
    if (
      context.requestInterceptors.entries.some(Boolean) ||
      context.responseInterceptors.entries.some(Boolean)
    ) {
      return true;
    }
    const defaults = context.defaults;
    const moduleOpts = this.moduleOptions as any;
    if (
      moduleOpts?.transformRequest ||
      moduleOpts?.transformResponse ||
      defaults.transformRequest ||
      defaults.transformResponse
    ) {
      return true;
    }
    const configForm: any = isAxiosRequestConfig(urlOrConfig)
      ? urlOrConfig
      : undefined;
    const opts: any = requestOptions;
    if (
      configForm?.transformRequest ||
      configForm?.transformResponse ||
      opts?.transformRequest ||
      opts?.transformResponse
    ) {
      return true;
    }
    return !!resolveFunctionAdapter(
      configForm?.adapter ?? opts?.adapter ?? defaults.adapter,
    );
  }

  /**
   * The axiosRef pipeline: run the axios-shaped config through the request
   * interceptors (LIFO), dispatch it (through a function `adapter` when one
   * is configured, otherwise undici), then the response interceptors (FIFO) -
   * see `chainStep`/`activeAxiosInterceptors`. Any module-registered generic
   * interceptor (`this.interceptors`, e.g. size limits) still runs around the
   * actual undici dispatch, via `executeInterceptorChain`.
   */
  private runAxiosPipeline<T = any>(
    config: InternalAxiosLikeRequestConfig,
    context: AxiosInstanceContext,
  ): Observable<AxiosLikeResponse<T>> {
    const requestChain = activeAxiosInterceptors(
      context.requestInterceptors.entries,
      true,
      config,
    );
    const responseChain = activeAxiosInterceptors(
      context.responseInterceptors.entries,
      false,
    );

    let config$: Observable<InternalAxiosLikeRequestConfig> = of(config);
    for (const entry of requestChain) {
      config$ = chainStep(config$, entry.fulfilled, entry.rejected);
    }

    let response$: Observable<AxiosLikeResponse> = config$.pipe(
      mergeMap(finalConfig => {
        const adapterFn = resolveFunctionAdapter(finalConfig.adapter);
        return adapterFn
          ? this.executeAdapter(adapterFn, finalConfig)
          : this.executeInterceptorChain(serializeAxiosConfig(finalConfig));
      }),
    );
    for (const entry of responseChain) {
      response$ = chainStep(response$, entry.fulfilled, entry.rejected);
    }
    return response$ as Observable<AxiosLikeResponse<T>>;
  }

  /**
   * Dispatches through a function `adapter` instead of undici - this is what
   * makes `axios-mock-adapter` work. `serializeAxiosConfig` prepares `config`
   * exactly like it would for a real dispatch (headers as `AxiosHeaders`,
   * `baseURL`/`params` combined into `url`, `data` run through
   * `transformRequest`, the POST/PUT/PATCH default Content-Type) and is
   * reused here for that prep only - its undici-shaped `{ url, options }`
   * result is discarded; the adapter gets `config` itself, as axios' own
   * `dispatchRequest` does. The resolved response still runs through
   * `validateStatus`, `transformResponse` and (back in `runAxiosPipeline`)
   * any response interceptors, exactly like a real network response.
   */
  private executeAdapter<T = any>(
    adapterFn: (
      config: InternalAxiosLikeRequestConfig,
    ) => Promise<AxiosLikeResponse<T>>,
    config: InternalAxiosLikeRequestConfig,
  ): Observable<AxiosLikeResponse<T>> {
    serializeAxiosConfig(config);
    return new Observable<AxiosLikeResponse<T>>(subscriber => {
      let settled = false;
      Promise.resolve()
        .then(() => adapterFn(config))
        .then(
          rawResponse => {
            if (settled) return;
            settled = true;
            const status = rawResponse?.status ?? 200;
            const statusText =
              rawResponse?.statusText || STATUS_TEXT_MAP[status] || 'Unknown';
            const rawHeaders = rawResponse?.headers;
            const headers =
              rawHeaders && typeof (rawHeaders as any).toJSON === 'function'
                ? (rawHeaders as any).toJSON()
                : (rawHeaders ?? {});
            let data = rawResponse?.data;
            if (config.transformResponse) {
              const transforms = Array.isArray(config.transformResponse)
                ? config.transformResponse
                : [config.transformResponse];
              data = transforms.reduce(
                (value: any, fn: any) =>
                  fn.call(config, value, headers, status),
                data,
              );
            }
            const response: AxiosLikeResponse<T> = {
              data,
              status,
              statusText,
              headers,
              config,
              request: rawResponse?.request ?? {},
            };
            // `validateStatus: null` (axios: always resolves) vs. simply
            // unset (the default 2xx range) - see `toAxiosLikeResponse`.
            const isValidStatus =
              typeof config.validateStatus === 'function'
                ? config.validateStatus(status)
                : config.validateStatus === null
                  ? true
                  : status >= 200 && status < 300;
            if (!isValidStatus) {
              subscriber.error(createStatusError(response));
              return;
            }
            subscriber.next(response);
            subscriber.complete();
          },
          error => {
            if (settled) return;
            settled = true;
            if (error && typeof error === 'object') {
              if ((error as any).config === undefined) {
                (error as any).config = config;
              }
              if ((error as any).isAxiosError === undefined) {
                (error as any).isAxiosError = true;
              }
            }
            subscriber.error(error);
          },
        );
      return () => {
        settled = true;
      };
    });
  }

  /**
   * The existing fast path (no axiosRef interceptors, no transforms): builds
   * the undici dispatch options directly, without ever materialising a full
   * axios config object. `response.config`/`error.config` are still correct
   * when read - `dispatchFastPath` attaches the cheap fields
   * `normalizeAxiosRequest` already computed so the config can be built
   * lazily (see `attachLazyAxiosConfig`), on first access.
   */
  private dispatchFastPath<T = any>(
    urlOrConfig: string | URL | UrlObject | AxiosLikeRequestConfig,
    requestOptions: AxiosLikeRequestConfig | undefined,
    context: AxiosInstanceContext,
  ): Observable<AxiosLikeResponse<T>> {
    // Apply axios semantics (config form, baseURL, params, data, headers, auth, ...)
    const { url, options, raw } = normalizeAxiosRequest(
      urlOrConfig,
      requestOptions,
      {
        defaults: context.defaults,
        instanceOptions: this.instanceOptions,
      },
    ) as {
      url: string | URL | UrlObject;
      options: Omit<AxiosLikeRequestConfig, 'headers'> &
        Pick<Dispatcher.RequestOptions, 'headers'>;
      raw: { url: any; baseURL?: string; params?: any; method: string };
    };

    // Handle timeout option for axios compatibility
    const { timeout, ...restOptions } = options || {};
    const mergedOptions = {
      // `dispatchBaseOptions`, not `this.instanceOptions` directly: the
      // axios-only keys (`auth`/`httpAgent`/`httpsAgent`/`proxy`/
      // `httpVersion`/`cookieJar`/`withCredentials`/... - see
      // `AXIOS_ONLY_DISPATCH_KEYS`) were already stripped once, at setup.
      ...this.dispatchBaseOptions,
      ...restOptions,
      // Only a per-request `dispatcher` belongs here; the module's own is
      // applied as a fallback in `executeRequest`, after a per-request
      // `socketPath`.
      dispatcher: restOptions.dispatcher,
    };

    // Map timeout to undici's timeout options, and keep the raw ms value
    // too (`normalizeAxiosRequest` already resolved request vs. module
    // precedence) - `executeRequest`'s own deadline timer reads it;
    // `headersTimeout`/`bodyTimeout` stay a backstop against undici's idle
    // timers.
    if (timeout !== undefined) {
      (mergedOptions as any).timeout = timeout;
      mergedOptions.headersTimeout = timeout;
      mergedOptions.bodyTimeout = timeout;
    }
    // `maxContentLength`/`maxBodyLength`/`timeoutErrorMessage`/`transitional`
    // module-vs-request precedence was already resolved by
    // `normalizeAxiosRequest` (per-request wins, as in axios) - see
    // `plan/reports/axios-compat.md`'s "a module-level `maxContentLength`
    // overrides the per-request value" bug. Nothing more to do here.

    // `baseURL` was already applied by `normalizeAxiosRequest` above (it
    // reads `instanceOptions.baseURL` directly); `socketPath` (module- or
    // request-level, already present in `mergedOptions` via the spreads
    // above) is applied to the *dispatcher*, not the URL - see
    // `executeRequest`/`getSocketPathDispatcher`. The request URL's host is
    // only ever used for the `Host` header, matching axios.

    // Create the request object for interceptors
    const interceptorRequest: HttpInterceptorRequest = {
      url,
      options: mergedOptions,
    };
    // Cheap fields for a lazily-built `response.config`/`error.config`
    // (see `attachLazyAxiosConfig`) - no AxiosHeaders wrap, no combined
    // URL, just the references `normalizeAxiosRequest` already computed.
    (interceptorRequest as any).raw = raw;

    // Create the interceptor chain (always includes axios adapter)
    return this.executeInterceptorChain(interceptorRequest);
  }

  /**
   * End of the interceptor chain: performs the undici request and converts
   * the response to the axios-compatible format (the built-in axios response
   * adapter, applied inline to avoid an extra Observable/operator layer per
   * request).
   *
   * Redirects (plan.md phase 2, "follow redirects by default") are handled
   * manually here, on the response, rather than by composing undici's own
   * redirect interceptor/dispatcher onto every request: that interceptor
   * costs 10-20% even on a response that never redirects (see
   * `plan/reports/axios-compat.md`), and it also needs a dispatcher from
   * *this* copy of undici to `.compose()` onto - which isn't always the
   * active global dispatcher (Node.js 22 bundles its own undici, which can
   * install itself as the global dispatcher first). Re-issuing `request()`
   * per hop instead works with whatever dispatcher is active, on every
   * supported Node.js/undici combination, and a non-redirect response pays
   * only the `statusCode`/`Location` check in `onResponse` below.
   */
  private executeRequest(
    interceptorRequest: HttpInterceptorRequest,
  ): Observable<AxiosLikeResponse> {
    return new Observable<AxiosLikeResponse>(subscriber => {
      // `data:` URLs (plan.md phase 2 "fix: support data: URLs"): resolved
      // entirely locally, exactly like axios - no dispatcher resolution, no
      // abort signal, no undici `request()` call at all. Checked first, so
      // every other (http/https) request - the overwhelming majority - pays
      // only this one string check.
      const dataUrl = dataUrlString(interceptorRequest.url);
      if (dataUrl !== undefined) {
        resolveDataUrlRequest(interceptorRequest, dataUrl).then(
          response => {
            subscriber.next(response);
            subscriber.complete();
          },
          error => subscriber.error(error),
        );
        return;
      }

      // Ensure we use the configured dispatcher (for cookies, proxy, etc.)
      const rawOptions = interceptorRequest.options as Record<string, any> & {
        maxRedirections?: number;
        beforeRedirect?: BeforeRedirect;
        sensitiveHeaders?: string[];
        socketPath?: string;
      };
      const {
        maxRedirections,
        beforeRedirect: requestBeforeRedirect,
        sensitiveHeaders: requestSensitiveHeaders,
        socketPath: requestSocketPath,
        // The raw axios `timeout` (ms): a total deadline, read by this
        // method's own timer below - not undici's own `headersTimeout`/
        // `bodyTimeout` (still set alongside it, as a backstop; see
        // `dispatchFastPath`/`serializeAxiosConfig`). Stripped here so it
        // never reaches undici's own request options. May still be the raw,
        // unparsed config value here (a numeric string included) - see
        // `deadlineMs`, just below, which normalises it.
        timeout: rawTimeout,
        timeoutErrorMessage,
        transitional,
        maxBodyLength,
        // Progress callbacks/`maxRate` (plan.md phase 2 "Progress
        // callbacks"): stripped here so they never reach undici's own
        // request options. `onUploadProgress`/upload `maxRate` are consumed
        // right below; `onDownloadProgress` is read later, off
        // `interceptorRequest.options` itself (untouched by this
        // destructure - a different object than `options`, below) by
        // `toAxiosLikeResponse` (`axios-response.adapter.ts`), since it only
        // matters once a response actually arrives.
        onUploadProgress,
        onDownloadProgress: _onDownloadProgress,
        maxRate,
        ...restOptions
      } = rawOptions;
      // Destructuring a rest element off a `Record<string, any>`-shaped
      // source infers `{}` for the rest (TypeScript can't enumerate an
      // index signature's keys) - re-widen it so the many `requestOptions.*`
      // reads below (`headersTimeout`, `dispatcher`, `signal`, ...) still
      // type-check; the runtime object is untouched either way.
      const requestOptions: Record<string, any> = restOptions;

      // An unparsable `timeout` (plan.md phase 2 "fix: remaining error-shape
      // gaps", item 1): axios gives `ERR_BAD_OPTION_VALUE`, not the generic
      // `ERR_BAD_REQUEST` `toAxiosError` would otherwise map undici's own
      // `InvalidArgumentError` ("invalid headersTimeout") to further down -
      // checked up front, before ever resolving a dispatcher or dispatching,
      // so an invalid config never reaches undici at all.
      if (isUnparsableTimeout(rawTimeout)) {
        subscriber.error(createUnparsableTimeoutError(interceptorRequest));
        return;
      }
      // A numeric-string `timeout` (`timeout: '250'`), like axios' own
      // `parseInt(config.timeout, 10)` (plan.md phase 2: "fix: parse a
      // numeric-string timeout like axios") - `isUnparsableTimeout` above
      // already rejected anything `parseInt` can't turn into a number, so
      // this can only turn a valid numeric string into its number (never
      // `NaN`). Only pays the `parseInt` cost for a string; the overwhelming
      // majority (an already-numeric `timeout`, or none at all) takes zero
      // extra cost beyond this one `typeof` check. `headersTimeout`/
      // `bodyTimeout` (set to the same raw string by `dispatchFastPath`,
      // still present in `requestOptions` below) are normalised alongside it
      // so undici's own argument validation never sees a string.
      let deadlineMs: number | undefined = rawTimeout;
      if (typeof rawTimeout === 'string') {
        deadlineMs = parseInt(rawTimeout, 10);
        requestOptions.headersTimeout = deadlineMs;
        requestOptions.bodyTimeout = deadlineMs;
      }

      // `sensitiveHeaders` (plan.md "fix: redirect sensitiveHeaders option"):
      // request > axiosRef.defaults > module, the same precedence every
      // other passthrough default gets - `requestSensitiveHeaders` here is
      // already request-vs-defaults-resolved (`normalizeAxiosRequest`/
      // `buildAxiosConfig`, both upstream of this point); the `?? module`
      // fallback below only matters when `defaults` was never seeded at all
      // (a service's own `axiosRef.defaults` always is, at setup - see
      // `DEFAULTS_PASSTHROUGH_KEYS` in `axios-ref.factory.ts` - so this is
      // just a safety net, matching `beforeRedirect` just above it). Validated
      // - and, once validated, resolved into the `Set` `buildRedirectHop`
      // checks headers against - up front, exactly like
      // `timeout` above: axios validates `config.sensitiveHeaders` while
      // building the (non-native) follow-redirects transport options, before
      // the request is even sent, whenever redirects are actually followed
      // (`maxRedirects !== 0`) - not lazily on the first redirect. Skipped
      // entirely (no cost) when `sensitiveHeaders` isn't set at all, the
      // overwhelming majority of requests.
      const configuredSensitiveHeaders =
        requestSensitiveHeaders ??
        (this.moduleOptions as any)?.sensitiveHeaders;
      let sensitiveHeaders: Set<string> | undefined;
      if (configuredSensitiveHeaders !== undefined) {
        const redirectsEnabled =
          (maxRedirections === undefined || maxRedirections === null
            ? DEFAULT_MAX_REDIRECTS
            : maxRedirections) !== 0;
        if (redirectsEnabled) {
          try {
            sensitiveHeaders = normalizeSensitiveHeaders(
              configuredSensitiveHeaders,
            );
          } catch {
            subscriber.error(
              createInvalidSensitiveHeadersError(interceptorRequest),
            );
            return;
          }
        }
      }

      // Precedence: an explicit per-request `dispatcher` always wins; then a
      // request-level `socketPath` (module-level `socketPath` is already
      // baked into `this.customDispatcher` by `setupDispatcher`); then the
      // module's own auto-built dispatcher (TLS/proxy/socketPath/HTTP2) or
      // an explicit module-level `dispatcher`.
      const dispatcher =
        requestOptions.dispatcher ||
        (requestSocketPath
          ? this.getSocketPathDispatcher(requestSocketPath)
          : undefined) ||
        this.customDispatcher ||
        this.instanceOptions.dispatcher ||
        // Per-service default, built once in the constructor - see
        // `defaultDispatcher`'s doc comment. Replaces falling back to
        // undici's global dispatcher.
        this.defaultDispatcher;

      // Abort the undici request when the Observable is unsubscribed before
      // it settles (rxjs `timeout()`, `switchMap`, `takeUntil`, `race`, ...),
      // matching `@nestjs/axios`' `makeObservable` teardown. Each subscription
      // gets its own signal (so `defer()`/`retry()` attempts don't share one),
      // combined with any user-supplied signal (already merged with
      // `cancelToken` by `normalizeAxiosRequest`). `settled` flips to true once
      // the response (or, for a `stream` response, the headers) has been handed
      // to the subscriber; after that the teardown itself may no longer abort
      // (a stream body the caller is still reading would break), but the
      // *user's own* signal still may (plan.md phase 2 "abort a
      // responseType: 'stream' response when the caller's AbortSignal fires
      // after emission" - matches axios' own `config.signal
      // .addEventListener('abort', abort)`, which it keeps live for exactly
      // as long as a `responseType: 'stream'` body stays open, checked
      // against real axios 1.20's `lib/adapters/http.js`). For anything
      // other than a still-open stream, aborting `abortSignal` post-settle is
      // a harmless no-op (undici's own dispatch has already fully finished
      // by then, so nothing is still listening on it) - see `openStream`
      // below, which tracks exactly when that isn't true. It also gates
      // redirect-hop teardown: unsubscribing mid-redirect must abort the
      // *current* hop, not one already superseded.
      const userSignal = requestOptions.signal as AbortSignal | undefined;
      const abortSignal = new RequestAbortSignal();
      let settled = false;
      // The still-open `responseType: 'stream'` body, once handed to the
      // subscriber, whose own close/end/error keeps `onUserAbort`'s listener
      // alive past `settled` (see `onResponse` below) - mirrors axios' own
      // `stream.finished(data, onFinished)`. `undefined` for every other
      // response shape, and for a stream response with no `userSignal` at
      // all (nothing to keep listening for).
      let openStream: Readable | undefined;
      // axios never sets `error.request` for a signal that was already
      // aborted *before* the request was ever dispatched (checked against
      // real axios 1.20: no request object exists yet at that point) -
      // unlike a mid-flight abort, which does. `preAborted` distinguishes
      // the two for `fail()`'s `CanceledError` below.
      const preAborted = userSignal?.aborted === true;
      let onUserAbort: (() => void) | undefined;
      if (userSignal) {
        if (userSignal.aborted) {
          abortSignal.abort(userSignal.reason);
        } else {
          onUserAbort = () => {
            abortSignal.abort(userSignal.reason);
          };
          userSignal.addEventListener('abort', onUserAbort, { once: true });
        }
      }

      // Total (deadline) timeout, as in axios: one timer for the whole
      // request - from now until the response is fully read (or, for
      // `responseType: 'stream'`, until the headers arrive - `settled`
      // flips true right after that, see the stream branch of
      // `toAxiosLikeResponse`, so the timer below never fires once it has).
      // Only created when `timeout > 0` (perf: no timer at all otherwise).
      // Kept separate from undici's own `headersTimeout`/`bodyTimeout`
      // (still set, as a backstop against undici's *idle* timers) because
      // those reset on every chunk - a slowly-but-steadily trickling body
      // would never trip them, where axios' own timeout is a hard deadline.
      const clarifyTimeoutError = !!transitional?.clarifyTimeoutError;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      if (typeof deadlineMs === 'number' && deadlineMs > 0) {
        deadlineTimer = setTimeout(() => {
          deadlineTimer = undefined;
          if (settled) return;
          const reason: DeadlineTimeoutReason = {
            axiosDeadlineTimeout: true,
            timeout: deadlineMs,
            timeoutErrorMessage,
            clarifyTimeoutError,
          };
          abortSignal.abort(reason);
        }, deadlineMs);
      }
      const clearDeadline = (): void => {
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
      };

      // Spreading a `Record<string, any>` into an object literal doesn't
      // propagate its index signature to the literal's inferred type either
      // - annotate explicitly (see `requestOptions` above).
      const options: Record<string, any> = {
        ...requestOptions,
        dispatcher,
        signal: abortSignal as any,
      };
      // The second (byte-string) header sanitization pass, applied exactly
      // once, right before this hop's actual dispatch - after axiosRef
      // request interceptors (if any) have already run, matching axios'
      // own `toByteStringHeaderObject` call site - see
      // `sanitizeHeadersToByteString`'s doc comment (`axios-headers.ts`) for
      // why this can't be folded into the earlier, set-time pass
      // (`mergeHeaders`/`AxiosHeaders#set`). A later redirect hop reuses
      // `currentOptions.headers`, derived from this same, already-sanitized
      // object (via `buildRedirectHop`'s copy/drop, never introducing a new
      // raw value), so this never needs to run again per hop.
      if (options.headers) {
        options.headers = sanitizeHeadersToByteString(options.headers);
      }

      // `maxBodyLength`, as in axios: a string/Buffer body is checked
      // synchronously before ever dispatching; a stream body is checked as
      // bytes are written (see `enforceMaxBodyLength`'s doc comment for the
      // exact codes/precedence).
      let maxBodyLengthError: any;
      if (maxBodyLength !== undefined) {
        const enforced = enforceMaxBodyLength(options.body, maxBodyLength);
        options.body = enforced.body;
        maxBodyLengthError = enforced.error;
      }

      // `onUploadProgress`/upload `maxRate` (plan.md phase 2 "Progress
      // callbacks"): wraps the body in a counting/throttling stream only
      // when at least one is actually set - a single `||` check on the
      // common, neither-set path.
      //
      // Review fix: axios/follow-redirects buffer every byte *written* to
      // the socket (not the original source), so a metered upload can still
      // be replayed on a 307/308 redirect. This library hands the body
      // straight to undici with no such buffering layer, so a *resendable*
      // string/Buffer body is instead kept unmetered on `options.body`/
      // `currentOptions.body` throughout the redirect chain (`buildRedirectHop`
      // below never sees a one-shot stream for it, so it never rejects the
      // redirect) and re-metered fresh, via `dispatchBody`, right before each
      // hop's actual `request()` call - one meter instance per hop, so each
      // hop's upload is reported independently, matching axios. An
      // already-stream body (a caller's own `Readable`, or the `form-data`
      // package's output) is genuinely one-shot regardless of metering, so
      // it's still metered immediately, once, exactly as before - it was
      // never resendable on a redirect anyway (see
      // `createStreamRedirectError`).
      let uploadMeterConfig: MeterOptions | undefined;
      if (
        options.body !== undefined &&
        (onUploadProgress || maxRate !== undefined)
      ) {
        const { upload: maxUploadRate } = resolveMaxRates(maxRate);
        if (onUploadProgress || maxUploadRate) {
          const config: MeterOptions = {
            onProgress: onUploadProgress,
            maxRate: maxUploadRate,
            total: resolveUploadTotal(options.body, options.headers),
          };
          if (
            typeof options.body === 'string' ||
            Buffer.isBuffer(options.body)
          ) {
            uploadMeterConfig = config;
          } else {
            options.body = meterUploadBody(options.body, config);
          }
        }
      }

      /**
       * `requestOptions` unchanged, unless a resendable string/Buffer body
       * still has a pending upload meter (`uploadMeterConfig`) - then a
       * shallow copy with a freshly metered body, built fresh for this one
       * hop. Called once per hop: the first dispatch below, and every
       * redirect replay (`onResponse`'s hop handling).
       */
      const dispatchBody = (
        requestOptions: Record<string, any>,
      ): Record<string, any> => {
        if (
          !uploadMeterConfig ||
          (typeof requestOptions.body !== 'string' &&
            !Buffer.isBuffer(requestOptions.body))
        ) {
          return requestOptions;
        }
        return {
          ...requestOptions,
          body: meterUploadBody(requestOptions.body, uploadMeterConfig),
        };
      };

      const fail = (error: unknown): void => {
        settled = true;
        clearDeadline();
        const info = preAborted
          ? undefined
          : new RequestInfo(currentUrl, currentOptions.method);
        if (isDeadlineTimeoutReason(abortSignal.reason)) {
          subscriber.error(
            createTimeoutError(abortSignal.reason, interceptorRequest, info),
          );
          return;
        }
        subscriber.error(
          toAxiosError(error, interceptorRequest, abortSignal, info),
        );
      };

      // `currentUrl`/`currentOptions` track the most recent hop, so a
      // redirect can resolve a relative `Location` and rebuild the request
      // without re-parsing anything from the original request. `maxRedirects`
      // is resolved lazily (once) on the first hop that's actually a
      // redirect - the common, non-redirecting request never touches it.
      let currentUrl: string | URL | UrlObject = interceptorRequest.url;
      let currentOptions: Record<string, any> = options;
      let redirectCount = 0;
      let maxRedirects: number | undefined;
      // The *backstop* idle-timer budget is one budget for the whole
      // redirect chain, as in axios, not a fresh one per hop: each hop gets
      // what's left of it. The deadline timer above needs no such
      // adjustment (it isn't reset per hop at all).
      const backstopTimeout = options.headersTimeout as number | undefined;
      const startedAt = backstopTimeout ? performance.now() : 0;

      if (maxBodyLengthError) {
        fail(maxBodyLengthError);
        return;
      }
      const badProtocol = unsupportedProtocol(interceptorRequest.url);
      if (badProtocol) {
        settled = true;
        clearDeadline();
        subscriber.error(
          createUnsupportedProtocolError(badProtocol, interceptorRequest),
        );
        return;
      }
      // A malformed `http(s):` URL (plan.md phase 2 "fix: reject a
      // malformed URL like axios instead of silently dispatching it"):
      // rejected synchronously, before ever resolving a dispatcher or
      // dispatching - string URLs only, matching axios' own check (a `URL`/
      // `UrlObject` request URL can't carry this kind of malformation).
      if (typeof interceptorRequest.url === 'string') {
        const malformedUrl = malformedHttpProtocolUrl(interceptorRequest.url);
        if (malformedUrl !== undefined) {
          settled = true;
          clearDeadline();
          subscriber.error(
            createInvalidUrlError(malformedUrl, interceptorRequest),
          );
          return;
        }
      }

      const onResponse = (res: UndiciResponse): void => {
        const location = res.headers.location as string | string[] | undefined;

        if (isRedirectResponse(res.statusCode, location)) {
          maxRedirects ??=
            maxRedirections === undefined || maxRedirections === null
              ? DEFAULT_MAX_REDIRECTS
              : maxRedirections;

          // `maxRedirects: 0` matches axios: the 3xx response is returned
          // as-is and goes through `validateStatus` like any other status.
          if (maxRedirects !== 0) {
            redirectCount++;
            if (redirectCount > maxRedirects) {
              dumpRedirectBody(res.body).then(() =>
                fail(createTooManyRedirectsError()),
              );
              return;
            }

            let hop: RedirectHopResult;
            try {
              hop = buildRedirectHop({
                currentUrl: urlToString(currentUrl),
                location: location!,
                statusCode: res.statusCode,
                method: currentOptions.method,
                headers: currentOptions.headers,
                body: currentOptions.body,
                // Same Node/axios duplicate-header shape `beforeRedirect`
                // sees in axios (follow-redirects hands it Node's joined
                // `IncomingMessage.headers`).
                responseHeaders: joinDuplicateHeaders(
                  res.headers as Record<string, string | string[]>,
                ),
                beforeRedirect:
                  requestBeforeRedirect ??
                  (this.moduleOptions as any)?.beforeRedirect,
                sensitiveHeaders,
              });
            } catch (error) {
              dumpRedirectBody(res.body).then(() => fail(error));
              return;
            }

            dumpRedirectBody(res.body).then(() => {
              currentUrl = hop.url;
              currentOptions = {
                ...currentOptions,
                method: hop.method,
                headers: hop.headers,
                body: hop.body,
              };
              if (backstopTimeout) {
                const remaining = Math.floor(
                  backstopTimeout - (performance.now() - startedAt),
                );
                if (remaining <= 0) {
                  fail(
                    Object.assign(new Error('Headers Timeout Error'), {
                      name: 'HeadersTimeoutError',
                      code: 'UND_ERR_HEADERS_TIMEOUT',
                    }),
                  );
                  return;
                }
                currentOptions.headersTimeout = remaining;
                currentOptions.bodyTimeout = remaining;
              }
              // A redirect hop runs inside this `.then()`, past the point
              // rxjs' Observable constructor can catch a synchronous throw
              // for us (see the comment on the first `request()` call
              // below), so it's wrapped explicitly.
              try {
                request(hop.url, dispatchBody(currentOptions) as any).then(
                  onResponse,
                  fail,
                );
              } catch (error) {
                fail(error);
              }
            });
            return;
          }
        }

        // Built from the hop that was actually dispatched (matching axios'
        // `response.request` - see `RequestInfo`'s doc comment): `res`'s
        // `responseUrl` (computed lazily, only if read) is always the final
        // hop's URL, whether or not a redirect was actually followed,
        // exactly like axios' own.
        const requestInfo = new RequestInfo(
          currentUrl,
          currentOptions.method,
          currentUrl,
        );

        toAxiosLikeResponse(
          interceptorRequest,
          res,
          requestInfo,
          abortSignal,
        ).then(axiosRes => {
          settled = true;
          clearDeadline();
          // plan.md phase 2 "abort a responseType: 'stream' response when
          // the caller's AbortSignal fires after emission": keep
          // `onUserAbort` live for as long as this stream stays open
          // (mirrors axios' own `stream.finished(data, onFinished)`,
          // `lib/adapters/http.js`) instead of letting the teardown below
          // remove it the instant this subscription completes - RxJS
          // auto-unsubscribes right after `subscriber.complete()`, which
          // would otherwise detach it before the caller ever gets a chance
          // to abort a still-flowing stream. `wrapStreamCancellation`
          // (`axios-response.adapter.ts`) is what actually turns the
          // `abortSignal.abort()` this then triggers into the `CanceledError`
          // the caller's own `data.on('error', ...)` sees.
          const data = (axiosRes as any).data;
          const isOpenStream =
            !!data &&
            typeof data.pipe === 'function' &&
            typeof data.once === 'function';
          if (isOpenStream) {
            // plan.md phase 2 "decide: HttpService.onModuleDestroy waits
            // forever...": tracked independently of `onUserAbort` below -
            // this is what lets `onModuleDestroy`'s shutdown grace period
            // force-abort an abandoned stream even when the caller never
            // passed a `signal` of their own. See `trackOpenStream`'s doc
            // comment.
            this.trackOpenStream(dispatcher, abortSignal, data as Readable);
          }
          if (onUserAbort && isOpenStream) {
            openStream = data as Readable;
            openStream.once('close', () => {
              openStream = undefined;
              if (onUserAbort) {
                userSignal!.removeEventListener('abort', onUserAbort);
                onUserAbort = undefined;
              }
              (userSignal as any)?.[SIGNAL_CLEANUP]?.();
            });
          } else if (onUserAbort) {
            userSignal!.removeEventListener('abort', onUserAbort);
            onUserAbort = undefined;
          }
          subscriber.next(axiosRes);
          subscriber.complete();
        }, fail);
      };

      // Perf item 4: one `.then(onFulfilled, onRejected)` registration
      // instead of `.then().then().catch()` (3 registrations, each its own
      // Promise and microtask hop). `request(...)` itself stays a bare,
      // un-awaited call: if it throws *synchronously* (e.g. an invalid URL),
      // that must keep propagating straight out of this subscriber function
      // for rxjs' Observable constructor to catch and forward raw, exactly
      // as `@nestjs/axios` leaves it un-wrapped for the same input - wrapping
      // it in a try/catch here (or an `await`) would route it through
      // `fail`/`toAxiosError` instead, an observable behaviour change.
      request(interceptorRequest.url, dispatchBody(options)).then(
        onResponse,
        fail,
      );

      return () => {
        clearDeadline();
        if (!settled) abortSignal.abort();
        // Don't leave a listener on a long-lived user signal for every
        // request - except while `openStream` (above) is still open: that
        // listener is this stream's *only* remaining way to react to a later
        // `userSignal.abort()`, so removing it here (RxJS auto-unsubscribes
        // right after `subscriber.complete()`, i.e. immediately after this
        // stream was first handed back) would silently reintroduce the very
        // gap this fixes. `openStream`'s own `'close'` listener removes it
        // once the stream itself is done.
        if (!openStream) {
          if (onUserAbort) {
            userSignal!.removeEventListener('abort', onUserAbort);
            onUserAbort = undefined;
          }
          // Review follow-up (PR #15): also remove the listener
          // `resolveSignal` (axios-request.adapter.ts) may have added
          // directly on the *caller's* signal when combining it with a
          // legacy `cancelToken` - see `SIGNAL_CLEANUP`'s doc comment.
          // Deferred alongside `onUserAbort` above: while `openStream` is
          // still open, a cancelToken this combined with must still be able
          // to reach `userSignal` (and so `onUserAbort`) too.
          (userSignal as any)?.[SIGNAL_CLEANUP]?.();
        }
      };
    });
  }

  private executeInterceptorChain<T = any>(
    request: HttpInterceptorRequest,
  ): Observable<any> {
    // The axios response adapter always runs last, inside executeRequest()
    if (
      !this.cachedInterceptorHandler ||
      this.cachedInterceptorHandlerVersion !== this.interceptorsVersion
    ) {
      this.cachedInterceptorHandler = this.createInterceptorHandler<T>(
        0,
        this.interceptors,
      );
      this.cachedInterceptorHandlerVersion = this.interceptorsVersion;
    }
    return this.cachedInterceptorHandler.handle(request);
  }

  private createInterceptorHandler<T = any>(
    index: number,
    interceptors: Array<HttpInterceptor | HttpInterceptorFunction>,
  ): HttpInterceptorHandler {
    if (index >= interceptors.length) {
      // End of chain - execute the actual request
      return {
        handle: (request: HttpInterceptorRequest) =>
          this.executeRequest(request),
      };
    }

    const interceptor = interceptors[index];
    const nextHandler = this.createInterceptorHandler<T>(
      index + 1,
      interceptors,
    );

    return {
      handle: (request: HttpInterceptorRequest) => {
        if (typeof interceptor === 'function') {
          return interceptor(request, nextHandler);
        } else {
          return interceptor.intercept(request, nextHandler);
        }
      },
    };
  }

  /**
   * A read-only snapshot of this service's resolved undici/module options
   * (**breaking**: previously the live, mutable `instanceOptions` object
   * itself - plan.md phase 3 "HttpService members"). The internal
   * `__resolvedConfig` key (where `axios-config.adapter.ts` stashes resolved
   * transport pieces for `setupDispatcher` - see `ResolvedModuleConfig`) is
   * stripped; everything else - `dispatcher`, `headers`, `baseURL`, ... - is
   * a shallow copy, frozen with `Object.freeze` so reassigning a top-level
   * key throws in strict mode (module code, and this library's own source,
   * is always strict). A nested object (`headers`, for instance) isn't
   * itself frozen and can still be mutated, but doing so was already
   * documented as having no effect once `axiosRef.defaults` has seeded from
   * it - see `docs/http/http.service.md`.
   */
  public get undiciRef(): Readonly<UndiciRequestOptionsType> {
    const snapshot: ResolvedUndiciRequestOptions = {
      ...(this.instanceOptions as ResolvedUndiciRequestOptions),
    };
    delete snapshot.__resolvedConfig;
    return Object.freeze(snapshot) as Readonly<UndiciRequestOptionsType>;
  }

  /**
   * Axios-compatible reference for interceptor management
   * Provides axios-style API: httpService.axiosRef.interceptors.request.use()
   */
  public get axiosRef(): AxiosRef {
    return this._axiosRef;
  }

  public addInterceptor(
    interceptor: HttpInterceptor | HttpInterceptorFunction,
  ): void {
    this.interceptors.push(interceptor);
    this.interceptorsVersion++;
  }

  /**
   * Replaces the module-registered (`HttpInterceptor`) interceptor chain
   * wholesale. **Internal** (plan.md phase 3 "HttpService members": "internal
   * `setInterceptors`") - not part of the public type any more (previously
   * `public`, called by `http.module.ts` right after construction; the
   * module now passes the resolved interceptor list into the constructor
   * instead, so nothing outside this class needs to call this method). Kept
   * as a real method, not inlined, because it's also this constructor's own
   * entry point and it's what actually needs to run to add or replace the
   * chain (bumping `interceptorsVersion` so the cached handler chain -
   * `executeInterceptorChain` - rebuilds).
   */
  private setInterceptors(
    interceptors: Array<HttpInterceptor | HttpInterceptorFunction>,
  ): void {
    this.interceptors = interceptors;
    this.interceptorsVersion++;
  }

  /**
   * The number of module-registered (`HttpInterceptor`) interceptors this
   * service currently runs every request through - i.e. `this.interceptors
   * .length`, the same array `addInterceptor()` pushes onto and the
   * (internal) `setInterceptors()` replaces. **Breaking**: previously added
   * 1 for a phantom "axios response adapter" interceptor that hasn't existed
   * since the axiosRef pipeline refactor (plan.md "refactor(axiosRef): one
   * config object..."), and separately counted axiosRef's own request/response
   * interceptors (`axiosRef.interceptors.request/response`) - a different,
   * unrelated chain (see `runAxiosPipeline`) that this library has no
   * equivalent "count" property for on the `axiosRef` object either, exactly
   * like real axios. Kept (rather than removed, per plan.md phase 3's "if it
   * has no real use, remove it" option) because it has a genuine use once
   * fixed: asserting that `addInterceptor()`/module `interceptors` actually
   * registered what was expected, which several existing tests already do -
   * see `tests/services/http-interceptor.e2e.spec.ts`.
   */
  public get interceptorCount(): number {
    return this.interceptors.length;
  }

  /**
   * Convenience method for GET requests
   * @param url The URL to request
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public get<T = any, D = any>(
    url: string | URL | UrlObject,
    config?: AxiosLikeRequestConfig<D>,
  ): Observable<AxiosLikeResponse<T, D>> {
    return this.request(url, { ...config, method: 'GET' });
  }

  /**
   * Convenience method for POST requests
   * @param url The URL to request
   * @param data The data to send in the body
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public post<T = any, D = any>(
    url: string | URL | UrlObject,
    data?: D,
    config?: AxiosLikeRequestConfig<D>,
  ): Observable<AxiosLikeResponse<T, D>> {
    return this.request(url, { ...config, method: 'POST', data });
  }

  /**
   * Convenience method for PUT requests
   * @param url The URL to request
   * @param data The data to send in the body
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public put<T = any, D = any>(
    url: string | URL | UrlObject,
    data?: D,
    config?: AxiosLikeRequestConfig<D>,
  ): Observable<AxiosLikeResponse<T, D>> {
    return this.request(url, { ...config, method: 'PUT', data });
  }

  /**
   * Convenience method for DELETE requests
   * @param url The URL to request
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public delete<T = any, D = any>(
    url: string | URL | UrlObject,
    config?: AxiosLikeRequestConfig<D>,
  ): Observable<AxiosLikeResponse<T, D>> {
    return this.request(url, { ...config, method: 'DELETE' });
  }

  /**
   * Convenience method for PATCH requests
   * @param url The URL to request
   * @param data The data to send in the body
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public patch<T = any, D = any>(
    url: string | URL | UrlObject,
    data?: D,
    config?: AxiosLikeRequestConfig<D>,
  ): Observable<AxiosLikeResponse<T, D>> {
    return this.request(url, { ...config, method: 'PATCH', data });
  }

  /**
   * Convenience method for HEAD requests
   * @param url The URL to request
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public head<T = any, D = any>(
    url: string | URL | UrlObject,
    config?: AxiosLikeRequestConfig<D>,
  ): Observable<AxiosLikeResponse<T, D>> {
    return this.request(url, { ...config, method: 'HEAD' });
  }

  /**
   * Convenience method for OPTIONS requests
   * @param url The URL to request
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public options<T = any, D = any>(
    url: string | URL | UrlObject,
    config?: AxiosLikeRequestConfig<D>,
  ): Observable<AxiosLikeResponse<T, D>> {
    return this.request(url, { ...config, method: 'OPTIONS' });
  }

  /**
   * Convenience method for POST requests with form data
   * @param url The URL to request
   * @param data The form data to send
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public postForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosLikeRequestConfig,
  ): Observable<AxiosLikeResponse<T>> {
    return this.formRequest('POST', url, data, config);
  }

  /**
   * Convenience method for PUT requests with form data
   * @param url The URL to request
   * @param data The form data to send
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public putForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosLikeRequestConfig,
  ): Observable<AxiosLikeResponse<T>> {
    return this.formRequest('PUT', url, data, config);
  }

  /**
   * Convenience method for PATCH requests with form data
   * @param url The URL to request
   * @param data The form data to send
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public patchForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosLikeRequestConfig,
  ): Observable<AxiosLikeResponse<T>> {
    return this.formRequest('PATCH', url, data, config);
  }

  /**
   * Convenience method for the HTTP `QUERY` method (@nestjs/axios 12, axios
   * >=1.13 - see `AxiosRef.query`).
   * @param url The URL to request
   * @param data The data to send in the body
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public query<T = any, D = any>(
    url: string | URL | UrlObject,
    data?: D,
    config?: AxiosLikeRequestConfig<D>,
  ): Observable<AxiosLikeResponse<T, D>> {
    return this.request(url, { ...config, method: 'QUERY', data });
  }

  /**
   * Shared implementation of postForm/putForm/patchForm - see
   * `buildFormRequestConfig` (shared with `axiosRef.postForm`/`putForm`/
   * `patchForm` in `axios-ref.factory.ts`, so both build the exact same
   * request). FormData bodies are sent as multipart; everything else is
   * url-encoded.
   */
  private formRequest<T = any>(
    method: 'POST' | 'PUT' | 'PATCH',
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosLikeRequestConfig,
  ): Observable<AxiosLikeResponse<T>> {
    return this.request(
      buildFormRequestConfig(
        method,
        url,
        data,
        config,
        this.axiosContext.defaults.formSerializer,
      ),
    );
  }
}
