import type { Dispatcher } from 'undici';
import type { UrlObject } from 'node:url';
import type { Agent } from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import type { Type } from '@nestjs/common';
import type {
  HttpInterceptor,
  HttpInterceptorFunction,
} from '../interfaces/http-interceptor.interface';
import type { AxiosHeaders } from '../interfaces/axios-headers';
import type {
  AxiosParamsSerializer,
  AxiosProgressEvent,
  AxiosResponseType,
  FormSerializerOptions,
} from '../interfaces/axios-compatible.interface';

export type UndiciURLType = string | URL | UrlObject;

/**
 * A `tough-cookie` `CookieJar` instance, typed structurally loose (not
 * imported from `tough-cookie`) so `HttpModuleOptions` type-checks without
 * the `tough-cookie` types installed - `tough-cookie` and `http-cookie-agent`
 * are optional peers, only required at runtime when `cookieJar` is actually
 * set (see `HttpService.setupDispatcher`/`package.json`).
 */
export type CookieJarOption = object;

/**
 * Same as axios: called before each redirect hop with a mutable `options`
 * object plus `responseDetails` (the 3xx that triggered the hop) and
 * `requestDetails` (the request that just ran).
 */
export type BeforeRedirectFn = (
  options: Record<string, any>,
  responseDetails: { headers: Record<string, any>; statusCode: number },
  requestDetails: {
    url: string;
    method: string;
    headers: Record<string, any>;
  },
) => void;

/**
 * `HttpModule.register()`/`.registerAsync()` options: every axios module
 * option this package maps, the undici options it passes straight through,
 * plus `interceptors`, `global` and `cookieJar`. Deliberately **not**
 * `& any`/`Partial<any>` (plan.md phase 2 "types: axios interop", the
 * owner's "breaking changes are fine before 1.0.0: do it the right way"
 * decision): a typo such as `{ timeuot: 5 }` is a compile error, because
 * this interface has no index signature. Nested option *values* (`headers`,
 * `transformRequest`, ...) stay loosely typed - see
 * `AxiosLikeRequestConfig`'s doc comment for why.
 */
export interface HttpModuleOptions {
  // --- axios options this package maps (see docs/axios-supported-options.md) ---
  /** Prefixed onto every relative request URL, joined like axios (`http://api/v1` + `/users` -> `http://api/v1/users`). */
  baseURL?: string;
  /** A plain object (optionally method-keyed: `{ common: {...}, post: {...}, 'X-Flat': '...' }`), or an `AxiosHeaders` instance. */
  headers?: Record<string, any> | AxiosHeaders;
  params?: any;
  paramsSerializer?: AxiosParamsSerializer;
  auth?: { username: string; password: string };
  /**
   * A total (deadline) timeout, as in axios: from request start until the
   * response body is fully read (for `responseType: 'stream'`, until the
   * response headers arrive). Also maps to undici's `headersTimeout`/
   * `bodyTimeout` as a backstop.
   */
  timeout?: number;
  /** Message used instead of the default `timeout of ${timeout}ms exceeded`, as in axios. */
  timeoutErrorMessage?: string;
  /**
   * `clarifyTimeoutError: true` reports a timeout as `ETIMEDOUT` instead of
   * `ECONNABORTED`; `silentJSONParsing: false` (with `responseType: 'json'`)
   * throws on invalid JSON instead of returning the raw text - both as in
   * axios. Request > `axiosRef.defaults.transitional` > this module option.
   */
  transitional?: {
    clarifyTimeoutError?: boolean;
    silentJSONParsing?: boolean;
    forcedJSONParsing?: boolean;
  };
  /** Follows up to 21 redirects by default, like axios; `0` disables. */
  maxRedirects?: number;
  /**
   * axios >=1.8: `false` makes an absolute request `url` be treated as
   * relative to `baseURL` anyway. Default (`undefined`/`true`): an absolute
   * `url` ignores `baseURL`.
   */
  allowAbsoluteUrls?: boolean;
  beforeRedirect?: BeforeRedirectFn;
  /** Extra header names dropped on a redirect alongside `Authorization`/`Cookie`/`Proxy-Authorization`, as in axios; see `AxiosLikeRequestConfig.sensitiveHeaders`. */
  sensitiveHeaders?: string[];
  validateStatus?: ((status: number) => boolean) | null;
  /** `'document'` is accepted for axios type compatibility (browser-only; not implemented on Node.js). */
  responseType?: AxiosResponseType;
  responseEncoding?: string;
  /** `false` disables response decompression (gzip/br/deflate). Default: decompress. */
  decompress?: boolean;
  /** Response body size limit, enforced while streaming; rejects with `ERR_BAD_RESPONSE`, as in axios. Per-request wins over this module-level value. */
  maxContentLength?: number;
  /** Request body size limit; rejects with `ERR_BAD_REQUEST`, as in axios. Per-request wins over this module-level value. */
  maxBodyLength?: number;
  transformRequest?:
    | ((data: any, headers?: any) => any)
    | Array<(data: any, headers?: any) => any>;
  transformResponse?:
    | ((data: any, headers?: any, status?: number) => any)
    | Array<(data: any, headers?: any, status?: number) => any>;
  /** Pool/keep-alive/`maxSockets`; `httpsAgent`'s TLS options (`ca`/`cert`/`key`/`pfx`/`passphrase`/`rejectUnauthorized`/`servername`/`ciphers`/`minVersion`/`maxVersion`) map onto undici's `Agent({ connect: {...} })`. Module-level only. */
  httpAgent?: Agent;
  httpsAgent?: HttpsAgent;
  /** An explicit proxy, or `false` to disable proxying (including the `HTTP_PROXY`/`HTTPS_PROXY` env vars). */
  proxy?:
    | {
        protocol?: string;
        host: string;
        port: number;
        auth?: { username: string; password: string };
      }
    | false;
  /** `Agent({ connect: { socketPath } })`, cached per path. Also settable per request. */
  socketPath?: string | null;
  /** axios 1.x: `1` (default) or `2` -> `Agent({ allowH2: true })`. Needs a target that speaks HTTP/2 over TLS. */
  httpVersion?: 1 | 2;
  /** Accepted for axios compatibility; undici has no per-session HTTP/2 tuning, so this has no effect. */
  http2Options?: Record<string, unknown>;
  /**
   * A no-op, matching axios itself on Node.js. Accepted (and kept in the
   * types) for axios compatibility only - see `cookieJar` for opt-in cookie
   * storage.
   */
  withCredentials?: boolean;
  /** Ignored (a warning is logged); implement XSRF headers with an interceptor. */
  xsrfCookieName?: string;
  xsrfHeaderName?: string;
  /** Seeded into `axiosRef.defaults.onUploadProgress`; a per-request value wins. */
  onUploadProgress?: (progressEvent: AxiosProgressEvent) => void;
  /** Seeded into `axiosRef.defaults.onDownloadProgress`; a per-request value wins. */
  onDownloadProgress?: (progressEvent: AxiosProgressEvent) => void;
  /** Seeded into `axiosRef.defaults.maxRate`. */
  maxRate?: number | [number, number];
  /** Seeded into `axiosRef.defaults.formSerializer`. */
  formSerializer?: FormSerializerOptions;
  /**
   * Reviver passed to `JSON.parse` by the default (no custom
   * `transformResponse`) JSON decoding, as in axios. Seeded into
   * `axiosRef.defaults.parseReviver`; a per-request value wins.
   */
  parseReviver?: (
    this: any,
    key: string,
    value: any,
    context?: { source?: string },
  ) => any;

