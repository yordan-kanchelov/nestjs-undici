# HttpService

`HttpService` makes the HTTP requests. Its methods match the `HttpService` from `@nestjs/axios`. They return an RxJS `Observable` that emits an axios-compatible response, and non-2xx responses are emitted as axios errors.

```typescript
import { Injectable } from '@nestjs/common';
import { HttpService } from 'nestjs-axios-undici';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class UsersService {
  constructor(private readonly httpService: HttpService) {}

  async getUser(id: number) {
    const { data } = await firstValueFrom(this.httpService.get<User>(`https://api.example.com/users/${id}`));
    return data;
  }
}
```

See [Making requests](/docs/guides/making-requests.md) and [Error handling](/docs/guides/error-handling.md) for usage.

## Request methods

All methods return `Observable<AxiosLikeResponse<T>>`.

| Method | Description |
|--------|-------------|
| `request<T>(config)` | Axios call form: `{ url, method, params, data, headers, ... }`. |
| `request<T>(url, options?)` | Undici call form: `url` plus [undici request options](https://github.com/nodejs/undici#undicirequesturl-options-promise) and the axios per-request options. |
| `get<T>(url, config?)` | |
| `delete<T>(url, config?)` | |
| `head<T>(url, config?)` | |
| `options<T>(url, config?)` | |
| `post<T>(url, data?, config?)` | |
| `put<T>(url, data?, config?)` | |
| `patch<T>(url, data?, config?)` | |
| `query<T>(url, data?, config?)` | The HTTP `QUERY` method (matching `@nestjs/axios` 12 / axios ≥1.16). |
| `postForm<T>(url, data?, config?)` | Sent as `multipart/form-data`, matching axios' own `postForm`: a `FormData`/`form-data` instance goes through as-is, a plain object is converted to one. An explicit `Content-Type` header doesn't change this, and neither does axios'. |
| `putForm<T>(url, data?, config?)` | Same as `postForm`. |
| `patchForm<T>(url, data?, config?)` | Same as `postForm`. |

`config` accepts the axios per-request options (`headers`, `params`, `paramsSerializer`, `baseURL`, `auth`, `timeout`, `signal`, `cancelToken`, `responseType`, `validateStatus`, `maxRedirects`, `maxContentLength`, ...) as well as undici request options such as `dispatcher`. See [Request config](/docs/axios-supported-options.md#request-config).

## Response

| Property | Description |
|----------|-------------|
| `data` | Parsed body: JSON for JSON content types, a string for text, a `Buffer` for binary content. |
| `status`, `statusText` | HTTP status code and text. |
| `headers` | Response headers, with lower-case names. |
| `config` | The request config: `url` and `baseURL` as given (not combined), `params` as given, a lower-case `method`, `headers` as `AxiosHeaders` (case-insensitive lookup, but `toJSON()`/iteration report the casing each header was first set with, matching axios), `data` (the serialised body), `timeout`, `validateStatus`, and any custom field set by a request interceptor. Built lazily, only when read, unless axiosRef interceptors or a `transformRequest`/`transformResponse` are in play. |

## `axiosRef`

A real, callable axios instance, for code written against `httpService.axiosRef` in `@nestjs/axios`. It stands in for `AxiosInstance`:

- **Callable**: `axiosRef(config)` and `axiosRef(url, config)` both resolve like `axios(...)` (this is what libraries like `axios-retry` rely on).
- `axiosRef.request(config)`, `get`, `delete`, `head`, `options`, `post`, `put`, `patch`, `postForm`, `putForm`, `patchForm`, `query`, each returning a `Promise` of the response.
- `axiosRef.getUri(config?)`: the full URL a request would be sent to (`baseURL` + `params` applied), without sending it.
- `axiosRef.create(config?)`: a new axios-like instance that shares this `HttpService`'s transport/dispatcher, module-level interceptors and redirect handling, but has its own `interceptors` and its own `defaults`. These are merged from this one, the way `axios.create()` merges from the instance it's called on. See below.
- `axiosRef.interceptors.request.use(onFulfilled, onRejected, options?)` / `axiosRef.interceptors.response.use(...)`, returning an id for `eject(id)`; `clear()` removes all of them. `options.runWhen`/`options.synchronous` work like axios.
- `axiosRef.defaults`: see below.

```typescript
this.httpService.axiosRef.defaults.headers.common['Authorization'] = `Bearer ${token}`;
const { data } = await this.httpService.axiosRef.get('https://api.example.com/users');

