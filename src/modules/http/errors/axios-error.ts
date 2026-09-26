import type { HttpInterceptorRequest } from '../interfaces/http-interceptor.interface';
import type {
  AxiosLikeResponse,
  InternalAxiosLikeRequestConfig,
} from '../interfaces/axios-compatible.interface';
import { buildLazyAxiosConfig } from '../adapters/axios-request.adapter';
import type { RequestInfo } from '../adapters/axios-response.adapter';

/**
 * Axios-compatible error class.
 *
 * Mirrors the shape of axios' `AxiosError` (`message`, `code`, `config`,
 * `request`, `response`, `status`, `isAxiosError`, `toJSON()`), so code that
 * duck-types errors (including `axios.isAxiosError(error)`, which only checks
 * `error.isAxiosError === true`) keeps working after migrating from
 * `@nestjs/axios`.
 *
 * Note: `error instanceof AxiosError` is only true for this class, not for the
 * class exported by the `axios` package itself.
 */
export class AxiosError<T = any> extends Error {
  static readonly ERR_BAD_OPTION_VALUE = 'ERR_BAD_OPTION_VALUE';
  static readonly ERR_BAD_OPTION = 'ERR_BAD_OPTION';
  static readonly ECONNABORTED = 'ECONNABORTED';
  static readonly ETIMEDOUT = 'ETIMEDOUT';
  static readonly ECONNREFUSED = 'ECONNREFUSED';
  static readonly ERR_NETWORK = 'ERR_NETWORK';
  static readonly ERR_FR_TOO_MANY_REDIRECTS = 'ERR_FR_TOO_MANY_REDIRECTS';
  static readonly ERR_FR_REDIRECTION_FAILURE = 'ERR_FR_REDIRECTION_FAILURE';
  static readonly ERR_DEPRECATED = 'ERR_DEPRECATED';
  static readonly ERR_BAD_RESPONSE = 'ERR_BAD_RESPONSE';
  static readonly ERR_BAD_REQUEST = 'ERR_BAD_REQUEST';
  static readonly ERR_CANCELED = 'ERR_CANCELED';
  static readonly ERR_NOT_SUPPORT = 'ERR_NOT_SUPPORT';
  static readonly ERR_INVALID_URL = 'ERR_INVALID_URL';

  public readonly isAxiosError = true;
  public code?: string;
  public request?: any;
  public response?: AxiosLikeResponse<T>;
  public status?: number;
  public override cause?: unknown;

  // A plain own property, as in axios, so it survives spreading and cloning.
  public config?: InternalAxiosLikeRequestConfig;

  constructor(
    message?: string,
    code?: string,
    config?: InternalAxiosLikeRequestConfig,
    request?: any,
    response?: AxiosLikeResponse<T>,
  ) {
    super(message);
    this.name = 'AxiosError';
    if (code) this.code = code;
    if (config) this.config = config;
    if (request) this.request = request;
    if (response) {
      this.response = response;
      this.status = response.status;
    }
  }

  /**
   * Internal: sets `config` from the request that produced this error (see
   * `buildLazyAxiosConfig`).
   */
  _setLazyConfig(request: HttpInterceptorRequest): void {
    this.config = buildLazyAxiosConfig(request);
  }

