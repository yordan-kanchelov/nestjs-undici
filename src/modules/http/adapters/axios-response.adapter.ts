import type { UrlObject } from 'node:url';
import { Readable, PassThrough } from 'node:stream';
import type { Dispatcher } from 'undici';
import {
  AxiosError,
  CanceledError,
  createStatusError,
} from '../errors/axios-error';
import {
  DECODE_ERROR,
  hasContentLengthLimit,
  isDecodableEncoding,
  readBodyAsResponseType,
  readDefaultBody,
  readText,
  STRICT_JSON_RAW_TEXT,
} from './axios-response-type.adapter';
import { buildLazyAxiosConfig } from './axios-request.adapter';
import type { AbortableSignal } from './axios-progress.adapter';
import { meterDownloadBody, resolveMaxRates } from './axios-progress.adapter';
import { urlToString } from './redirect.adapter';
import type { HttpInterceptorRequest } from '../interfaces/http-interceptor.interface';
import type {
  AxiosLikeResponse,
  InternalAxiosLikeRequestConfig,
} from '../interfaces/axios-compatible.interface';

type ParsedRequestUrl = {
  protocol: string | undefined;
  host: string | undefined;
  path: string | undefined;
};

/**
 * True for a genuine decode failure - zlib/brotli/zstd itself failing to
 * decode already-fully-read bytes - as opposed to a network-level error (a
 * dropped socket, `UND_ERR_SOCKET`, an abort, ...) that happens to reach the
 * same catch block, or the same stream's `'error'` event, while
 * decompression was configured. Used to scope the corrupt-compressed-body
 * wrapping (both the buffered catch block and `wrapStreamCancellation`
 * below) to that case only - a network error must still reach
 * `fail()`/`toAxiosError`'s own, more specific shaping (e.g. `UND_ERR_SOCKET`
 * -> `ECONNRESET`) unwrapped, exactly as it would for an uncompressed
 * response - wrapping it here first would short-circuit that mapping
 * (`toAxiosError`'s very first check returns an already-`isAxiosError`
 * value unchanged).
 *
 * Checks the `DECODE_ERROR` tag `decompressBuffer`/`decompressStream`
 * (`axios-response-type.adapter.ts`) set at the error's actual origin,
 * rather than sniffing its `code`/`name` shape: an earlier version of this
 * checked for a `Z_`-prefixed `code`, which only zlib (gzip/deflate) codecs
 * raise - brotli and zstd's own decode failures have differently-shaped
 * codes entirely, so that check silently under-wrapped them (found in PR
 * #38 review; confirmed directly against real corrupt brotli/zstd bodies).
 */
function isDecodeError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as any)[DECODE_ERROR] === true
  );
}

/**
 * A lightweight stand-in for axios' `response.request`/`error.request` (the
 * real `http.ClientRequest`, wrapped by `follow-redirects`): axios' own,
 * commonly-read fields (`path`, `method`, `host`, `protocol`, and
 * `res.responseUrl` - the final hop's URL, set whether or not a redirect was
 * actually followed).
 *
 * Perf: the constructor only stores the raw inputs (no `new URL()` parse, no
 * object allocation beyond `this`) - this is built on *every* response and
 * error, so a request whose `.request`/`.response.request` is never read
 * (the overwhelmingly common case) pays nothing beyond that. `path`/`host`/
 * `protocol`/`res` are lazy prototype getters: the URL parse (or
 * `urlToString`, for `res.responseUrl`) runs at most once, on first access,
 * and its result is cached in a private field - a second read of the same
 * field, or of `{ ...response }`'s copy (same instance, by reference), is
 * then free.
 */
export class RequestInfo {
  private readonly _url: string | URL | UrlObject;
  private readonly _method: string;
  // `undefined` when this request never reached a response at all (e.g. a
  // network/timeout error) - `res` then stays `undefined`, matching axios.
  private readonly _responseUrlSource: string | URL | UrlObject | undefined;
  private _parsed?: ParsedRequestUrl;
  private _res?: { responseUrl: string };

  constructor(
    url: string | URL | UrlObject,
    method: string,
    responseUrlSource?: string | URL | UrlObject,
  ) {
    this._url = url;
    this._method = method;
    this._responseUrlSource = responseUrlSource;
  }

