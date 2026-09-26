import { firstValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AxiosLikeRequestConfig,
  AxiosLikeResponse,
  AxiosRef,
  AxiosRefDefaults,
  InternalAxiosLikeRequestConfig,
} from '../interfaces';
import type { AxiosInterceptorStore } from './axios-interceptor.adapter';
import { createInterceptorStore } from './axios-interceptor.adapter';
import { SUPPORTED_CONTENT_ENCODINGS } from './axios-response-type.adapter';
import {
  METHOD_HEADER_KEYS,
  buildFormRequestConfig,
  buildURL,
  combineURLs,
  isAbsoluteURL,
  isAxiosRequestConfig,
  mergeHeaders,
} from './axios-request.adapter';
import { LIBRARY_VERSION } from '../../../version';

/** axios' default `Accept`, unchanged since it isn't per-service configurable. */
const DEFAULT_ACCEPT = 'application/json, text/plain, */*';

/**
 * axios sends `axios/<version>`; this library names itself the same way so
 * requests aren't silently anonymous. It's still just a default: override it
 * per service the axios way, `axiosRef.defaults.headers.common['User-Agent']
 * = '...'`, or per module/request headers (see `createAxiosRefDefaults`).
 */
const DEFAULT_USER_AGENT = `nestjs-axios-undici/${LIBRARY_VERSION}`;

/**
 * The `axiosRef.defaults`/`create(config)` fields merged directly (later
 * wins), as opposed to `headers` (merged per-bucket - see
 * `mergeAxiosDefaults`).
 */
const DEFAULTS_PASSTHROUGH_KEYS = [
  'baseURL',
  'timeout',
  'maxRedirects',
  'params',
  'paramsSerializer',
  'validateStatus',
  'responseType',
  'transformRequest',
  'transformResponse',
  'adapter',
  'withCredentials',
  'onUploadProgress',
  'onDownloadProgress',
  'maxRate',
  'formSerializer',
  'parseReviver',
  'sensitiveHeaders',
  'transitional',
] as const;

/**
 * The context one axios-like instance (the top-level `axiosRef`, or one
 * returned by `axiosRef.create()`) dispatches requests with: its own
 * `defaults` and interceptor stores. Every instance shares the same `host`
 * (an `HttpService`) - and so the same transport/dispatcher, module-level
 * generic interceptors and redirect handling - but each has independent
 * `defaults`/`interceptors`, exactly like `axios.create()`.
 */
export interface AxiosInstanceContext {
  defaults: AxiosRefDefaults;
  requestInterceptors: AxiosInterceptorStore<InternalAxiosLikeRequestConfig>;
  responseInterceptors: AxiosInterceptorStore<AxiosLikeResponse>;
}

/**
 * The single point where an axios-like instance (built by `createAxiosRef`)
 * reaches back into `HttpService` to actually run a request: builds the
 * axios config for `config` against `context` (its own `defaults`/
 * interceptors), runs the axiosRef pipeline or the fast path as appropriate,
 * and dispatches through the shared transport. A plain, non-overloaded
 * method (unlike the public, DI-facing `HttpService.request()`, which always
 * uses the service's own `defaults`/interceptors) so there's no ambiguity
 * about which overload a structural caller like this one resolves against.
 */
export interface AxiosRefHost {
  dispatchAxiosConfig<T = any, D = any>(
    config: AxiosLikeRequestConfig<D>,
    context: AxiosInstanceContext,
  ): Observable<AxiosLikeResponse<T, D>>;
}

/**
 * Merges a `headers` source (module options, or a `create(config)` override)
 * into `axiosRef.defaults.headers`'s bucketed shape: method buckets
 * (`common`/`get`/.../`patch`) merge per bucket (case-insensitively, later
 * wins), and any flat, non-bucket key (e.g. `{ 'X-Foo': 'v' }`) folds into
 * `common` - the same "applies to every method" meaning a flat key has
 * everywhere else in this library (see `flatDefaultHeaders` in
 * `axios-request.adapter.ts`).
 */
function mergeHeaderDefaults(
  base: AxiosRefDefaults['headers'],
  override?: Record<string, any>,
): AxiosRefDefaults['headers'] {
  // Plain objects at runtime (see the type-only-cast note on
  // `AxiosRefDefaults.headers`'s doc comment) - `as unknown as
  // AxiosRefDefaults['headers']` here is that cast, applied once per
  // service/`create()` call, never per request.
  const merged = {
    common: { ...base.common },
    get: { ...base.get },
    delete: { ...base.delete },
    head: { ...base.head },
    options: { ...base.options },
    post: { ...base.post },
    put: { ...base.put },
    patch: { ...base.patch },
  } as unknown as Record<string, Record<string, any>>;
  if (override) {
    const flat: Record<string, any> = {};
    for (const key of Object.keys(override)) {
      const value = override[key];
      if (METHOD_HEADER_KEYS.has(key)) {
        merged[key] = mergeHeaders(merged[key], value);
      } else if (value !== undefined) {
        flat[key] = value;
      }
    }
    if (Object.keys(flat).length > 0) {
      merged.common = mergeHeaders(merged.common, flat);
    }
  }
  return merged as unknown as AxiosRefDefaults['headers'];
}