  /**
   * Wraps an arbitrary error into an AxiosError, keeping the original error
   * available as the (non-enumerable) `cause`.
   */
  static from<T = any>(
    error: any,
    code?: string,
    config?: InternalAxiosLikeRequestConfig,
    request?: any,
    response?: AxiosLikeResponse<T>,
    // axios' own 6th `AxiosError.from` parameter (`lib/core/AxiosError.js`):
    // arbitrary extra fields merged onto the built error, e.g. `http.js`'s
    // own `buildURL(...)` catch sets `{ url, exists: true }` - see
    // `axios-request.adapter.ts`'s `buildURL` wrapping.
    customProps?: Record<string, unknown>,
  ): AxiosError<T> {
    const axiosError = new AxiosError<T>(
      error?.message ?? String(error),
      code ?? (typeof error?.code === 'string' ? error.code : undefined),
      config,
      request,
      response,
    );
    Object.defineProperty(axiosError, 'cause', {
      value: error,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    if (error?.name) {
      axiosError.name = error.name;
    }
    if (customProps) Object.assign(axiosError, customProps);
    return axiosError;
  }

  /**
   * Matches axios' own `AxiosError.prototype.toJSON()` key set (checked
   * against `node_modules/axios/lib/core/AxiosError.js`): the browser-only
   * fields (`description`/`number`/`fileName`/`lineNumber`/`columnNumber`)
   * are included for the same shape, always `undefined` on Node.js, exactly
   * as they are on a real axios error there too. `config.headers`, when an
   * `AxiosHeaders` instance, is serialised through its own `toJSON()` (a
   * plain object), matching axios' `utils.toJSONObject` - the rest of
   * `config` is shallow-copied rather than deep-cloned (no `redact` support,
   * unlike axios): this is a debugging aid, not something callers should
   * round-trip through `JSON.parse` and rely on exactly.
   */
  toJSON(): Record<string, unknown> {
    const config = this.config
      ? {
          ...this.config,
          headers:
            (this.config.headers as any)?.toJSON?.() ?? this.config.headers,
        }
      : this.config;
    return {
      message: this.message,
      name: this.name,
      description: (this as any).description,
      number: (this as any).number,
      fileName: (this as any).fileName,
      lineNumber: (this as any).lineNumber,
      columnNumber: (this as any).columnNumber,
      stack: this.stack,
      config,
      code: this.code,
      status: this.status,
    };
  }
}

/**
 * Error raised when a request is cancelled through an `AbortSignal` or an
 * axios `CancelToken`. Mirrors axios' `CanceledError` (`code: 'ERR_CANCELED'`,
 * `__CANCEL__: true`), so `axios.isCancel(error)` keeps working.
 */
export class CanceledError<T = any> extends AxiosError<T> {
  public readonly __CANCEL__ = true;

  constructor(
    message?: string | null,
    config?: InternalAxiosLikeRequestConfig,
    request?: any,
  ) {
    super(
      message == null ? 'canceled' : message,
      AxiosError.ERR_CANCELED,
      config,
      request,
    );
    this.name = 'CanceledError';
  }
}

/**
 * When the optional `axios` peer is installed, re-points `AxiosError`'s
 * prototype chain onto axios' own `AxiosError` class, so
 * `error instanceof axios.AxiosError` holds for errors this library throws
 * too - without importing axios' types or values anywhere else (`axios`
 * stays a purely optional peer; this package works fully without it
 * installed).
 *
 * `require('axios')` runs lazily, inside this function, called exactly once
 * below at module load - never as a top-level `import`/`require`, which
 * would throw for every consumer without `axios` installed. A missing or
 * broken `axios` package is swallowed: our own classes are simply left as
 * they are (`instanceof AxiosError` (ours) and `isAxiosError()`/`isCancel()`
 * keep working regardless either way).
 *
 * `CanceledError extends AxiosError` (this package's own hierarchy, set up
 * by `class CanceledError extends AxiosError` below), so re-pointing only
 * `AxiosError.prototype` already makes `canceledError instanceof
 * axios.AxiosError` true too, transitively, through the existing chain
 * (`CanceledError.prototype` -> `AxiosError.prototype` -> now
 * `axios.AxiosError.prototype`). Deliberately *not* also re-pointing
 * `CanceledError.prototype` straight at `axios.CanceledError.prototype`:
 * a prototype chain is linear, so doing that would replace, not extend,
 * `CanceledError.prototype`'s link to `AxiosError.prototype` (ours) -
 * silently dropping this package's own `AxiosError.prototype` methods
 * (`_setLazyConfig`, `toJSON`) for every `CanceledError` instance. The
 * trade-off: `error instanceof axios.CanceledError` (the narrower check)
 * does not hold, only `instanceof axios.AxiosError` (the one axios' own
 * docs recommend, and what `error.isAxiosError`/`isAxiosError()` already
 * duck-type) - use `isCancel()` (from either package; duck-typed, not
 * `instanceof`) to detect cancellation specifically.
 */
function linkOptionalAxiosPeer(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load of an optional peer, see the doc comment above
    const axios = require('axios');
    const theirAxiosError = axios?.AxiosError;
    if (typeof theirAxiosError === 'function' && theirAxiosError.prototype) {
      Object.setPrototypeOf(AxiosError.prototype, theirAxiosError.prototype);
    }
  } catch {
    // `axios` isn't installed (or failed to load) - nothing to link.
  }
}
linkOptionalAxiosPeer();

/**
 * Same contract as `axios.isAxiosError()`.
 */
export function isAxiosError<T = any>(
  payload: unknown,
): payload is AxiosError<T> {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    (payload as { isAxiosError?: unknown }).isAxiosError === true
  );
}