  private parse(): ParsedRequestUrl {
    if (this._parsed) return this._parsed;
    let protocol: string | undefined;
    let host: string | undefined;
    let path: string | undefined;
    const url = this._url;
    if (url instanceof URL) {
      protocol = url.protocol;
      host = url.hostname;
      path = `${url.pathname}${url.search}`;
    } else if (typeof url === 'string') {
      try {
        const parsed = new URL(url);
        protocol = parsed.protocol;
        host = parsed.hostname;
        path = `${parsed.pathname}${parsed.search}`;
      } catch {
        // Leave path/host/protocol undefined - same as axios itself would
        // give for a request that never got far enough to resolve one.
      }
    } else if (url && typeof url === 'object') {
      protocol = (url as UrlObject).protocol ?? undefined;
      host = (url as UrlObject).hostname ?? undefined;
      path = `${(url as UrlObject).pathname ?? ''}${(url as UrlObject).search ?? ''}`;
    }
    return (this._parsed = { protocol, host, path });
  }

  get method(): string {
    return this._method;
  }

  get protocol(): string | undefined {
    return this.parse().protocol;
  }

  get host(): string | undefined {
    return this.parse().host;
  }

  get path(): string | undefined {
    return this.parse().path;
  }

  get res(): { responseUrl: string } | undefined {
    if (this._responseUrlSource === undefined) return undefined;
    return (this._res ??= {
      responseUrl: urlToString(this._responseUrlSource),
    });
  }
}

/**
 * `AxiosLikeResponse` with `config` built lazily, from a `config` getter on
 * the prototype (defined once) rather than a `Object.defineProperty` call
 * per instance - the getter itself costs nothing until `.config` is read,
 * unlike installing a per-instance accessor on every response.
 */
class AxiosLikeResponseImpl<T = any> implements AxiosLikeResponse<T> {
  // `config` is a plain own property, as in axios, so it survives
  // `{ ...response }`, `JSON.stringify` and `structuredClone`.
  public config: InternalAxiosLikeRequestConfig;
  public request: any;
  public data: T;
  public status: number;
  public statusText: string;

  /**
   * A plain undici headers object, deliberately *not* wrapped in
   * `AxiosHeaders` on every response (plan.md phase 2 "types: axios
   * interop", goal 3: "measure it; if it costs more than the benchmark
   * threshold allows, keep a plain object at runtime but type it
   * compatibly"). Measured (`new AxiosHeaders(typicalHeaders)` vs a plain
   * object, 200k iterations, this sandbox): about 955ns more per response
   * just to construct the Proxy-wrapped instance (~1µs vs ~33ns), before
   * counting that every later property read on it also pays a Proxy-trap
   * cost the plain object doesn't (see the "avoid AxiosHeaders Proxy access
   * on the hot path" note in plan.md phase 4, and PR #18's ~9µs/request fix
   * for exactly that on the interceptor path). That's paid on *every*
   * response unconditionally, unlike `config` (lazy, built only if read),
   * and would eat a large slice of the +10% per-request CPU budget the
   * "HttpService regression check" enforces - not worth it for a header
   * bag most callers only ever index by string key. Typed compatibly with
   * axios' `AxiosResponse.headers` regardless (`Record<string, any>`, see
   * `AxiosLikeResponse`'s doc comment) - `response.headers.get(...)` etc.
   * stay unavailable, documented in docs/axios-supported-options.md.
   */
  public headers: Record<string, any>;

  constructor(
    data: T,
    status: number,
    statusText: string,
    headers: any,
    configRequest: HttpInterceptorRequest,
    requestInfo: RequestInfo | Record<string, any>,
  ) {
    this.data = data;
    this.status = status;
    this.statusText = statusText;
    this.headers = headers;
    this.config = buildLazyAxiosConfig(configRequest);
    this.request = requestInfo;
  }
}

/**
 * HTTP status text mapping
 */
export const STATUS_TEXT_MAP: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  510: 'Not Extended',
  511: 'Network Authentication Required',
};

/**
 * True when `status` passes `options.validateStatus`, axios' own way
 * (`settle()`): a *function* `validateStatus` decides it outright;
 * `validateStatus` present as an own key at all (even explicit `undefined`,
 * or `null`) always resolves, matching axios' `!validateStatus ||
 * validateStatus(status)` (a non-function `validateStatus` never rejects);
 * otherwise the built-in 2xx range. Shared by `toAxiosLikeResponse` (a real
 * network response) and `resolveDataUrlRequest` (a `data:` URL's synthetic
 * response - axios runs the *exact same* `settle()` for both).
 */
