# Migrating from @nestjs/axios to nestjs-axios-undici

## Change the import

In most cases, this is the whole migration:

```typescript
// Before
import { HttpModule, HttpService } from '@nestjs/axios';

@Module({
  imports: [HttpModule.register({ timeout: 5000, maxRedirects: 5 })],
})

// After
import { HttpModule, HttpService } from 'nestjs-axios-undici';

@Module({
  imports: [HttpModule.register({ timeout: 5000, maxRedirects: 5 })], // same options, automatically detected
})
```

`HttpModule.register()`/`.registerAsync()` detect axios-style options and map them to undici; existing `axiosRef.interceptors` code, response shapes and error handling keep working. `toPromise()` is deprecated in RxJS 7; use `firstValueFrom`/`lastValueFrom` if you haven't already.

## Differences to check

Almost everything behaves like `@nestjs/axios`. The known, still-real differences are tracked on one page. Read [Axios compatibility](/docs/axios-supported-options.md) before migrating a service that depends on an edge case. As of this writing, that page lists a handful of narrow gaps: a query-string apostrophe encoding, `error.stack` not reaching back to the caller through the RxJS pipeline, a dropped connection's `error.message` text, and a few others. None of them affects typical usage.

One transport-level caveat: a `responseType: 'stream'` consumer that reads much slower than the server sends can hit an undici bug (`UND_ERR_SOCKET`, "other side closed") against servers with a short `keepAliveTimeout`. See the `responseType` row on the compatibility page for workarounds.

## Run side by side

The two packages export different `HttpService` classes, so both modules can be imported side by side while you migrate services one at a time:

```typescript
import { HttpModule as AxiosHttpModule } from '@nestjs/axios';
import { HttpModule } from 'nestjs-axios-undici';

@Module({
  imports: [
    AxiosHttpModule.register({ /* axios config */ }),
    HttpModule.register({ /* same config */ }),
  ],
  providers: [LegacyService, MigratedService], // inject the matching HttpService in each
})
export class AppModule {}
```