  // --- not an axios option: opt-in cookie storage/replay ---
  /**
   * A `tough-cookie` `CookieJar` instance. Opts into cookie storage/replay
   * (unlike axios, which ignores `withCredentials` on Node.js and has no
   * cookie jar of its own). Module-level only; see the class doc in
   * `docs/axios-supported-options.md` ("Cookies: `cookieJar`") for why only
   * an instance (never `true`) is accepted, and why there's no per-request
   * form. `http-cookie-agent`/`tough-cookie` are optional peers, loaded
   * lazily only when this is set.
   */
  cookieJar?: CookieJarOption;

  // --- undici options this package passes straight through ---
  /** Bypasses the axios-style mapping above entirely; wins over `httpAgent`/`httpsAgent`/`proxy`/`socketPath`/`cookieJar`/the proxy env vars. */
  dispatcher?: Dispatcher;
  headersTimeout?: number;
  bodyTimeout?: number;
  /** `0` or `1`; also set from `httpAgent`/`httpsAgent`'s `keepAlive`. */
  pipelining?: 0 | 1;
  /** Pool size; also set from `httpAgent`/`httpsAgent`'s `maxSockets`. */
  connections?: number;
  /** Same spelling undici's own redirect interceptor uses; an alias for `maxRedirects`. */
  maxRedirections?: number;

  // --- library-specific ---
  interceptors?: Array<
    Type<HttpInterceptor> | HttpInterceptor | HttpInterceptorFunction
  >;
  /** Register the module as global, as in `@nestjs/axios` */
  global?: boolean;
}

/**
 * The options object stored under `UNDICI_INSTANCE_TOKEN` and passed to
 * `HttpService`'s constructor: `HttpModuleOptions` minus the two keys
 * `HttpModule.register()`/`.registerAsync()` strip before storing it there
 * (`interceptors` is resolved through Nest DI instead; `global` only
 * affects the `DynamicModule` itself). Mutable (`dispatcher` is assigned
 * onto it once, in `HttpService.setupDispatcher`).
 */
export type UndiciRequestOptionsType = Omit<
  HttpModuleOptions,
  'interceptors' | 'global'
>;