export function resolveIsValidStatus(
  options: Record<string, any> | undefined,
  status: number,
): boolean {
  const configuredValidateStatus = options?.validateStatus;
  return typeof configuredValidateStatus === 'function'
    ? configuredValidateStatus(status)
    : Object.prototype.hasOwnProperty.call(options ?? {}, 'validateStatus')
      ? true
      : status >= 200 && status < 300;
}

/**
 * Enforces `maxContentLength` on a `responseType: 'stream'` body, matching
 * axios 1.20 exactly (`lib/adapters/http.js`'s own streamed enforcement,
 * `Readable.from(enforceMaxContentLength(), ...)`  - checked against real
 * axios 1.20): wraps the (already decompressed, if applicable -
 * `maxContentLength` counts decoded bytes, like the buffered case in
 * `axios-response-type.adapter.ts`) stream in an async generator that throws
 * a real `AxiosError` once the running total crosses the limit. Reading it
 * past that point destroys `source` through the `for await` loop's own
 * `return()` call on an abrupt completion - the same mechanism
 * `readBufferWithLimit`/`readDecompressedBufferWithLimit` already rely on
 * for the buffered case - rather than a `Transform` this function would have
 * to destroy manually. When the response was compressed, `source` is
 * `decompressStream`'s own return value, which - review fix: destroying only
 * `source` used to leave the raw (undici) body/socket dangling, since
 * `.pipe()` never propagates destruction upstream - already wires
 * destroying it to destroying the raw body behind it (see that function's
 * doc comment), so this still only ever needs to destroy the one stream it
 * was given. Only ever called when a limit is actually set (see the call
 * site below): an unset/`-1` `maxContentLength` (the common case) never
 * wraps the stream at all, so `responseType: 'stream'` costs nothing extra
 * by default.
 */
function guardStreamMaxContentLength(
  source: Readable,
  maxContentLength: number,
  request: HttpInterceptorRequest,
  requestInfo: RequestInfo | Record<string, any>,
): Readable {
  async function* enforce(): AsyncGenerator<Buffer> {
    let total = 0;
    for await (const chunk of source as unknown as AsyncIterable<Buffer>) {
      total += (chunk as Buffer).length;
      if (total > maxContentLength) {
        const error = new AxiosError(
          `maxContentLength size of ${maxContentLength} exceeded`,
          AxiosError.ERR_BAD_RESPONSE,
          undefined,
          requestInfo,
        );
        error._setLazyConfig(request);
        throw error;
      }
      yield chunk as Buffer;
    }
  }
  return Readable.from(enforce());
}

