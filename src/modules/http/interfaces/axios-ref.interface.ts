import type {
  AxiosLikeRequestConfig,
  AxiosLikeResponse,
  AxiosParamsSerializer,
  AxiosProgressEvent,
  AxiosResponseType,
  FormSerializerOptions,
  InternalAxiosLikeRequestConfig,
} from './axios-compatible.interface';
import type { AxiosHeaders } from './axios-headers';

/**
 * Options accepted as the 3rd argument to `interceptors.<request|response>.use()`,
 * matching axios: `runWhen` skips the interceptor for a given config, and
 * `synchronous` is a hint that the handler never returns a Promise.
 */
export interface AxiosInterceptorOptions {
  synchronous?: boolean;
  runWhen?: ((config: InternalAxiosLikeRequestConfig) => boolean) | null;
}

/**
 * Axios-style interceptor manager interface
 */
export interface AxiosInterceptorManager<T> {
  /**
   * Add an interceptor
   * @param onFulfilled Success handler
   * @param onRejected Error handler
   * @param options `runWhen` / `synchronous`, as in axios
   * @returns Interceptor ID for later ejection
   */
  use(
    onFulfilled?: ((value: T) => T | Promise<T>) | null,
    onRejected?: ((error: any) => any) | null,
    options?: AxiosInterceptorOptions,
  ): number;

  /**
   * Remove an interceptor by ID
   * @param id The interceptor ID returned by use()
   */
  eject(id: number): void;

  /**
   * Clear all interceptors
   */
  clear(): void;
}

/**
 * Subset of axios' `instance.defaults` that is honoured at request time,
 * mirroring `axios.create(moduleOptions).defaults`: `HttpModule.register()`/
 * `.registerAsync()` options seed this object once, at `HttpService`
 * construction (see `createAxiosRefDefaults`), and from then on it is the
 * single source of truth for these fields - a runtime mutation (e.g.
 * `defaults.headers.common['Authorization'] = token`, `defaults.timeout =
 * 5000`) applies to every subsequent request made through the HttpService
 * (or through `axiosRef` directly), and always wins over the original
 * module-level value. Per-request config still wins over `defaults` for any
 * field it sets, exactly like axios' own `mergeConfig(this.defaults,
 * config)`. See docs/axios-supported-options.md ("Precedence").
 */
