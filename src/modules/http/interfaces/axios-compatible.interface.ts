import type { Dispatcher } from 'undici';
import type { AxiosHeaders } from './axios-headers';

/**
 * The minimal shape axios itself requires for `signal` (its own
 * `GenericAbortSignal`) - narrower than DOM's `AbortSignal` (`onabort`/
 * `addEventListener`/`removeEventListener` are all optional there). A real
 * `AbortSignal` (what this library's own request path always passes/reads)
 * satisfies this too, so accepting the union costs nothing at runtime; it
 * just also accepts the narrower shape axios' own types use, so a variable
 * typed with axios' `AxiosRequestConfig` is assignable to `AxiosLikeRequestConfig`.
 */
export interface AxiosLikeAbortSignal {
  readonly aborted: boolean;
  onabort?: ((...args: any[]) => any) | null;
  addEventListener?: (...args: any[]) => any;
  removeEventListener?: (...args: any[]) => any;
}

/**
 * Axios-compatible request configuration, and the single type this library
 * uses everywhere a request-level config is accepted: `request(config)`,
 * `request(url, options)`, `get`/`post`/etc.'s `config` argument, axiosRef's
 * promise methods, and the object axiosRef request/response interceptors
 * see. It replaces four overlapping types this package used to export
 * (`AxiosLikeRequestConfig`, `AxiosCompatibleRequestOptions`,
 * `AxiosCompatibleRequestConfig`, `HttpRequestOptions`) - plan.md phase 2
 * "types: axios interop".
 *
 * `url` and `method` are optional here, exactly like axios' own
 * `AxiosRequestConfig`: `request(config)` doesn't actually require `url` at
 * the type level either (a `baseURL` alone, or an interceptor that fills it
 * in, is enough at runtime) - this is what makes `ours.request(config)`
 * assignable from a variable typed with axios' own `AxiosRequestConfig`.
 *
 * `headers` (and the other "shape is whatever the caller wants" fields
 * below) are typed as `Record<string, any> | AxiosHeaders` rather than a
 * hand-derived mirror of axios' own header types: that keeps this type
 * mutually assignable with axios' `AxiosRequestConfig`/`AxiosResponse`
 * header types (including the method-keyed `{ common: {...}, post: {...} }`
 * shape, whose values are themselves `AxiosHeaders` instances) without
 * importing axios' types (`axios` is an optional peer - consumers without it
 * installed must still get useful typechecking). Precise typo-catching is
 * reserved for `HttpModuleOptions`' own keys (see `types/http-module.type.ts`),
 * not header contents, which nobody types out by hand in a way a typo check
 * would catch.
 */