/**
 * Merges `override` (module options at setup, or a `create(config)`
 * argument) onto `base` `axiosRef.defaults`, the way axios' own
 * `mergeConfig(this.defaults, config)` builds a child instance's defaults:
 * `headers` merges per-bucket (`mergeHeaderDefaults`), everything else in
 * `DEFAULTS_PASSTHROUGH_KEYS` overrides outright when present in `override`.
 */
function cloneDefault(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) return { ...value };
  }
  return value;
}

function mergeAxiosDefaults(
  base: AxiosRefDefaults,
  override?: Record<string, any>,
): AxiosRefDefaults {
  const merged: AxiosRefDefaults = {
    ...base,
    headers: mergeHeaderDefaults(base.headers, override?.headers),
  };
  // Like axios' `mergeConfig`, object and array values are copied, so a
  // later in-place change to the parent's (or the override's) `params` or
  // `transformRequest` doesn't leak into the new instance.
  for (const key of DEFAULTS_PASSTHROUGH_KEYS) {
    const value =
      override && override[key] !== undefined
        ? override[key]
        : (base as any)[key];
    (merged as any)[key] = cloneDefault(value);
  }
  return merged;
}

/**
 * Creates the `defaults` object exposed as `httpService.axiosRef.defaults`
 * (and, by extension, every `axiosRef.create()`-derived instance's own
 * `defaults`, merged from it - see `mergeAxiosDefaults`).
 *
 * `HttpModule.register()`/`.registerAsync()` options seed this once, at
 * `HttpService` construction, exactly like `axios.create(moduleOptions)`
 * seeds a real axios instance's `defaults` - from then on `defaults` is the
 * single source of truth (a runtime mutation always wins over the original
 * module-level value it started out equal to); see the class doc on
 * `AxiosRefDefaults`.
 */
export function createAxiosRefDefaults(
  moduleOptions?: Record<string, any>,
): AxiosRefDefaults {
  // axios' default request headers, matched as closely as the docs allow
  // (see docs/axios-supported-options.md). Seeded into `headers.common` so
  // they're visible and overridable through `axiosRef.defaults` the same way
  // axios' own defaults are.
  const common: Record<string, string> = {
    Accept: DEFAULT_ACCEPT,
    'User-Agent': DEFAULT_USER_AGENT,
  };
  // Only advertised when decompression is on for this service (module-level
  // `decompress`, default true) - no point asking a server for a body this
  // library won't decompress.
  if (moduleOptions?.decompress !== false) {
    common['Accept-Encoding'] = SUPPORTED_CONTENT_ENCODINGS;
  }

  // Plain objects at runtime - see the type-only-cast note on
  // `AxiosRefDefaults.headers`'s doc comment.
  const base = {
    headers: {
      common,
      get: {},
      delete: {},
      head: {},
      options: {},
      post: {},
      put: {},
      patch: {},
    },
    // Present as own keys (`undefined`, functionally inert - every `?? `/
    // `||`/truthiness check this library has for these already treats
    // `undefined` as "unset") purely so `axiosRef.defaults` has the same own
    // keys axios' real `defaults` object always does (`tests/compat/
    // api-surface.spec.ts`). Deliberately *not* seeded with axios' own
    // default *values* here (e.g. a real `validateStatus`/`transformRequest`
    // function): doing that would make `hasAxiosPipeline` (http.service.ts)
    // think every service has a custom adapter/transform, forcing every
    // plain request through the slower axios pipeline - a real regression
    // against the "HttpService regression check" budget.
    adapter: undefined,
    transformRequest: undefined,
    transformResponse: undefined,
    timeout: undefined,
    validateStatus: undefined,
  } as unknown as AxiosRefDefaults;

  return mergeAxiosDefaults(base, moduleOptions);
}

/**
 * axios' own `getUri(config)`: the full URL a request would be sent to,
 * `baseURL` and `params` applied, without actually sending it.
 */