/**
 * Same contract as `axios.isCancel()`.
 */
export function isCancel(value: unknown): value is CanceledError {
  return !!(value && (value as { __CANCEL__?: unknown }).__CANCEL__);
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * A per-request signal, as `toAxiosError` needs it: just enough to tell
 * whether *this* request's own abort fired, and why. `HttpService.
 * executeRequest`'s `RequestAbortSignal` (the object undici is actually
 * given) satisfies this directly - review follow-up (PR #15): checking that,
 * instead of the pre-merge `options.signal` (the caller's own signal, before
 * `resolveSignal` combined it with a `cancelToken` and before it became the
 * one undici was actually handed), so cancellation-vs-timeout detection no
 * longer depends on the `AbortError`/`UND_ERR_ABORTED` fallback working out.
 */
export interface EffectiveAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

/**
 * Set as a per-request `RequestAbortSignal`'s abort `reason` by
 * `HttpService.executeRequest`'s own deadline timer - lets `executeRequest`
 * build the exact axios timeout error (message/code) itself, without
 * `toAxiosError` needing to guess "was this abort a timeout or a
 * cancellation" from whatever undici's rejection happens to look like.
 */
export interface DeadlineTimeoutReason {
  axiosDeadlineTimeout: true;
  timeout: number;
  timeoutErrorMessage?: string;
  clarifyTimeoutError?: boolean;
}

export function isDeadlineTimeoutReason(
  reason: unknown,
): reason is DeadlineTimeoutReason {
  return (
    !!reason &&
    typeof reason === 'object' &&
    (reason as any).axiosDeadlineTimeout === true
  );
}

/**
 * The axios timeout error for a fired deadline timer (see
 * `DeadlineTimeoutReason`): `ECONNABORTED` (or `ETIMEDOUT` with
 * `transitional.clarifyTimeoutError`), `timeoutErrorMessage` if set, else
 * `timeout of ${timeout}ms exceeded` - matching axios exactly (checked
 * against real axios 1.20, `plan/reports/upstream-test-suites.md`).
 */
export function createTimeoutError(
  reason: DeadlineTimeoutReason,
  request: HttpInterceptorRequest,
  requestInfo?: RequestInfo | Record<string, any>,
): AxiosError {
  const error = new AxiosError(
    reason.timeoutErrorMessage || `timeout of ${reason.timeout}ms exceeded`,
    reason.clarifyTimeoutError ? AxiosError.ETIMEDOUT : AxiosError.ECONNABORTED,
    undefined,
    requestInfo,
  );
  error._setLazyConfig(request);
  return error;
}

/**
 * Creates the error axios throws when `validateStatus` rejects a response.
 * `config` is built lazily (see `AxiosError._setLazyConfig`): cheap when
 * nobody reads `error.config`, correctly shaped (raw `url`/`baseURL`/
 * `params`, lower-case `method`, `AxiosHeaders`) when they do.
 */
export function createStatusError<T = any>(
  response: AxiosLikeResponse<T>,
  request?: HttpInterceptorRequest,
): AxiosError<T> {
  const error = new AxiosError<T>(
    `Request failed with status code ${response.status}`,
    response.status >= 400 && response.status < 500
      ? AxiosError.ERR_BAD_REQUEST
      : AxiosError.ERR_BAD_RESPONSE,
    undefined,
    response.request,
    response,
  );
  if (request) error._setLazyConfig(request);
  else error.config = response.config;
  return error;
}

/**
 * The error axios gives for a URL whose protocol it (and this library) can't
 * dispatch (e.g. `tel:`, `ftp:`): `ERR_BAD_REQUEST`, `Unsupported protocol
 * ${protocol}` - checked against real axios 1.20. Unlike every other error
 * here, axios never sets `.request` for this one (the request is rejected
 * before any request object would exist) - matched deliberately.
 */
export function createUnsupportedProtocolError(
  protocol: string,
  request: HttpInterceptorRequest,
): AxiosError {
  const error = new AxiosError(
    `Unsupported protocol ${protocol}`,
    AxiosError.ERR_BAD_REQUEST,
  );
  error._setLazyConfig(request);
  return error;
}

/**
 * The error axios gives for a malformed `http(s):` URL (an embedded null
 * byte, a bare `\n`, ...) - `ERR_INVALID_URL`, `Invalid URL "<normalized
 * url>": missing "//" after protocol` - checked against real axios 1.20
 * (`lib/core/buildFullPath.js`'s `assertValidHttpProtocolURL`). `normalized`
 * is axios' own normalised form of the URL (`malformedHttpProtocolUrl`,
 * `http.service.ts`), used only for the message; `request.url` (the
 * original, un-normalised string) still becomes `error.config.url`, matching
 * axios exactly. Like `createUnsupportedProtocolError`, checked up front,
 * before ever dispatching, so no `.request` is set.
 */
export function createInvalidUrlError(
  normalized: string,
  request: HttpInterceptorRequest,
): AxiosError {
  const error = new AxiosError(
    `Invalid URL ${JSON.stringify(normalized)}: missing "//" after protocol`,
    AxiosError.ERR_INVALID_URL,
  );
  error._setLazyConfig(request);
  return error;
}

/**
 * True when `value` is the kind of `timeout` axios itself rejects before
 * ever using it: a *truthy* value (axios' own check is `if (own('timeout'))`
 * - `0`/`''`/`null`/`undefined`/`NaN` all skip validation entirely, same as
 * "no timeout configured") that `parseInt(value, 10)` can't turn into a
 * number - checked against real axios 1.20 (`lib/adapters/http.js`: `const
 * timeout = parseInt(own('timeout'), 10); if (Number.isNaN(timeout)) {...}`).
 * A numeric string (`'5000'`) is valid, matching axios' own `parseInt` call.
 */
export function isUnparsableTimeout(value: unknown): boolean {
  if (!value) return false;
  return Number.isNaN(parseInt(value as any, 10));
}

/**
 * The error axios gives for a `timeout` it can't parse to an integer
 * (`isUnparsableTimeout`): `ERR_BAD_OPTION_VALUE`, the exact message axios
 * uses - checked against real axios 1.20. Unlike axios (which only reaches
 * this check once the request's socket already exists, so its error also
 * carries `request`), this library checks it up front, before ever
 * dispatching - matching `createUnsupportedProtocolError`'s same precedent
 * of setting no `.request` for a config error caught before any network
 * activity starts.
 */
export function createUnparsableTimeoutError(
  request: HttpInterceptorRequest,
): AxiosError {
  const error = new AxiosError(
    'error trying to parse `config.timeout` to int',
    AxiosError.ERR_BAD_OPTION_VALUE,
  );
  error._setLazyConfig(request);
  return error;
}

/**
 * The error axios gives for a `sensitiveHeaders` that isn't an array of
 * strings (`normalizeSensitiveHeaders`'s validation, `redirect.adapter.ts`):
 * `ERR_BAD_OPTION_VALUE`, axios' exact message - checked against real axios
 * 1.20 (`lib/adapters/http.js`). Like `createUnparsableTimeoutError`, this
 * library checks it up front, before ever dispatching, so no `.request` is
 * set.
 */
export function createInvalidSensitiveHeadersError(
  request: HttpInterceptorRequest,
): AxiosError {
  const error = new AxiosError(
    'sensitiveHeaders must be an array of strings',
    AxiosError.ERR_BAD_OPTION_VALUE,
  );
  error._setLazyConfig(request);
  return error;
}

/**
 * Undici's own argument-validation failures (an invalid header value, an
 * invalid method, ...): axios' Node `http`/`https` transport is far more
 * permissive about some of these (e.g. it silently strips a bare `\n` from a
 * header value that undici instead rejects), so full parity isn't always
 * possible - but the *shape* of the failure should still be an axios-like
 * `ERR_BAD_REQUEST`, not a raw undici `InvalidArgumentError`.
 */
const SYNCHRONOUS_ARG_ERROR_CODES = new Set(['UND_ERR_INVALID_ARG']);

/**
 * Converts an error raised by undici (network failure, timeout, abort, ...)
 * into an axios-compatible error with the same `code` axios would use.
 * Errors that are already axios errors are returned unchanged. `config` is
 * built lazily (see `AxiosError._setLazyConfig`) on every branch, so a
 * request that fails but is never inspected for its config (the common case
 * in a hot path) never pays to build one.
 *
 * `effectiveSignal` is the actual per-request signal undici was dispatched
 * with (see `EffectiveAbortSignal`'s doc comment) - falls back to
 * `request.options.signal` (the pre-merge signal) for any other caller (e.g.
 * `executeAdapter`, which has no `RequestAbortSignal` of its own).
 * `requestInfo`, when given, becomes `error.request` (a network, timeout or
 * cancellation error, never a success) - a lightweight `RequestInfo`
 * instance built once by the caller, never allocated here on a path that
 * doesn't need it.
 */
export function toAxiosError(
  error: any,
  request: HttpInterceptorRequest,
  effectiveSignal?: EffectiveAbortSignal,
  requestInfo?: RequestInfo | Record<string, any>,
): any {
  if (isAxiosError(error)) {
    return error;
  }

  const options: any = request.options || {};
  const signal: EffectiveAbortSignal | undefined =
    effectiveSignal ?? options.signal;

  // Cancellation (AbortController / CancelToken)
  if (
    isCancel(error) ||
    error?.name === 'AbortError' ||
    error?.code === 'UND_ERR_ABORTED' ||
    (signal?.aborted && error === signal.reason)
  ) {
    const message = isCancel(error) ? error.message : undefined;
    const canceled = new CanceledError(message, undefined, requestInfo);
    canceled._setLazyConfig(request);
    Object.defineProperty(canceled, 'cause', {
      value: error,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    return canceled;
  }

  if (error && TIMEOUT_CODES.has(error.code)) {
    // Backstop only: undici's own idle timers (headersTimeout/bodyTimeout),
    // reached when no axios `timeout` was configured at all (so
    // `HttpService.executeRequest`'s own deadline timer never ran) - a
    // "best effort" message, since there's no single configured `timeout`
    // value to quote.
    const timeoutError = AxiosError.from(
      error,
      AxiosError.ECONNABORTED,
      undefined,
      requestInfo,
    );
    timeoutError._setLazyConfig(request);
    timeoutError.name = 'AxiosError';
    const timeout =
      options.timeout || options.headersTimeout || options.bodyTimeout;
    timeoutError.message = options.timeoutErrorMessage
      ? options.timeoutErrorMessage
      : timeout
        ? `timeout of ${timeout}ms exceeded`
        : 'timeout exceeded';
    return timeoutError;
  }

  if (error && typeof error === 'object' && typeof error.code === 'string') {
    // Node network errors (ECONNREFUSED, ENOTFOUND, ECONNRESET, ...) keep
    // their code like in axios; undici socket errors map to the closest
    // axios code, and undici's own argument-validation failures (an invalid
    // header value, an invalid method, ...) become `ERR_BAD_REQUEST`, as
    // axios gives for the requests it does reject synchronously (e.g. an
    // unsupported protocol - see `createUnsupportedProtocolError`).
    const code =
      error.code === 'UND_ERR_SOCKET'
        ? 'ECONNRESET'
        : SYNCHRONOUS_ARG_ERROR_CODES.has(error.code)
          ? AxiosError.ERR_BAD_REQUEST
          : error.code;
    const axiosError = AxiosError.from(error, code, undefined, requestInfo);
    axiosError._setLazyConfig(request);
    return axiosError;
  }

  // Anything else (e.g. errors thrown by user interceptors) passes through
  return error;
}