export interface AxiosLikeRequestConfig<D = any> {
  /**
   * A `string`, matching axios' own `AxiosRequestConfig.url?: string`
   * exactly (needed for mutual assignability - plan.md "feat(axiosRef):
   * make it a real axios instance"). A `URL`/`UrlObject` is still accepted
   * everywhere a URL is given *outside* a config object - `request(url,
   * options)`, `get(url, config)`, etc. all take it as a separate,
   * independently-typed first parameter (see `HttpService`/`AxiosRef`) -
   * only `config.url` itself (the single-arg `request(config)` form) is
   * `string`-only, like axios.
   */
  url?: string;
  method?: string;
  baseURL?: string;
  /**
   * axios >=1.8: `false` makes an absolute request `url` be treated as
   * relative to `baseURL` anyway (naively concatenated, exactly like a
   * relative one - see `combineURLs`), instead of replacing it outright.
   * Default (`undefined`/`true`): an absolute `url` ignores `baseURL`.
   */
  allowAbsoluteUrls?: boolean;
  headers?: Record<string, any> | AxiosHeaders;
  params?: any;
  paramsSerializer?: AxiosParamsSerializer;
  /** Request body, serialised like axios (object => JSON, URLSearchParams, FormData, Buffer, string) */
  data?: D;
  timeout?: number;
  /** Message used instead of the default `timeout of ${timeout}ms exceeded`, as in axios. */
  timeoutErrorMessage?: string;
  /**
   * axios' escape hatch for behaviour that will change in a future major.
   * `clarifyTimeoutError` (code `ETIMEDOUT` instead of `ECONNABORTED` on a
   * timeout) is honoured, as is `silentJSONParsing: false` combined with
   * `responseType: 'json'`: a `JSON.parse` failure then throws
   * (`ERR_BAD_RESPONSE`, `response.data` the raw text) instead of silently
   * falling back to it - matching axios' own `strictJSONParsing` exactly
   * (only ever true for `responseType: 'json'`; every other, default
   * parsing path stays silent regardless of this flag, same as axios).
   * `forcedJSONParsing` is accepted for type compatibility but describes the
   * default parsing this library already does unconditionally.
   */
  transitional?: {
    clarifyTimeoutError?: boolean;
    silentJSONParsing?: boolean;
    forcedJSONParsing?: boolean;
  };
  responseType?: AxiosResponseType;
  maxRedirects?: number;
  /** Same spelling undici's own redirect interceptor uses; an alias for `maxRedirects` read when `maxRedirects` itself is unset. */
  maxRedirections?: number;
  /**
   * Same as axios: called before each redirect hop with a mutable
   * `options` object (`protocol`, `hostname`, `port`, `path`, `method`,
   * `headers`) plus `responseDetails` (the 3xx that triggered the hop) and
   * `requestDetails` (the request that just ran). Mutations to `options`
   * are applied to the next hop.
   */
  beforeRedirect?: (
    options: Record<string, any>,
    responseDetails: { headers: Record<string, any>; statusCode: number },
    requestDetails: {
      url: string;
      method: string;
      headers: Record<string, any>;
    },
  ) => void;
  /**
   * Extra header names (case-insensitive) stripped on a redirect alongside
   * the built-in `Authorization`/`Cookie`/`Proxy-Authorization`, as in axios.
   * Unlike the built-in 3 (dropped only on a protocol downgrade or a
   * cross-host redirect that isn't to a subdomain), a header named here is
   * dropped on *any* change of origin, including a subdomain redirect or an
   * http-to-https upgrade - see `shouldStripSensitiveHeaders`/`isSameOrigin`
   * in `redirect.adapter.ts`. Must be an array of strings, or rejects with
   * `ERR_BAD_OPTION_VALUE`, as in axios. Read only while redirects are
   * actually followed (`maxRedirects` isn't `0`).
   */
  sensitiveHeaders?: string[];
  validateStatus?: ((status: number) => boolean) | null;
  auth?: { username: string; password: string };
  decompress?: boolean;
  maxContentLength?: number;
  maxBodyLength?: number;
  transformRequest?:
    | ((data: any, headers?: any) => any)
    | Array<(data: any, headers?: any) => any>;
  transformResponse?:
    | ((data: any, headers?: any, status?: number) => any)
    | Array<(data: any, headers?: any, status?: number) => any>;
  /**
   * axios' reviver for the default `transformResponse`'s `JSON.parse` call
   * (`lib/defaults/index.js`: `JSON.parse(data, own(this, 'parseReviver'))`).
   * Only reaches this library's own default JSON parsing - a custom
   * `transformResponse` replaces default parsing entirely (same as axios: it
   * would have to read `this.parseReviver` itself to honour it).
   */
  parseReviver?: (
    this: any,
    key: string,
    value: any,
    context?: { source?: string },
  ) => any;
  /**
   * axios' `CancelToken` is deprecated in favour of `signal`. Typed `any`
   * (rather than `AxiosCancelTokenLike`, still exported and used at
   * *runtime* by `resolveSignal` in `axios-request.adapter.ts` for its
   * duck-typed `subscribe`/`promise`/`reason` shape) so a real axios
   * `CancelToken` instance - a concrete class with methods this library has
   * no equivalent for (`throwIfRequested`/`unsubscribe`/`toAbortSignal`) -
   * is still assignable both ways (plan.md "feat(axiosRef): make it a real
   * axios instance").
   */
  cancelToken?: any;
  signal?: AbortSignal | AxiosLikeAbortSignal;
  /**
   * Unix domain socket path (module- or request-level). Applied to the
   * dispatcher (`Agent({ connect: { socketPath } })`, cached per path); the
   * URL's host is still used for the `Host` header, as in axios.
   */
  socketPath?: string | null;
  /** A per-request undici `Dispatcher`; wins over any module-built one. */
  dispatcher?: Dispatcher;
  /** Accepted for axios compatibility; a no-op, like axios itself on Node.js. */
  withCredentials?: boolean;
  /**
   * A custom axios-style adapter: `(config) => Promise<AxiosLikeResponse>`,
   * called with the final config instead of dispatching through undici -
   * this is what makes `axios-mock-adapter` work (plan.md "feat(axiosRef):
   * make it a real axios instance"). Its resolved response still runs
   * through `validateStatus`, response interceptors and
   * `transformResponse`, exactly like a real network response. A string
   * adapter name (axios accepts `'http'`/`'xhr'`/`'fetch'`) is accepted for
   * type compatibility but ignored: this library always dispatches through
   * undici.
   */
  adapter?:
    | ((config: any) => Promise<any>)
    | string
    | Array<((config: any) => Promise<any>) | string>;
  /**
   * Called as the request body is written, throttled the same way axios
   * throttles it (at most every ~333ms, plus a final flush) - see
   * `AxiosProgressEvent`. Wraps the body in a counting stream only when this
   * (or `maxRate`) is actually set - see `adapters/axios-progress.adapter.ts`.
   */
  onUploadProgress?: (progressEvent: AxiosProgressEvent) => void;
  /** Called as response body bytes arrive. Works with the buffered response types and with `responseType: 'stream'`. */
  onDownloadProgress?: (progressEvent: AxiosProgressEvent) => void;
  /**
   * Caps transfer throughput in bytes/sec: one number for both directions, or
   * `[upload, download]`. Wraps the request/response body in a throttling
   * stream (see `adapters/axios-progress.adapter.ts`), only when actually
   * set.
   */
  maxRate?: number | [number, number];
  /**
   * axios' options for turning a plain object/array into `FormData`
   * (`postForm`/`putForm`/`patchForm`, and a plain request whose
   * `Content-Type` is explicitly `multipart/form-data` or
   * `application/x-www-form-urlencoded`) - see `toFormData`/`toURLEncodedForm`
   * in real axios.
   */
  formSerializer?: FormSerializerOptions;
  /** Custom fields set by an interceptor (e.g. a retry flag) survive a round trip through `response.config` / `error.config`. */
  [key: string]: any;
}