/**
 * Matches axios' own `responseType: 'stream'` cancellation exactly (checked
 * against real axios 1.20, `lib/adapters/http.js`): an abort-shaped error
 * (undici's `RequestAbortedError`, `code: 'UND_ERR_ABORTED'`/`name:
 * 'AbortError'`) reaching the response stream *after* it was already handed
 * back to the caller surfaces as a proper `CanceledError`/`ERR_CANCELED`,
 * not the raw undici error - covering both of plan.md's phase 2 stream-abort
 * items:
 *
 * - **the caller's own upload body stream (`config.data`) is destroyed
 *   mid-request.** Confirmed directly (a real server + a real undici
 *   `request()` call, no code of this library's own in the loop at all):
 *   undici *itself* already reacts to that by erroring the in-flight
 *   response body with exactly this shape - axios' own upload-side
 *   `data.on('close', ...)` watcher (`lib/adapters/http.js`) exists only to
 *   *trigger* the same abort Node's `http`/its own `RedirectableRequest`
 *   otherwise wouldn't raise on its own; undici already raises it as part
 *   of the *response* body's own lifecycle, so this library needs no
 *   matching upload-side watcher of its own - only this translation.
 * - **the caller's own `config.signal` fires after the stream was already
 *   emitted.** `HttpService.executeRequest` (`http.service.ts`) now keeps
 *   reacting to it for as long as this stream stays open (mirroring axios'
 *   own `config.signal.addEventListener('abort', abort)`, removed only once
 *   `stream.finished(data, ...)` fires - checked against real axios 1.20)
 *   instead of only up to the point the stream was handed back, and calls
 *   `abortSignal.abort(...)` - the same per-request signal already passed to
 *   undici's `request()` - which is what actually produces the
 *   `UND_ERR_ABORTED` this function then translates.
 *
 * Implemented as a `PassThrough` wrapper, not a listener added directly to
 * `source`: once undici (or anything else) has already called
 * `source.destroy(err)`, `source` is already `destroyed` by the time its
 * `'error'` listeners run, so there's no way to swap the error object
 * in place for whichever listener - the caller's own - reads it. Bidirectional
 * destroy propagation (`wrapper.once('close', ...)`) matches
 * `decompressStream`'s own pattern, so a caller that stops reading the
 * wrapper early still releases the raw undici body/socket behind it.
 *
 * `wrapDecodeErrors` additionally covers plan.md's "corrupt/truncated
 * compressed body" item's streamed half: when the response is actually
 * being decompressed, a genuine decode failure reaching this stream (a zlib
 * `Z_BUF_ERROR`/`Z_DATA_ERROR`, or brotli/zstd's own, differently-shaped
 * decode error - `decompressStream`'s decompressor, tagged with
 * `DECODE_ERROR` at its actual origin so this can tell it apart from the
 * *same* decompressor's `'error'` firing secondhand for a network failure
 * forwarded from the raw body - see `decompressStream`'s doc comment)
 * becomes a real `AxiosError` too - `AxiosError.from(err, undefined, ...,
 * requestInfo)` (`code` falling back to `err.code`, e.g. `'Z_BUF_ERROR'`),
 * matching axios' own buffered-path shape (`AxiosError.from(err, null,
 * config, lastRequest, response)` in `lib/adapters/http.js`'s
 * `handleStreamError`) applied to the stream path too, so a caller's own
 * `data.on('error', ...)` sees `isAxiosError`/`.config`/`.request` there
 * exactly as it would for the buffered case's rejection. An error that's
 * already axios-shaped (e.g. `guardStreamMaxContentLength`'s own
 * `AxiosError`, above) passes through unchanged either way, as does a
 * network-level error (which never carries the `DECODE_ERROR` tag).
 *
 * Only ever applied when at least one of the two triggers above, or an
 * active decompression, is actually possible for this request (see the call
 * site in `toAxiosLikeResponse`, below) - an ordinary, uncompressed streamed
 * download with no signal and no streamed upload body is untouched and pays
 * nothing extra.
 */
function wrapStreamCancellation(
  source: Readable,
  request: HttpInterceptorRequest,
  requestInfo: RequestInfo | Record<string, any>,
  wrapDecodeErrors: boolean,
): Readable {
  const wrapper = new PassThrough();
  source.pipe(wrapper);
  source.once('error', (err: any) => {
    if (wrapper.destroyed) return;
    if (err?.code === 'UND_ERR_ABORTED' || err?.name === 'AbortError') {
      const canceled = new CanceledError(undefined, undefined, requestInfo);
      canceled._setLazyConfig(request);
      wrapper.destroy(canceled);
      return;
    }
    if (wrapDecodeErrors && isDecodeError(err) && !err.isAxiosError) {
      const axiosError = AxiosError.from(
        err,
        undefined,
        undefined,
        requestInfo,
      );
      axiosError._setLazyConfig(request);
      wrapper.destroy(axiosError);
      return;
    }
    wrapper.destroy(err);
  });
  wrapper.once('close', () => {
    if (!source.destroyed) source.destroy();
  });
  return wrapper;
}

/**
 * True when `wrapStreamCancellation` above is needed for one of its two
 * cancellation triggers: the caller's own `config.signal`, or a streamed
 * upload body (`config.data`, normalized onto `options.body` by the time
 * this reads it), checked off `request.options` directly: still the
 * caller's *own* `AbortSignal`/`Readable` there, never this library's
 * internal `RequestAbortSignal` or a re-wrapped upload-meter stream
 * (`HttpService.executeRequest` mutates only its own local copy of these
 * options, never `request.options` itself - see that method's doc comments
 * on `options`/`uploadMeterConfig`). The call site below also wraps
 * whenever decompression is active, independent of this check - see
 * `wrapStreamCancellation`'s `wrapDecodeErrors` doc comment.
 */
function needsStreamCancellationWrap(request: HttpInterceptorRequest): boolean {
  const options = request.options as Record<string, any> | undefined;
  const rawSignal = options?.signal;
  const rawBody = options?.body;
  return (
    (!!rawSignal && typeof rawSignal.addEventListener === 'function') ||
    (!!rawBody &&
      typeof rawBody.pipe === 'function' &&
      typeof rawBody.on === 'function')
  );
}