// axios-retry, axios-mock-adapter and similar libraries that expect a real
// axios instance work directly against axiosRef:
axiosRetry(this.httpService.axiosRef, { retries: 3 });
new MockAdapter(this.httpService.axiosRef);
```

### `axiosRef.defaults`

Covers the axios defaults this library honours at request time: `baseURL`, `headers` (`common`/`get`/`post`/.../`patch`), `timeout`, `maxRedirects`, `params`, `paramsSerializer`, `validateStatus`, `responseType`, `transformRequest`, `transformResponse`, `adapter` and `withCredentials` (accepted, a no-op). `HttpModule.register()`/`.registerAsync()` options seed `defaults` once, at construction, exactly like `axios.create(moduleOptions)` seeds a real axios instance's `defaults`. From then on, **`defaults` is the single source of truth**. A runtime mutation, such as `axiosRef.defaults.headers.common['X'] = '...'` or `axiosRef.defaults.timeout = 5000`, applies to every later request and always wins over the module-level value it started out equal to. Mutating the object passed to `register()` afterwards, or `httpService.undiciRef`, no longer has any effect. Precedence is **request config > `axiosRef.defaults` > module options** for every one of these fields, uniformly. This replaces an earlier, narrower rule where module `headers` specifically always won over `axiosRef.defaults`. See the migration guide.

`axiosRef.create(config)` merges `config` onto the parent's current `defaults` the way `axios.create()`/`mergeConfig` does: `headers` per bucket (a header set for one method overrides the parent's for that bucket only), everything else overriding outright when `config` sets it. The child's `defaults` (and its `interceptors`) are then fully independent of the parent's. Mutating one never affects the other. Both still share the same underlying transport/dispatcher and the module's generic interceptors/redirect handling.

### Function `adapter`

`config.adapter`/`axiosRef.defaults.adapter` may be a function: `(config) => Promise<response>`, called with the final, fully-resolved config instead of dispatching through undici. Its resolved response still runs through `validateStatus`, `transformResponse` and any response interceptors, exactly like a real network response. This is what makes [`axios-mock-adapter`](https://github.com/ctimmerm/axios-mock-adapter) work unmodified against `axiosRef`. A string adapter name (`'http'`/`'xhr'`/`'fetch'`) or an array is accepted for type compatibility but ignored. This library always dispatches through undici when no function adapter is set.

```typescript
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(httpService.axiosRef);
mock.onGet('/users/1').reply(200, { id: 1, name: 'Ada' });
```

See [`axiosRef`](/docs/axios-supported-options.md#axiosref) for the remaining differences from a real axios instance (mainly `AxiosHeaders`-adjacent, and one TypeScript-only generics gap).

## `addInterceptor(interceptor)`

Adds a native interceptor (a function or an object with an `intercept()` method) after the existing ones. It returns nothing; to remove interceptors later, use `axiosRef.interceptors` and `eject()`.

```typescript
this.httpService.addInterceptor((request, next) => {
  request.options.headers = { ...request.options.headers, 'X-Request-ID': randomUUID() };
  return next.handle(request);
});
```

See [Interceptors](/docs/guides/interceptors.md).

## `interceptorCount`

Read-only. The number of *module-registered* interceptors in this service's chain, meaning native interceptors added through `addInterceptor()` or the module's `interceptors` option. It does **not** count `axiosRef`'s own request/response interceptors. Those are a separate chain. See [`axiosRef`](#axiosref) above. Real axios has no combined "how many interceptors" property either.

> **Breaking change:** earlier versions added 1 for a phantom "axios response adapter" that no longer exists, and separately counted `axiosRef` interceptors. `interceptorCount` is now the plain length of the native interceptor chain.

## Dispatchers and connection lifecycle

Every `HttpService` owns an undici `Dispatcher`, built from this package's own undici copy, so it's never affected by anything else in the process that changes undici's *global* dispatcher:

1. A `dispatcher` given on a specific request always wins.
2. Otherwise, a request-level `socketPath` uses a cached per-path `Agent`.
3. Otherwise, the module's own dispatcher applies: an explicit `dispatcher` passed to `register()`/`registerAsync()`, or one this library built for you from `proxy`, `cookieJar`, `socketPath`, `httpVersion: 2`, or `httpAgent`/`httpsAgent` options.
4. Otherwise, this service's **per-service default `Agent`**, built once, at construction, from this package's own undici copy (`allowH2: false`). HTTP/2 needs `httpVersion: 2`, which builds its own dispatcher at step 3 instead.

> **Breaking change:** earlier versions fell back to undici's *global* dispatcher (`undici.getGlobalDispatcher()`) at step 4 instead of a dispatcher of their own. That meant `undici.setGlobalDispatcher()` elsewhere in the process could silently redirect this library's own traffic, and, on Node.js versions that bundle their own copy of undici, a plain request could end up on a completely different connection pool than the one this library's own undici copy manages. Neither is true any more. `undici.setGlobalDispatcher()` has **no effect** on requests made through `HttpService` unless a dispatcher is explicitly wired up (module options, `setDispatcher()`, or a per-request `dispatcher`).

### `OnModuleDestroy`

`HttpService` implements Nest's `OnModuleDestroy`, so `app.close()` (or `moduleRef.close()` in a test) gracefully closes every dispatcher **this service created**. `Dispatcher#close()` lets in-flight requests finish; it doesn't abort them. This covers the per-service default `Agent`, the module-built dispatcher (whichever of `Agent`/`ProxyAgent`/`EnvHttpProxyAgent`/`CookieAgent` `register()`'s options produced), and every cached per-path `socketPath` `Agent`, all closed concurrently, so several cached `socketPath` `Agent`s don't add up to several times the wait below. A `dispatcher` *you* supplied, through module options, a per-request option, or `setDispatcher()`, is never touched here. You own its lifecycle.