export interface AxiosRefDefaults<D = any> {
  baseURL?: string;
  timeout?: number;
  maxRedirects?: number;
  /**
   * axios >=1.8: `false` makes an absolute request `url` be treated as
   * relative to `baseURL` anyway. See `AxiosLikeRequestConfig
   * .allowAbsoluteUrls`.
   */
  allowAbsoluteUrls?: boolean;
  /** See `AxiosLikeRequestConfig.auth`. */
  auth?: { username: string; password: string };
  /** See `AxiosLikeRequestConfig.maxContentLength`. */
  maxContentLength?: number;
  /** See `AxiosLikeRequestConfig.maxBodyLength`. */
  maxBodyLength?: number;
  /** See `AxiosLikeRequestConfig.timeoutErrorMessage`. */
  timeoutErrorMessage?: string;
  /** See `AxiosLikeRequestConfig.decompress`. */
  decompress?: boolean;
  /** See `AxiosLikeRequestConfig.socketPath`. */
  socketPath?: string | null;
  /** See `AxiosLikeRequestConfig.beforeRedirect`. */
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
   * Typed as `AxiosHeaders` per bucket, matching axios' own
   * `AxiosInstance.defaults.headers` (`HeadersDefaults & { [key: string]:
   * AxiosHeaderValue }` - an index signature that only a header-value-shaped
   * type, not a plain `Record<string, ...>`, can satisfy). At *runtime*
   * these stay plain objects, not real `AxiosHeaders` instances
   * (`createAxiosRefDefaults`/`mergeAxiosDefaults` in `axios-ref.factory.ts`
   * cast them): the per-request header-merge cache
   * (`snapshotHeaderSource` in `axios-request.adapter.ts`) requires
   * `isPlainObject()`, and building 8 real `AxiosHeaders` instances (Proxy
   * wrap included) per service/`create()` call would be needlessly slow for
   * no behavioural gain (bracket/`.set()` mutation and case-insensitive
   * lookup already work on the plain object through this class' own
   * `set()`/`get()`, which don't require `this` to be a real `AxiosHeaders`).
   * A type-only cast, in other words: consumers and TypeScript both see
   * `AxiosHeaders`, index/bracket access behaves the same either way,
   * `Object.keys()`/spread/`for...in` (what `flatDefaultHeaders`, the
   * cache's `snapshotHeaderSource`, and `mergeHeaders` all actually use)
   * work identically on the real plain object underneath.
   */
  headers: {
    common: AxiosHeaders;
    get: AxiosHeaders;
    delete: AxiosHeaders;
    head: AxiosHeaders;
    options: AxiosHeaders;
    post: AxiosHeaders;
    put: AxiosHeaders;
    patch: AxiosHeaders;
  };
  params?: any;
  paramsSerializer?: AxiosParamsSerializer;
  validateStatus?: ((status: number) => boolean) | null;
  responseType?: AxiosResponseType;
  transformRequest?:
    | ((data: any, headers?: any) => any)
    | Array<(data: any, headers?: any) => any>;
  transformResponse?:
    | ((data: any, headers?: any, status?: number) => any)
    | Array<(data: any, headers?: any, status?: number) => any>;
  /**
   * A function adapter (called with the final config instead of dispatching
   * through undici - see `AxiosLikeRequestConfig.adapter`) or a string
   * adapter name (`'http'`/`'xhr'`/`'fetch'`/...), accepted for type
   * compatibility but ignored: this library always dispatches through
   * undici.
   */
  adapter?:
    | ((config: any) => Promise<any>)
    | string
    | Array<((config: any) => Promise<any>) | string>;
  /** Accepted for axios compatibility; a no-op, like axios itself on Node.js. */
  withCredentials?: boolean;
  /** See `AxiosLikeRequestConfig.onUploadProgress`. */
  onUploadProgress?: (progressEvent: AxiosProgressEvent) => void;
  /** See `AxiosLikeRequestConfig.onDownloadProgress`. */
  onDownloadProgress?: (progressEvent: AxiosProgressEvent) => void;
  /** See `AxiosLikeRequestConfig.maxRate`. */
  maxRate?: number | [number, number];
  /** See `AxiosLikeRequestConfig.formSerializer`. */
  formSerializer?: FormSerializerOptions;
  /** See `AxiosLikeRequestConfig.parseReviver`. */
  parseReviver?: (
    this: any,
    key: string,
    value: any,
    context?: { source?: string },
  ) => any;
  /** See `AxiosLikeRequestConfig.sensitiveHeaders`. */
  sensitiveHeaders?: string[];
  /** See `AxiosLikeRequestConfig.transitional`. */
  transitional?: {
    clarifyTimeoutError?: boolean;
    silentJSONParsing?: boolean;
    forcedJSONParsing?: boolean;
  };
}

/**
 * Axios-compatible reference: a real, callable axios instance, mirroring
 * axios' own `AxiosInstance` (plan.md "feat(axiosRef): make it a real axios
 * instance") - `axiosRef(config)`/`axiosRef(url, config)` resolve like
 * `axios(...)` (axios-retry relies on this), plus `getUri`, `create`,
 * `postForm`/`putForm`/`patchForm` and `query`.
 */
export interface AxiosRef {
  <T = any, D = any>(
    config: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  <T = any, D = any>(
    url: string,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;

  interceptors: {
    request: AxiosInterceptorManager<InternalAxiosLikeRequestConfig>;
    response: AxiosInterceptorManager<AxiosLikeResponse>;
  };
  defaults: AxiosRefDefaults;
  getUri(config?: AxiosLikeRequestConfig): string;
  /** A new instance sharing this one's transport/dispatcher, with its own `interceptors` and `defaults` merged from this one - like `axios.create(config)`. */
  create(config?: AxiosLikeRequestConfig): AxiosRef;
  request<T = any, D = any>(
    config: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  get<T = any, D = any>(
    url: string,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  delete<T = any, D = any>(
    url: string,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  head<T = any, D = any>(
    url: string,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  options<T = any, D = any>(
    url: string,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  post<T = any, D = any>(
    url: string,
    data?: D,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  put<T = any, D = any>(
    url: string,
    data?: D,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  patch<T = any, D = any>(
    url: string,
    data?: D,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  postForm<T = any, D = any>(
    url: string,
    data?: D,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  putForm<T = any, D = any>(
    url: string,
    data?: D,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  patchForm<T = any, D = any>(
    url: string,
    data?: D,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
  /** The HTTP `QUERY` method (axios >=1.13). */
  query<T = any, D = any>(
    url: string,
    data?: D,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>>;
}

/**
 * Alias for `AxiosRef`, named to match axios' own `AxiosInstance` - so code
 * migrating from `@nestjs/axios`/axios that types a variable as
 * `AxiosInstance` can use this instead of importing `axios` just for the
 * type (plan.md phase 3 "Trim the public API": "consider exporting ...
 * AxiosInstance-compatible aliases").
 */
export type AxiosInstance = AxiosRef;