/**
 * Progress event shape passed to `onUploadProgress`/`onDownloadProgress`,
 * matching axios' own `AxiosProgressEvent` exactly (field for field) so a
 * callback typed against axios' own type still compiles here.
 */
export interface AxiosProgressEvent {
  loaded: number;
  total?: number;
  progress?: number;
  bytes: number;
  rate?: number;
  estimated?: number;
  upload?: boolean;
  download?: boolean;
  event?: unknown;
  lengthComputable: boolean;
}

/** The object a `formSerializer.visitor` appends resolved `[key, value]` pairs to - a real `FormData`, or an internal pairs collector for a url-encoded body. */
export interface FormDataLikeTarget {
  append(name: string, value: any): void;
}

/**
 * A custom visitor called once per own, non-null/undefined key while walking
 * `data` (matching axios' own `SerializerVisitor`): return `true` to also
 * walk `value`'s own keys (only meaningful when `value` is itself a plain
 * object/array), or `false` after appending a leaf value.
 */
export type SerializerVisitor = (
  this: FormDataLikeTarget,
  value: any,
  key: string | number,
  path: Array<string | number> | null,
  helpers: FormDataVisitorHelpers,
) => boolean;

/** Passed as the 4th argument to a custom `formSerializer.visitor`. */
export interface FormDataVisitorHelpers {
  defaultVisitor: SerializerVisitor;
  convertValue: (value: any) => any;
  isVisitable: (value: any) => boolean;
}

/**
 * axios' options for turning an object into `FormData`/a url-encoded body
 * (`lib/helpers/toFormData.js`): a custom `visitor` replaces the default
 * traversal entirely; `dots`/`indexes` control array/nested-object key
 * rendering (see `docs/axios-supported-options.md` for the default,
 * axios-matching bracket/`indexes: false` behaviour); `metaTokens` (default
 * `true`) keeps a trailing `{}` token in a JSON-stringified field's own name;
 * `maxDepth` (default 100) caps nesting, matching axios' own limit.
 */