/**
 * The header names Node's `IncomingMessage.headers` getter keeps only the
 * FIRST occurrence of when the same name arrives more than once (all other
 * repeats are silently dropped) - ported from `_http_incoming.js`'s
 * `matchKnownFields` (Node 22/24/26: unchanged since Node 12, verified
 * against the shipped source of each). Every other header name - including
 * one Node doesn't special-case at all - joins repeats with `', '` instead
 * (RFC 2616 §4.2), and axios inherits both behaviours for free by running
 * on Node's own `http`. `cookie` (joins with `'; '`) and `set-cookie`
 * (always an array) are handled separately in `joinDuplicateHeaders` below,
 * since neither fits this "keep-first" rule.
 */
const SINGLE_VALUE_HEADERS = new Set([
  'age',
  'authorization',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'from',
  'host',
  'if-modified-since',
  'if-unmodified-since',
  'last-modified',
  'location',
  'max-forwards',
  'proxy-authorization',
  'referer',
  'retry-after',
  'server',
  'user-agent',
]);

/**
 * Matches axios' own response headers on Node exactly, by replicating
 * `IncomingMessage.headers`'s per-name join rules (see
 * `SINGLE_VALUE_HEADERS`'s doc comment) on top of undici's raw parsed
 * headers - undici's own `parseHeaders` (`core/util.js`) has no such
 * per-name behaviour, and just accumulates every repeated header name into
 * an array uniformly, which is the one place the two disagree (found by a
 * differential check against real axios; the response.diff.spec.ts
 * "headers: casing, multi-value set-cookie, duplicates" case used to assert
 * this as a `knownDifference`).
 *
 * `set-cookie` keeps undici's array as-is (Node/axios always give an
 * array there too); `cookie` joins repeats with `'; '`; the
 * `SINGLE_VALUE_HEADERS` names keep only the first value; everything else
 * joins repeats with `', '`.
 *
 * Perf: a duplicated header is rare (most responses have none at all), so
 * this only ever pays for what it finds. The loop itself is one
 * `Array.isArray` check per header name - cheap even on a response with a
 * dozen headers - and the input object is returned unchanged, with no copy
 * and no allocation, unless at least one value actually needs rewriting.
 */
export function joinDuplicateHeaders<
  T extends Record<string, string | string[]>,
>(headers: T): T {
  let out: Record<string, string | string[]> | undefined;
  for (const key in headers) {
    const value = headers[key];
    if (!Array.isArray(value) || key === 'set-cookie') continue;
    out ??= { ...headers };
    out[key] =
      key === 'cookie'
        ? value.join('; ')
        : SINGLE_VALUE_HEADERS.has(key)
          ? value[0]
          : value.join(', ');
  }
  return (out as T | undefined) ?? headers;
}

/**
 * Converts an undici response to the axios-compatible response format,
 * reading and parsing the body and rejecting with an axios-like error when
 * the status fails `validateStatus`. `HttpService` applies it at the end of
 * the interceptor chain, in `executeRequest`.
 */