function getUri(
  defaults: AxiosRefDefaults,
  config?: AxiosLikeRequestConfig,
): string {
  const rawUrl = config?.url ?? '';
  let url = typeof rawUrl === 'string' ? rawUrl : String(rawUrl);
  const baseURL = config?.baseURL ?? defaults.baseURL;
  if (url && baseURL && !isAbsoluteURL(url)) {
    url = combineURLs(baseURL, url);
  }
  const params = config?.params ?? defaults.params;
  if (params) {
    url = buildURL(
      url,
      params,
      config?.paramsSerializer ?? defaults.paramsSerializer,
    );
  }
  return url;
}

type BodylessMethod = 'GET' | 'DELETE' | 'HEAD' | 'OPTIONS';
type BodyMethod = 'POST' | 'PUT' | 'PATCH' | 'QUERY';
type FormMethod = 'POST' | 'PUT' | 'PATCH';

/**
 * Builds the axios-instance-like `axiosRef`: callable
 * (`axiosRef(config)`/`axiosRef(url, config)`, axios-retry relies on this),
 * `request`/`get`/.../`patch`/`postForm`/.../`query`, `getUri`, `create`
 * (a new instance sharing `host`'s transport, with its own `interceptors`
 * and `defaults` merged from this one), working `interceptors`
 * (eject/clear), and live `defaults`.
 *
 * Every method dispatches through the single `host.dispatchAxiosConfig`
 * entry point (like axios' own `Axios.prototype.get`/`post`/... are all thin
 * wrappers around `Axios.prototype.request` - see `core/Axios.js`), so
 * `create()`'s returned instance needs nothing from `HttpService` beyond
 * that one method.
 */
export function createAxiosRef(
  host: AxiosRefHost,
  defaults: AxiosRefDefaults,
  requestInterceptors: AxiosInterceptorStore<InternalAxiosLikeRequestConfig>,
  responseInterceptors: AxiosInterceptorStore<AxiosLikeResponse>,
): AxiosRef {
  const context: AxiosInstanceContext = {
    defaults,
    requestInterceptors,
    responseInterceptors,
  };

  const dispatch = <T = any, D = any>(
    config: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>> =>
    firstValueFrom(host.dispatchAxiosConfig<T, D>(config, context));

  const bodyless =
    (method: BodylessMethod) =>
    <T = any, D = any>(url: string, config?: AxiosLikeRequestConfig<D>) =>
      dispatch<T, D>({ ...config, url, method });
  const withBody =
    (method: BodyMethod) =>
    <T = any, D = any>(
      url: string,
      data?: D,
      config?: AxiosLikeRequestConfig<D>,
    ) =>
      dispatch<T, D>({ ...config, url, method, data });
  const withForm =
    (method: FormMethod) =>
    <T = any, D = any>(
      url: string,
      data?: D,
      config?: AxiosLikeRequestConfig<D>,
    ) =>
      dispatch<T, D>(
        buildFormRequestConfig(
          method,
          url,
          data,
          config,
          defaults.formSerializer,
        ),
      );

  // A real function, like axios' own `bind(Axios.prototype.request, context)`
  // - `axiosRef(config)`/`axiosRef(url, config)` resolve like `axios(...)`
  // (axios-retry calls the instance directly). Built once per HttpService
  // (and once per `create()`), never per request.
  const axiosRefFn = function axiosRef<T = any, D = any>(
    urlOrConfig: string | AxiosLikeRequestConfig<D>,
    config?: AxiosLikeRequestConfig<D>,
  ): Promise<AxiosLikeResponse<T, D>> {
    const resolvedConfig: AxiosLikeRequestConfig<D> = isAxiosRequestConfig(
      urlOrConfig,
    )
      ? urlOrConfig
      : { ...config, url: urlOrConfig };
    return dispatch<T, D>(resolvedConfig);
  } as AxiosRef;

  Object.assign(axiosRefFn, {
    interceptors: {
      request: requestInterceptors,
      response: responseInterceptors,
    },
    defaults,
    request: dispatch,
    get: bodyless('GET'),
    delete: bodyless('DELETE'),
    head: bodyless('HEAD'),
    options: bodyless('OPTIONS'),
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
    query: withBody('QUERY'),
    postForm: withForm('POST'),
    putForm: withForm('PUT'),
    patchForm: withForm('PATCH'),
    getUri: (config?: AxiosLikeRequestConfig) => getUri(defaults, config),
    create: (config?: AxiosLikeRequestConfig): AxiosRef =>
      createAxiosRef(
        host,
        mergeAxiosDefaults(defaults, config as Record<string, any> | undefined),
        createInterceptorStore<InternalAxiosLikeRequestConfig>(),
        createInterceptorStore<AxiosLikeResponse>(),
      ),
  });

  return axiosRefFn;
}