export interface FormSerializerOptions {
  visitor?: SerializerVisitor;
  dots?: boolean;
  metaTokens?: boolean;
  indexes?: boolean | null;
  maxDepth?: number;
}

/**
 * `AxiosLikeRequestConfig` with `headers` required, matching axios'
 * `InternalAxiosRequestConfig`: the config axiosRef request interceptors,
 * `response.config` and `error.config` carry always has `headers` populated,
 * so `config.headers['Authorization'] = ...` and `config.headers.set(...)`
 * type-check under `strict` without a null check first.
 */
export interface InternalAxiosLikeRequestConfig<
  D = any,
> extends AxiosLikeRequestConfig<D> {
  /**
   * Non-optional (unlike the base type's `headers?:`) and narrowed to just
   * `AxiosHeaders`: axiosRef request interceptors, `response.config` and
   * `error.config` always carry a real `AxiosHeaders` instance here
   * (`buildAxiosConfig`/`buildLazyAxiosConfig` never leave it a plain object
   * or `undefined`), matching axios' own `InternalAxiosRequestConfig.headers:
   * AxiosRequestHeaders` (`RawAxiosRequestHeaders & AxiosHeaders`, also
   * effectively "always a real `AxiosHeaders`" once axios itself has run
   * `dispatchRequest`). This narrowing is what makes `config.headers.set(...)`
   * assignable both ways against axios' own `InternalAxiosRequestConfig`
   * (plan.md "feat(axiosRef): make it a real axios instance" - full
   * `AxiosHeaders` casing/overload parity): a wider `Record<string, any> |
   * AxiosHeaders` union can never be assignable to axios' class-shaped
   * header type (the `Record<string, any>` branch has none of its methods),
   * so the union had to go once this class mirrored axios' own overloads
   * closely enough for the narrower type to type-check on both sides -
   * see `tests/types/usage.ts` case 5/9 and `drop-in.ts`.
   */
  headers: AxiosHeaders;
}

/**
 * Axios-compatible response structure. Structurally assignable to axios'
 * own `AxiosResponse<T, D>` (and vice versa - see the class doc above), so
 * `Observable<AxiosResponse<T>>`-typed code written against `@nestjs/axios`
 * keeps compiling against this library, including `of({...} as AxiosResponse)`
 * test mocks.
 */
export interface AxiosLikeResponse<T = any, D = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, any>;
  config: InternalAxiosLikeRequestConfig<D>;
  request?: any;
}

/**
 * axios `paramsSerializer`: a function or an options object
 */
export type AxiosParamsSerializer =
  | ((params: any) => string)
  | {
      serialize?: (params: any, options?: any) => string;
      /** `value` and, as axios' own `ParamEncoder` also passes, the default encoder to fall back to. */
      encode?: (...args: any[]) => string;
      /** `false` (default): `a[]=1`, `true`: `a[0]=1`, `null`: `a=1` */
      indexes?: boolean | null;
      dots?: boolean;
    };

/**
 * Minimal shape of an axios `CancelToken` (deprecated in axios, still common)
 */
export interface AxiosCancelTokenLike {
  reason?: any;
  promise?: Promise<any>;
  subscribe?(listener: (reason: any) => void): void;
}

/** `'document'`/`'formdata'` are accepted for axios type compatibility (browser-only; not implemented on Node.js). */
export type AxiosResponseType =
  'json' | 'text' | 'stream' | 'arraybuffer' | 'blob' | 'document' | 'formdata';

/**
 * Alias for `AxiosLikeRequestConfig`, named to match axios' own
 * `AxiosRequestConfig` - so migrating code can use this instead of importing
 * `axios` just for the type (plan.md phase 3 "Trim the public API": "consider
 * exporting AxiosResponse / AxiosRequestConfig ... aliases, so migrating
 * users can drop the axios import").
 */
export type AxiosRequestConfig<D = any> = AxiosLikeRequestConfig<D>;

/** Alias for `AxiosLikeResponse`, named to match axios' own `AxiosResponse` - see `AxiosRequestConfig`'s doc comment above. */
export type AxiosResponse<T = any, D = any> = AxiosLikeResponse<T, D>;