export async function toAxiosLikeResponse(
  request: HttpInterceptorRequest,
  undiciResponse: Dispatcher.ResponseData,
  // Built by `HttpService.executeRequest` from the hop that was actually
  // dispatched (a `RequestInfo`), whether or not a redirect was followed,
  // matching axios. A caller with no such hop tracking of its own can omit
  // it; a reasonable one is then built from `request` itself.
  requestInfo?: RequestInfo | Record<string, any>,
  // This request's abort signal (`HttpService.executeRequest`'s
  // `RequestAbortSignal`), passed through to `meterDownloadBody` so a
  // still-paced buffered read can still be rejected on an abort/timeout even
  // once the eager-drain mitigation there has already finished reading the
  // raw body - see that function's doc comment. A caller with no signal of
  // its own (e.g. the tests below) can omit it: `meterDownloadBody` simply
  // skips that wiring.
  signal?: AbortableSignal,
): Promise<AxiosLikeResponse> {
  requestInfo ??= new RequestInfo(
    request.url,
    String((request.options as any)?.method || 'GET'),
  );
  // Node/axios header-join semantics (see `joinDuplicateHeaders`'s doc
  // comment), applied once so every read below (`content-type`,
  // `content-encoding`, `content-length`, `transformResponse`'s own
  // `headers` argument, and the headers object handed to the caller) sees
  // the same, axios-shaped values - not undici's raw, uniformly-arrayed
  // ones.
  const headers = joinDuplicateHeaders(
    undiciResponse.headers as Record<string, string | string[]>,
  );
  // Parse the body based on content type
  const contentType = (headers['content-type'] as string) || '';
  let parsedData: any;

  // Check if maxContentLength is set in options
  const maxContentLength = (request.options as any)?.maxContentLength;
  const responseType = (request.options as any)?.responseType;
  const decompress = (request.options as any)?.decompress;
  // axios' `parseReviver` (plan.md "fix: JSON reviver (parseReviver)"): only
  // reaches the *default* JSON parsing below - a custom `transformResponse`
  // (the branch right after this) replaces default parsing entirely, same as
  // axios (`parseReviver` is read by axios' own default `transformResponse`
  // only; a fully custom one would have to read `this.parseReviver` itself).
  const parseReviver = (request.options as any)?.parseReviver;
  // axios' `transitional.silentJSONParsing === false` (plan.md phase 2
  // "transitional.silentJSONParsing"): only ever matters for `responseType:
  // 'json'` (see `parseJsonStrict`'s doc comment) - a plain property read
  // otherwise, no cost for the default (silent) path.
  const strictJsonParsing =
    responseType === 'json' &&
    (request.options as any)?.transitional?.silentJSONParsing === false;
  const contentEncodingHeader = headers['content-encoding'];
  const contentEncoding = Array.isArray(contentEncodingHeader)
    ? contentEncodingHeader[0]
    : contentEncodingHeader;
  // plan.md phase 2 "delete Content-Encoding from response.headers after a
  // successful decode": matches axios' own timing and conditions exactly
  // (`lib/adapters/http.js`, checked against real axios 1.20) - deleted only
  // when `decompress !== false` and the header is actually present, and
  // then: unconditionally for a `HEAD` request or a `204` (no body to
  // decode either way, but axios still clears a stale header that would
  // otherwise "confuse downstream operations" - its own comment), or when
  // the encoding is one this library (like axios) actually decodes
  // (`isDecodableEncoding` - never for an unrecognized encoding, which is
  // passed through undecoded and must keep its header). Applied to every
  // `responseType`, including `'stream'`: axios does this synchronously,
  // before ever branching on `responseType`, based only on the encoding
  // being a decodable one - not on whether the (for `'stream'`, still
  // in-flight) decode has actually finished. axios doesn't otherwise touch
  // `content-length` on decode (checked: no such line in `http.js`), so
  // this library doesn't either - a decoded body's `Content-Length` header
  // is left as the server sent it (the *compressed* size), exactly like
  // axios.
  if (
    contentEncoding &&
    decompress !== false &&
    (String((request.options as any)?.method || 'GET').toUpperCase() ===
      'HEAD' ||
      undiciResponse.statusCode === 204 ||
      isDecodableEncoding(contentEncoding))
  ) {
    delete headers['content-encoding'];
  }
  // A custom `transformResponse` (module- or request-level, only ever set
  // when the axiosRef pipeline built this request - see `hasAxiosPipeline`)
  // *replaces* default parsing, same as axios: it gets the raw decoded body
  // (decompressed, not yet JSON-parsed), not the already-parsed value.
  const transformResponse = request.axiosConfig?.transformResponse;

  // `onDownloadProgress`/download `maxRate` (plan.md phase 2 "Progress
  // callbacks"): wrap the body in a counting/throttling stream only when at
  // least one is actually set - a single property read plus an `||` check on
  // the common, neither-set path, matching every other opt-in option this
  // function reads off `request.options`. Works for every `responseType`,
  // including `'stream'` (the wrapped stream is what the caller gets back).
  const onDownloadProgress = (request.options as any)?.onDownloadProgress;
  const rawMaxRate = (request.options as any)?.maxRate;
  let body: Dispatcher.ResponseData['body'] | Readable | undefined =
    undiciResponse.body;
  // True once `body` has been replaced with a metered stream (below) - a
  // plain Node `Transform`, not undici's own `BodyReadable`, so it has
  // neither `.bodyUsed` nor `.text()`. Read by the `catch` block below: an
  // error on a metered body (an abort, the source stream being destroyed, a
  // throwing `onDownloadProgress` callback, `maxContentLength`) is always a
  // real failure there - review fix: the fallback recovery just below was
  // written for undici's own body (a corrupt gzip/br/deflate payload, where a
  // second raw-text read might still succeed), and silently swallowed every
  // one of those into an empty, HTTP-200-looking response instead of
  // rejecting.
  let isMetered = false;
  if (body && (onDownloadProgress || rawMaxRate !== undefined)) {
    const { download: maxDownloadRate } = resolveMaxRates(rawMaxRate);
    if (onDownloadProgress || maxDownloadRate) {
      const contentLengthHeader = headers['content-length'];
      const total =
        typeof contentLengthHeader === 'string'
          ? Number(contentLengthHeader) || undefined
          : Array.isArray(contentLengthHeader)
            ? Number(contentLengthHeader[0]) || undefined
            : undefined;
      body = meterDownloadBody(body as unknown as Readable, {
        onProgress: onDownloadProgress,
        maxRate: maxDownloadRate,
        total,
        // Only a buffered responseType (everything except 'stream') is safe
        // to drain ahead of a slow maxRate/consumer - see
        // meterDownloadBody's doc comment.
        buffered: responseType !== 'stream',
        maxContentLength,
        signal,
      });
      isMetered = true;
    }
  }

  try {
    if (transformResponse && responseType !== 'stream') {
      // As in axios: a stream is never transformed, and binary response
      // types hand the transform the raw bytes rather than decoded text.
      const raw = !body
        ? ''
        : responseType === 'arraybuffer' || responseType === 'blob'
          ? await readBodyAsResponseType(
              body as Dispatcher.ResponseData['body'],
              responseType,
              maxContentLength,
              { contentEncoding, decompress },
            )
          : await readText(body as Dispatcher.ResponseData['body'], {
              contentEncoding,
              decompress,
            });
      const transforms = Array.isArray(transformResponse)
        ? transformResponse
        : [transformResponse];
      parsedData = transforms.reduce(
        (value: any, fn: any) =>
          fn.call(
            request.axiosConfig,
            value,
            headers,
            undiciResponse.statusCode,
          ),
        raw,
      );
    } else if (responseType && body) {
      parsedData = await readBodyAsResponseType(
        body as Dispatcher.ResponseData['body'],
        responseType,
        maxContentLength,
        { contentEncoding, decompress, parseReviver, strictJsonParsing },
      );
      if (
        responseType === 'stream' &&
        parsedData &&
        typeof (parsedData as any).pipe === 'function'
      ) {
        if (hasContentLengthLimit(maxContentLength)) {
          parsedData = guardStreamMaxContentLength(
            parsedData as Readable,
            maxContentLength!,
            request,
            requestInfo,
          );
        }
        // plan.md phase 2 "cancel a responseType: 'stream' response when its
        // request stream is destroyed" / "abort a responseType: 'stream'
        // response when the caller's AbortSignal fires after emission" /
        // "decode Content-Encoding: compress"'s corrupt/truncated-body
        // half - see `wrapStreamCancellation`'s doc comment. Gated so an
        // ordinary, uncompressed streamed download with no signal and no
        // streamed upload body pays nothing extra.
        const isCompressedStream = !!contentEncoding && decompress !== false;
        if (needsStreamCancellationWrap(request) || isCompressedStream) {
          parsedData = wrapStreamCancellation(
            parsedData as Readable,
            request,
            requestInfo,
            isCompressedStream,
          );
        }
      }
    } else if (body) {
      parsedData = await readDefaultBody(
        body as Dispatcher.ResponseData['body'],
        contentType,
        { maxContentLength, contentEncoding, decompress, parseReviver },
      );
    } else {
      // Axios returns empty string for null body
      parsedData = '';
    }
  } catch (error) {
    // axios' `transitional.silentJSONParsing: false` + `responseType:
    // 'json'` (plan.md phase 2 "transitional.silentJSONParsing" -
    // `parseJsonStrict`'s doc comment): a JSON parse failure tagged with the
    // raw text it failed to parse. Matches axios' own shape exactly
    // (`AxiosError.from(e, ERR_BAD_RESPONSE, this, null, own(this,
    // 'response'))` in `lib/defaults/index.js`): `response.data` is the raw,
    // un-parsed string (checked against real axios 1.20 - the parsed value
    // is never assigned when `transformResponse` itself throws), and
    // `.request` stays unset (axios passes `request: null` there too).
    // Takes priority over every other branch below: this is always our own
    // marker, set nowhere else.
    if (Object.prototype.hasOwnProperty.call(error, STRICT_JSON_RAW_TEXT)) {
      const partialResponse = new AxiosLikeResponseImpl(
        (error as any)[STRICT_JSON_RAW_TEXT],
        undiciResponse.statusCode,
        undiciResponse.statusText ||
          STATUS_TEXT_MAP[undiciResponse.statusCode] ||
          'Unknown',
        headers,
        request,
        requestInfo,
      );
      const axiosError = AxiosError.from(
        error,
        AxiosError.ERR_BAD_RESPONSE,
        undefined,
        undefined,
        partialResponse,
      );
      axiosError._setLazyConfig(request);
      throw axiosError;
    }
    // `maxContentLength` exceeded: a well-formed AxiosError (`name` stays
    // `'AxiosError'`, not the plain internal `Error`'s own `'Error'`), not
    // the plain, internal `Error` `assertMaxContentLength` throws to keep
    // the hot, no-limit path free of any AxiosError construction cost.
    if ((error as any)?.code === 'ERR_BAD_RESPONSE') {
      const axiosError = new AxiosError(
        (error as Error).message,
        AxiosError.ERR_BAD_RESPONSE,
        undefined,
        requestInfo,
      );
      axiosError._setLazyConfig(request);
      throw axiosError;
    }
    // Corrupt/truncated compressed data (plan.md phase 2 "decode
    // Content-Encoding: compress"'s buffered half): axios wraps this via
    // `AxiosError.from(err, null, config, lastRequest, response)` - checked
    // against real axios 1.20 (`lib/adapters/http.js`'s buffered
    // `handleStreamError`) - `code` falling back to the raw decode error's
    // own code (e.g. `'Z_BUF_ERROR'`/`'Z_DATA_ERROR'` for zlib, differently
    // shaped for brotli/zstd), `response.data` never assigned (matching
    // axios: the buffered read failed before any value could be). Scoped to
    // an actual decode failure (`isDecodeError`): a network-level error (a
    // dropped socket, an abort, ...) that happens to occur while
    // decompression was configured must still reach `fail()`/`toAxiosError`'s
    // own, more specific shaping unwrapped - see that helper's doc comment.
    if (isDecodeError(error)) {
      const partialResponse = new AxiosLikeResponseImpl(
        undefined,
        undiciResponse.statusCode,
        undiciResponse.statusText ||
          STATUS_TEXT_MAP[undiciResponse.statusCode] ||
          'Unknown',
        headers,
        request,
        requestInfo,
      );
      const axiosError = AxiosError.from(
        error,
        undefined,
        undefined,
        requestInfo,
        partialResponse,
      );
      axiosError._setLazyConfig(request);
      throw axiosError;
    }
    // Failures after the body was read (for example a metered download's
    // real failure - an abort, destroy, or a throwing progress callback),
    // reject like axios does: the body can't be read again, so falling back
    // would silently return empty data. A metered body (see `isMetered`
    // above) is never given a second read either - it has no
    // `.bodyUsed`/`.text()` of its own to recover through.
    if (isMetered || (body as any)?.bodyUsed) {
      throw error;
    }

    // If parsing fails, try to get raw text
    try {
      parsedData =
        typeof (body as any)?.text === 'function'
          ? await (body as Dispatcher.ResponseData['body']).text()
          : '';
    } catch {
      parsedData = '';
    }
  }

  // Transform to Axios-compatible response. `config` is built lazily (see
  // `AxiosLikeResponseImpl`): `request.axiosConfig` already holds the final,
  // interceptor-mutated config when the axiosRef pipeline built this
  // request, and is otherwise built - correctly shaped, but only if/when
  // read - from the cheap fields `normalizeAxiosRequest` computed.
  const axiosLikeResponse = new AxiosLikeResponseImpl(
    parsedData,
    undiciResponse.statusCode,
    // undici exposes the server's actual reason phrase (matching axios, which
    // reads Node's `res.statusMessage`); the table is only a fallback for a
    // dispatcher that doesn't provide one (e.g. HTTP/2, which has none).
    undiciResponse.statusText ||
      STATUS_TEXT_MAP[undiciResponse.statusCode] ||
      'Unknown',
    headers,
    request,
    requestInfo,
  );

  if (!resolveIsValidStatus(request.options, undiciResponse.statusCode)) {
    throw createStatusError(axiosLikeResponse, request);
  }

  return axiosLikeResponse;
}