See [`examples/axios-to-undici-migration.ts`](https://github.com/yordan-kanchelov/nestjs-axios-undici/blob/main/examples/axios-to-undici-migration.ts) for a runnable version that runs the identical service body against both packages and diffs the result.

## Interceptors and OpenTelemetry

`axiosRef.interceptors.request/response.use(...)` code (including `eject()`/`clear()`) keeps working unchanged. See [Interceptors](/docs/guides/interceptors.md) for that API and for this package's native interceptors, an alternative that skips the axios-config conversion. [`examples/opentelemetry-integration.ts`](https://github.com/yordan-kanchelov/nestjs-axios-undici/blob/main/examples/opentelemetry-integration.ts) has runnable trace-injection examples in both styles.

## Performance

See the [benchmarks](/docs/benchmarks.md) for current throughput/latency numbers; results for your workload will vary.

## Upgrading from 0.6.x

0.6.0 through 1.0.0 brought this package's behaviour much closer to axios. If you're on an earlier 0.6.x release, the breaking changes are below, grouped by area. Each links to the full reference for the option involved.

### Types

Only affects code that references this package's own type names (plain object literals for options/config are unaffected):

- **`HttpModuleOptions` is strictly typed.** No more `& any`/`Partial<any>`. A typo (`{ timeuot: 5 }`) is now a compile error, as it always was against `@nestjs/axios`' own types.
- **`HttpModule.registerAsync({})`** (none of `useFactory`/`useClass`/`useExisting` set) now throws a clear error at setup, instead of silently registering a broken provider.
- **`response.headers`'s TypeScript type** changed from an `IncomingHttpHeaders`-based type to `Record<string, any>`. It's still a plain object at runtime, so this is unaffected unless you referenced the old type by name.
- **One request-config type.** `AxiosLikeRequestConfig`, `AxiosCompatibleRequestOptions`, `AxiosCompatibleRequestConfig` and `HttpRequestOptions` are merged into `AxiosLikeRequestConfig<D = any>`, used everywhere a request-level config is accepted. `post`/`put`/`patch` now have a real body type parameter: `post<T, D>(url, data?: D, config?: AxiosLikeRequestConfig<D>)`.
- **`AxiosHeaders` casing.** Header names are now stored the way axios does: case-insensitive lookup, but `toJSON()`/`toString()`/iteration report the casing a header was *first set with*, and `normalize(true)` title-cases every name. If your code compared `Object.keys(headers.toJSON())` expecting lower-case keys, compare case-insensitively or use `headers.get()`/`.has()` instead. There's no `forEach()` (axios' own `AxiosHeaders` doesn't have one either). Use `for (const [key, value] of headers)`.
- **`axiosRef` is now a real, callable axios instance**: `axiosRef(config)`, `getUri`, `create`, `postForm`/`putForm`/`patchForm`, `query`, a function `adapter`. `HttpService.query()` is implemented too.
- **`axiosRef.defaults` is now the single source of truth.** Module options only ever seed it once, at setup. A runtime mutation always wins from then on, including for `headers`, which used to have the opposite rule. See [Precedence](/docs/axios-supported-options.md#precedence-axiosrefdefaults).
- **`postForm`/`putForm`/`patchForm` with a plain object is now multipart**, matching axios' own `postForm` (previously sent url-encoded). Use `post()`/`put()`/`patch()` with `data: new URLSearchParams(...)` if you relied on the url-encoded body.
- **`AxiosLikeRequestConfig.url` is now `string`-only.** It was `string | URL`. This matches axios exactly, and is unaffected unless you built a `request({ url: someUrlObject })` directly.
- **`error instanceof AxiosError` also holds for `axios.AxiosError`** when the optional `axios` peer is installed. `error instanceof axios.CanceledError` specifically doesn't, because a prototype chain is linear. Use `isCancel()` instead.
- **The legacy typed module is removed**: `TypedHttpModule`, `InjectTypedHttpService`, `ExtractHttpServiceType`, `HTTP_SERVICE_TYPE`, `TypedDynamicModule`. Use `HttpModule`/`HttpService` directly.
- **Other removed exports, with what to use instead**: `AxiosResponseAdapterInterceptor`/`axiosResponseAdapter` (dead code, nothing to switch to); `SizeLimitInterceptor`/`createSizeLimitInterceptor`/`SizeLimitOptions` (use `maxBodyLength`/`maxContentLength` options; see below); `STATUS_TEXT_MAP`, `HTTP_MODULE_ID` (internal, never did anything useful); the internal error helpers `toAxiosError`/`createStatusError`/`createTimeoutError`/`createUnsupportedProtocolError`/`isDeadlineTimeoutReason` (use `AxiosError`/`isAxiosError`/`isCancel`); the unused types `HttpServiceWithAxiosRef`/`BodyMixin`/`CommonResponseHeaders`/`MethodHeaders` (use `AxiosLikeResponse`/`RawAxiosHeaders`/a plain `Record<string, any>`).
- **Axios-named type aliases added**: `AxiosRequestConfig`/`AxiosResponse`/`AxiosInstance` are exported as aliases of this package's own `AxiosLikeRequestConfig`/`AxiosLikeResponse`/`AxiosRef`, so migrating code can drop its own `import ... from 'axios'` purely for these types (import under another name if a file already imports the same name from `axios` too).

The full, frozen export list is checked in CI against [`etc/nestjs-axios-undici.api.md`](https://github.com/yordan-kanchelov/nestjs-axios-undici/blob/main/etc/nestjs-axios-undici.api.md).

### Requests and responses

See [Request config](/docs/axios-supported-options.md#request-config) and [Response](/docs/axios-supported-options.md#response) for the full behaviour:

- **Requests now send axios' default headers**: `Accept: application/json, text/plain, */*`, `User-Agent: nestjs-axios-undici/<version>`, and `Accept-Encoding: gzip, compress, deflate, br` (only when decompression is enabled). A POST/PUT/PATCH with no body still gets the default `Content-Type: application/x-www-form-urlencoded`, matching axios. Override any of these the axios way (`axiosRef.defaults.headers.common[...]`) or through module/per-request `headers`.
- **Response bodies now decode like axios**: `+json` content types (e.g. `application/problem+json`) parse as JSON instead of coming back as a `Buffer`; a response with no `Content-Type`, or a text-ish one (`text/*`, `application/xml`, `application/x-www-form-urlencoded`, `image/svg+xml`, ...), decodes to a UTF-8 string, with a JSON-looking string parsed and silently falling back to the string on failure; `responseType: 'blob'` now returns a string, matching axios in Node.js; other binary content types are unaffected and still come back as a `Buffer`. `Content-Encoding: gzip`/`compress`/`x-compress`/`br`/`deflate`/`zstd` responses are now decompressed automatically (`decompress: false` opts out); `statusText` is now the server's real reason phrase.
- **`Content-Encoding` is now deleted from `response.headers` after a successful decode**, matching axios exactly. This only happens when something was actually decoded, not with `decompress: false`, and not for an encoding this library doesn't recognize. If your code reads `response.headers['content-encoding']` after a normal, decoded response, it now sees `undefined` where it used to still show the original value.
- **A corrupt (not merely truncated) compressed body now rejects as a real `AxiosError`**, for both a buffered response and `responseType: 'stream'`. Previously the raw zlib error propagated unwrapped, with no `isAxiosError`/`.config`/`.request`. A body that's simply truncated mid-stream, meaning a valid header cut off before the end, never threw and still doesn't. It resolves with whatever partial bytes could be decoded, matching axios' own flush-tolerant zlib options.
- **A `responseType: 'stream'` response is now cancelled with a real `CanceledError`/`ERR_CANCELED`** in the two cases axios itself cancels it in: destroying the request's own upload body stream mid-request, and the caller's `AbortSignal` firing *after* the stream was already handed back (previously had no effect once the stream was emitted). Unrelated to, and unaffected by, the already-documented "unsubscribing has no effect once the stream has been emitted" difference (no signal of the caller's own involved there).
- **A header sent more than once is now joined the way Node/axios join it, not left as an array**: `response.headers['x-dup']` used to always be a `string[]` for a duplicated header; it's now a plain `string` for every header except `set-cookie` (still always an array) and `cookie` (joined with `'; '`). See [Response](/docs/axios-supported-options.md#response) for the exact rules. If your code checked `Array.isArray(response.headers['some-header'])` or iterated it as an array, update it for a plain string (unless it's `set-cookie`).
- **New capabilities**: `onUploadProgress`/`onDownloadProgress` (axios' own `AxiosProgressEvent` shape) and `maxRate` are now honoured (previously silently ignored), and `formSerializer` now drives `postForm`/`putForm`/`patchForm`. See [Progress callbacks, `maxRate` and `formSerializer`](/docs/axios-supported-options.md#progress-callbacks-maxrate-and-formserializer) for the couple of narrower gaps (e.g. no pre-computed `Content-Length` for a multipart upload's progress).
- **`transitional.silentJSONParsing: false`** (with `responseType: 'json'`) now throws `ERR_BAD_RESPONSE` on invalid JSON instead of silently returning the raw text, matching axios' own condition exactly. The default (silent) behaviour is unchanged.

### axiosRef interceptors

- **Interceptor order now matches axios**: request interceptors run last-registered-first (LIFO), response interceptors first-registered-first (FIFO). Both were the other way round before.
- **`response.config`/`error.config` are now one axios-shaped config object**, carried through from the request: raw (unserialised) `data`; `params` and `baseURL` as given (not merged into `url`); a lower-case `method`; `headers` as `AxiosHeaders`; and any custom field you set on the config (e.g. a `_retry` flag) survives the round trip. Before, these were rebuilt separately with the serialized body, the full combined URL, an upper-case method and no custom fields. A "retry once on 401" interceptor looped forever as a result, and packages built on this pattern (`axios-retry`, `axios-auth-refresh`) didn't work. If you worked around either issue, you can remove the workaround.
- **Unsubscribing from a request `Observable` before it emits now aborts the in-flight request** (rxjs `timeout()`, `switchMap`, `takeUntil`, `race`, ...), matching `@nestjs/axios`. Skipped once the response (or, for `responseType: 'stream'`, the headers) has already arrived.
- **`axiosRef` request interceptors now run fresh on every subscription** instead of once when `get()`/`post()`/... is called, so `get().pipe(retry())` sends a new set of headers on each attempt instead of replaying the first one.

### Errors, timeouts and size limits

See [Errors](/docs/axios-supported-options.md#errors) and [Request config](/docs/axios-supported-options.md#request-config) for the full behaviour; the changes:

- **`timeout` is now a total, deadline-style timeout, like axios.** Previously it only mapped to undici's idle `headersTimeout`/`bodyTimeout`, which reset on every chunk, so a slowly-but-steadily trickling response never timed out at all. If you relied on that, it now will, at the configured value. `timeoutErrorMessage` and `transitional.clarifyTimeoutError` are honoured too.
- **Size-limit codes now match axios exactly**: `maxContentLength` gives `ERR_BAD_RESPONSE` (was `ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED`) and is enforced streaming, not after buffering. `maxBodyLength` is now actually enforced (previously silently ignored for most requests). A per-request value now correctly wins over a module-level one.
- **`validateStatus: null` now means every status resolves**, as in axios (it used to fall back to the default 2xx range).
- **Credentials embedded in a URL become `Authorization: Basic ...`**, as in axios; `config.auth` still wins when both are set.
- **`allowAbsoluteUrls: false`** (axios ≥1.8) is now honoured.
- **`error.request`/`response.request` are now populated** (`path`, `method`, `host`, `protocol`, `res.responseUrl`) instead of an always-truthy empty placeholder.
- **An unsupported URL protocol and undici's own argument-validation failures now reject as a proper `AxiosError`** instead of a raw undici error class.
- **`data:` URLs are now supported**, resolved entirely locally like axios (previously rejected with `Unsupported protocol data:`).
- **`maxContentLength` is now also enforced for `responseType: 'stream'`** (previously uncapped).
- **Header values with CRLF/other control characters are now sanitized like axios**, not rejected outright.
- **`SizeLimitInterceptor`/`createSizeLimitInterceptor` are removed.** No replacement is needed. The enforcement above is automatic.
- **A numeric-string `timeout` (e.g. `timeout: '250'`) is now parsed and enforced like axios.** It used to reject with undici's raw `ERR_BAD_REQUEST`/"invalid headersTimeout" instead.
- **A throwing `beforeRedirect` is now wrapped like axios (`follow-redirects`).** `error.code` is `ERR_FR_REDIRECTION_FAILURE`, the message is `"Redirected request failed: <original message>"`, and `error.cause` is the original error. It used to propagate the raw, unwrapped error.
- **BREAKING: a malformed request URL (an embedded null byte or other C0 control character, or a bare `\n`) now rejects synchronously** with `ERR_INVALID_URL`/`Invalid URL "...": missing "//" after protocol`, matching axios exactly. It used to be silently "fixed" (the offending characters stripped) and actually dispatched over the network.

### Redirects

**Requests now follow redirects by default**, up to 21, matching axios/follow-redirects exactly (301/302 turn `POST` into `GET`, 303 turns anything but `HEAD` into `GET`, 307/308 keep the method and body, sensitive headers are dropped across a protocol/host change, `beforeRedirect` is honoured). To get the previous behaviour (the 3xx response returned as-is), set `maxRedirects: 0`. See [`maxRedirects`](/docs/axios-supported-options.md#request-config).

### Cookies (`cookieJar`)

**`withCredentials: true` is now a no-op**, matching axios itself on Node.js. It used to turn on a cookie jar shared by the whole `HttpService`. A `Set-Cookie` from one caller's response could be replayed on a different caller's later request. Cookie handling is opt-in now, through an explicit `cookieJar` module option, a `tough-cookie` `CookieJar` instance:

```typescript
import { CookieJar } from 'tough-cookie';

HttpModule.register({ cookieJar: new CookieJar() });
```

`http-cookie-agent` and `tough-cookie` are optional peer dependencies. Install them (`npm i http-cookie-agent tough-cookie`) to use `cookieJar`. See [Cookies: `cookieJar`](/docs/axios-supported-options.md#cookies-cookiejar) for the full picture.

### Transport options

`httpAgent`/`httpsAgent` (including TLS options), `proxy` (an explicit object, or `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, where reading these environment variables by default is new and matches axios; pass `proxy: false` if you don't want that), `socketPath` and `httpVersion` are now mapped to undici. See [Module-level axios options](/docs/axios-supported-options.md#module-level-axios-options) and [Advanced configuration (dispatchers)](/docs/guides/configuration.md#advanced-configuration-dispatchers) for configuring undici directly (a `dispatcher` you pass always wins over all of the above).

### Dispatcher lifecycle and `HttpService` members

- **Per-service default dispatcher.** Every `HttpService` now owns its own undici `Agent` rather than falling back to undici's *global* dispatcher: `undici.setGlobalDispatcher()` elsewhere in the process **no longer affects requests made through `HttpService`**. If your tests used `setGlobalDispatcher(mockAgent)` with undici's `MockAgent`, pass the mock through module options or `setDispatcher()` instead. See [Dispatchers and connection lifecycle](/docs/http/http.service.md#dispatchers-and-connection-lifecycle) and [Testing](/docs/guides/testing.md).
- **`OnModuleDestroy`.** `app.close()` now gracefully closes every dispatcher this library created for that service. A `dispatcher` you supplied yourself is never closed.
- **The static `HttpModule` import (no `register()` call) no longer shares one options object across every app that imports it.**
- **`setGlobalDispatcher(dispatcher)` is renamed to `setDispatcher(dispatcher)`**, with no alias (it never touched undici's own global dispatcher).
- **`setInterceptors()` is no longer public.** Use `addInterceptor()` at runtime, or the module's `interceptors` option at setup.
- **`interceptorCount`** no longer counts a phantom interceptor or `axiosRef`'s own interceptors. It's the plain length of the module-registered chain.
- **`undiciRef`** is now a read-only, frozen snapshot, not the live options object.
- **Axios-only keys no longer leak into undici's dispatch options** (`auth`, `httpAgent`, `httpsAgent`, `proxy`, etc. are stripped once at setup).
- **Axios-compatibility warnings are now logged through Nest's own `Logger`** (context `HttpModule`), not `console.warn`.

## Upgrading from `nestjs-undici-interceptors` (0.5.x)

The package was renamed to `nestjs-axios-undici` in 0.6.0; the API is the same, so replace the dependency and the import path:

```bash
npm uninstall nestjs-undici-interceptors
npm install nestjs-axios-undici undici
```

```typescript
// Before
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
// After
import { HttpModule, HttpService } from 'nestjs-axios-undici';
```

0.6.0 also brought behaviour closer to axios. Check these if you relied on the old behaviour:

- Network, timeout and cancellation errors are wrapped in an `AxiosError` (`error.code` such as `ECONNREFUSED`, `ECONNABORTED`, `ERR_CANCELED`); the original undici error is kept in `error.cause`, so `instanceof undici.errors.*` checks must look at `error.cause`.
- String and `Buffer` request bodies get `Content-Type: application/x-www-form-urlencoded` by default, as in axios (previously `application/json`). Falsy primitive bodies (`0`, `false`, `''`) are no longer sent.
- Per-request headers are merged with module headers (case-insensitively) instead of replacing them.
- Module-level `timeout`, `auth`, `params` and `maxRedirects` now apply to every request, including with `registerAsync`.
- `params`, `baseURL` joining, `responseType`, `signal`/`cancelToken`, `request(config)` and `axiosRef.defaults`/`axiosRef.get()` now work like axios. See [Axios compatibility](/docs/axios-supported-options.md).

## Need help?

- [Axios compatibility](/docs/axios-supported-options.md) for every configuration option and its differences from axios.
- [Interceptors](/docs/guides/interceptors.md) for native interceptors and interceptors with dependencies.
- Browse the [examples](https://github.com/yordan-kanchelov/nestjs-axios-undici/tree/main/examples) for runnable code.