Each of those closes is bounded by a short internal grace period of a few seconds. This isn't configurable, and it isn't the same thing as a request `timeout`. A normal in-flight request finishes well within it, so shutdown isn't delayed in the common case. Past the grace period, anything still open is force-aborted instead of left hanging forever. In practice, this only ever matters for an abandoned `responseType: 'stream'` response that was never read and never `.destroy()`d. Every other response shape is always fully drained by this library itself, so it can't be left open by anything the caller does or doesn't do. This is what stops `app.close()` from hanging indefinitely on such a response. See [`signal`](/docs/axios-supported-options.md#request-config)'s "Always consume or `.destroy()`" note for why that's worth avoiding regardless.

## `setDispatcher(dispatcher)`

Sets the undici `Dispatcher` used by later requests made through this `HttpService`, unless a per-request `dispatcher`/`socketPath` or the module's own dispatcher applies. See the precedence list above. If the dispatcher it replaces is one this service created itself (the module-built dispatcher, or the per-service default `Agent` when nothing else was configured), that dispatcher is closed. A dispatcher you supplied yourself, through module options or an earlier `setDispatcher()` call, is never closed.

```typescript
import { Agent } from 'undici';

this.httpService.setDispatcher(new Agent({ connections: 10 }));
```

> **Breaking change:** renamed from `setGlobalDispatcher`, with no alias. It never touched undici's global dispatcher, so the old name was misleading either way.

## `undiciRef`

Read-only. A frozen snapshot of the undici request options this service uses as defaults for every request (module `headers`, timeouts, `dispatcher`, ...). Internal `__`-prefixed keys are stripped. Each read returns a fresh, independent snapshot. Mutating one has no effect on the service or on a later read.

> **Breaking change:** previously the live, mutable options object itself. Mutating it, or the object originally passed to `register()`, already had no effect on `axiosRef.defaults`-backed fields (see `axiosRef.defaults` above). It's now read-only for the rest too.
