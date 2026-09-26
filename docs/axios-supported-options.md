# Axios compatibility

This page lists what works when you switch from `@nestjs/axios` to `nestjs-axios-undici`, and what behaves differently. Every row is covered by a side-by-side test against real axios / `@nestjs/axios`, in [`tests/axios-compatibility-matrix.e2e.spec.ts`](https://github.com/yordan-kanchelov/nestjs-axios-undici/blob/main/tests/axios-compatibility-matrix.e2e.spec.ts) and the table-driven differential harness in [`tests/compat/differential/`](https://github.com/yordan-kanchelov/nestjs-axios-undici/tree/main/tests/compat/differential).

Legend: ✅ same as axios · ⚠️ works with a documented difference · ❌ not supported

## HttpService

| Feature | Status | Notes |
|---------|:------:|-------|
| `request(config)` (`{ url, method, params, data, ... }`) | ✅ | Same call form as `@nestjs/axios`. `request(url, options)` (undici style) still works. |
| `get`, `delete`, `head`, `post`, `put`, `patch` | ✅ | |
| `options` | ✅ | Not available in `@nestjs/axios`. |
| `postForm` / `putForm` / `patchForm` with `FormData` | ✅ | Sent as `multipart/form-data`. |
| `postForm` / `putForm` / `patchForm` with a plain object | ✅ | Sent as `multipart/form-data`, converted to a `FormData`, matching axios' own `postForm`. An explicit `Content-Type` header doesn't change this, and neither does axios'. This was confirmed against real axios. |
| `query(url, data?, config?)` | ✅ | The HTTP `QUERY` method, new in `@nestjs/axios` 12 / axios ≥1.13. |
| Unsubscribing aborts the request | ✅ | Unsubscribing before the response arrives (`timeout()`, `switchMap`, `takeUntil`, `race`, ...) aborts the upstream request, as in `@nestjs/axios`. It doesn't abort once the response has been emitted, or for `responseType: 'stream'`, once the headers have been emitted. A caller's own `AbortSignal` (`config.signal`) works differently: it keeps working after emission too. See `signal` under [Request config](#request-config). |

## `axiosRef`

`axiosRef` is a real, callable axios instance. It stands in for axios' own `AxiosInstance` type.

| Feature | Status | Notes |
|---------|:------:|-------|
| `axiosRef(config)` / `axiosRef(url, config)` | ✅ | Callable, like `axios(...)`. This is what `axios-retry` relies on. |
| `axiosRef.get/post/put/patch/delete/head/options/query/request()` | ✅ | Each returns a `Promise` of the response. |
| `axiosRef.postForm/putForm/patchForm()` | ✅ | Same multipart behaviour as `HttpService.postForm` above. |
| `axiosRef.getUri(config?)` | ✅ | The full URL a request would be sent to, without sending it. |
| `axiosRef.create(config?)` | ✅ | A new instance sharing this `HttpService`'s transport/dispatcher and module-level interceptors, with its own `interceptors` and `defaults` merged from this one. See [Precedence](#precedence-axiosrefdefaults) below. |
| `axiosRef.interceptors.request/response.use()` | ✅ | Runs in axios' own order: request interceptors last-registered-first, response interceptors first-registered-first. `runWhen`/`synchronous` (3rd argument) are honoured. |
| `interceptors.*.eject(id)` / `clear()` | ✅ | |
| `interceptors.request.handlers` / `.forEach()` | ❌ | Axios' own internal bookkeeping arrays, not part of its documented API. `undefined` here. Use `eject(id)`/`clear()` above to manage interceptors. |
| `axiosRef.defaults.headers.common[...]`, `.get/.post/...[...]` | ✅ | See [Precedence](#precedence-axiosrefdefaults) below. |
| `axiosRef.defaults.baseURL` / `.timeout` / `.maxRedirects` / `.params` / `.paramsSerializer` / `.validateStatus` / `.responseType` / `.transformRequest` / `.transformResponse` / `.adapter` / `.withCredentials` / `.onUploadProgress` / `.onDownloadProgress` / `.maxRate` / `.formSerializer` / `.parseReviver` / `.sensitiveHeaders` / `.auth` / `.maxContentLength` / `.maxBodyLength` / `.timeoutErrorMessage` / `.decompress` / `.socketPath` / `.allowAbsoluteUrls` / `.beforeRedirect` | ✅ | Honoured at request time, including on a plain request with no axiosRef interceptors. `axiosRef.create(config)` honours them too, and so does a later assignment such as `axiosRef.defaults.maxContentLength = ...`. See [Precedence](#precedence-axiosrefdefaults) below. |
| A function `axiosRef.defaults.adapter` / `config.adapter` | ✅ | Called with the final config instead of dispatching through undici; its response still runs through `validateStatus`/`transformResponse`/response interceptors. This is what makes `axios-mock-adapter` work. A string adapter name (`'http'`/`'xhr'`/`'fetch'`) is accepted but ignored. This library always dispatches through undici. |
| `AxiosHeaders` casing (`toJSON()`, iteration, `normalize(true)`) | ✅ | `config.headers`/`error.config.headers` preserve the casing a header was first set with (case-insensitive lookup either way), like axios. `response.headers` itself stays a plain, lower-cased object. See [Response](#response) below. |
| Full mutual TypeScript assignability with axios' `AxiosInstance` | ⚠️ | One narrow, TypeScript-only gap: axios' `Axios.request`/`get`/... carry a 4th generic (`R`, for fully overriding the response type) this library's methods don't mirror. This is unrelated to `AxiosHeaders`, and has no effect at runtime. See the migration guide. |

## Request config

Per-request options (third argument of `post`, second of `get`, or the `request(config)` object):

| Option | Status | Notes |
|--------|:------:|-------|
| `baseURL` | ✅ | Joined like axios: `http://api/v1` + `/users` becomes `http://api/v1/users`. |
| A malformed `http(s):` request URL (an embedded null byte or other C0 control character, a bare `\n`, e.g. `'\u0000https:example.com/users'`) | ✅ | Rejected synchronously, before ever dispatching, with `ERR_INVALID_URL`, `Invalid URL "<url>": missing "//" after protocol`. This is the same error axios (`buildFullPath`'s `assertValidHttpProtocolURL`) gives, checked the same way: leading whitespace/control characters stripped, embedded tab/newline/CR removed, then checked for a `http(s):` scheme not immediately followed by `//`. Without this, undici's own WHATWG `URL` parsing silently drops those characters and dispatches the "fixed" URL over the network instead. |
| `data:` URLs (`axiosRef.get('data:text/plain;base64,...')`) | ✅ | Resolved entirely locally, like axios, with no network request. `maxContentLength` is checked against the same Buffer-allocation estimate Node's own base64 decoder would use, without allocating it. A non-`GET` method resolves a synthetic `405`, then subject to `validateStatus` like any other response, exactly as axios. The decoded body is shaped per `responseType`: a `Buffer` by default or for `arraybuffer`, a real `Blob` for `blob` when the platform's global `Blob` exists, a UTF-8 string for `text`, a one-shot `Readable` for `stream`. |
| `params` (objects, arrays, nested objects, dates, `URLSearchParams`) | ✅ | Same encoding as axios (`a[]=1&a[]=2`, `obj[k]=v`). |
| `paramsSerializer` (function or `{ serialize, encode, indexes }`) | ✅ | |
| `headers` (plain object or `AxiosHeaders`) | ✅ | Merged case-insensitively with `axiosRef.defaults.headers`, which module headers seed at setup. See [Precedence](#precedence-axiosrefdefaults). A header set to `undefined`/`null` removes a default, as in axios. A value with CRLF or another C0/DEL control character, or a character outside the Latin-1 byte range, is sanitized the same way axios does before it ever reaches Node's `http.request`, meaning stripped, then trimmed. This matches what Node's own `http` module, axios' transport, does, rather than undici's own stricter `InvalidArgumentError`. Headers added or changed from inside `beforeRedirect` on a later hop are not sanitized this way, same as axios: its transport, `follow-redirects`, calls Node's `http` per hop, which does its own CRLF rejection there instead. |
| Default `Accept`, `User-Agent`, `Accept-Encoding` headers | ⚠️ | `Accept: application/json, text/plain, */*` and `Content-Type` defaults match axios exactly. `User-Agent` is `nestjs-axios-undici/<version>` (axios: `axios/<version>`). Override it the axios way: `axiosRef.defaults.headers.common['User-Agent'] = '...'`. `Accept-Encoding` lists `gzip, compress, deflate, br`, matching axios' own default exactly, and is only sent when decompression is enabled at module level (`register({ decompress: false })` omits it; a per-request `decompress: false` keeps the header and returns the raw compressed bytes, as axios does). `zstd` is decoded (see `decompress` below) but, matching axios' own default (`transitional.advertiseZstdAcceptEncoding: false`), isn't advertised here either. Set it yourself, the same way as any other default header override (`axiosRef.defaults.headers.common['Accept-Encoding'] = 'gzip, compress, deflate, br, zstd'`, or per-request `headers`), if you want a server to negotiate it. Seeded into `axiosRef.defaults.headers.common` at setup; module `headers` and per-request `headers` override them (see [Precedence](#precedence-axiosrefdefaults) for how module headers relate to `axiosRef.defaults`). |
| `data`: object serialized to JSON, or a string, `URLSearchParams`, `Buffer`/typed arrays, streams, `FormData` (global or the `form-data` package) | ✅ | Same `Content-Type` defaults as axios. A bare `number`/`boolean` body (not axios' documented shapes) is forwarded stringified instead of rejected. See [Errors](#errors). |
| A `Content-Length` header that doesn't match the body's actual byte length | ⚠️ | Rejected as an `AxiosError` with `error.code === 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH'`, undici's own code, kept as-is and not remapped to an axios code. This is a request-smuggling protection. axios' own Node `http` transport trusts a caller-supplied `Content-Length` and sends it as given. Leave `Content-Length` unset (the default) to have it computed correctly. |
| `auth` | ✅ | Becomes `Authorization: Basic ...` and overrides an existing Authorization header, as in axios. Credentials embedded in the URL itself (`http://user:pass@host`) become `auth` too, when `auth` isn't also set. `auth` wins when both are given. |
| `timeout` | ✅ | A total, deadline-style timeout, like axios: it runs from request start until the response body is fully read, or, for `responseType: 'stream'`, until the headers arrive. Rejects with `ECONNABORTED` / `timeout of Nms exceeded` (or `timeoutErrorMessage`, if set). One timer per request, created only when `timeout > 0`. undici's own `headersTimeout`/`bodyTimeout` are still set alongside it, as a backstop. A `timeout` that isn't truthy-and-parseable-as-an-integer (axios' own `parseInt(timeout, 10)` check) rejects with `ERR_BAD_OPTION_VALUE`, "error trying to parse \`config.timeout\` to int", the same code and message as axios, checked up front before ever dispatching. A numeric-*string* `timeout` (e.g. `'250'`) is parsed the same way axios' own `parseInt(timeout, 10)` does and enforced exactly like the equivalent number, with no extra cost for the common case of an already-numeric `timeout`. |
| `timeoutErrorMessage` | ✅ | Replaces the default `timeout of Nms exceeded` message. |
| `transitional.clarifyTimeoutError` | ✅ | Reports a timeout as `ETIMEDOUT` instead of `ECONNABORTED`. |
| `transitional.silentJSONParsing: false` (with `responseType: 'json'`) | ✅ | A `JSON.parse` failure then throws (`ERR_BAD_RESPONSE`, `response.data` the raw text) instead of silently returning the raw text, matching axios' own `strictJSONParsing` condition exactly (`!silentJSONParsing && responseType === 'json'`). The default (`silentJSONParsing` unset/`true`) is unaffected, for every `responseType` including the plain default (no `responseType` at all). `forcedJSONParsing` is accepted for type compatibility but describes the default parsing this library already does unconditionally. Also honoured on `axiosRef.defaults.transitional` and at module level (`register({ transitional })`). Precedence is request > `axiosRef.defaults` > module, the same as every other passthrough default. |
| `signal` (`AbortController`) | ✅ | Rejects with `CanceledError` (`ERR_CANCELED`). For `responseType: 'stream'`, it still works after the stream has already been handed back. Firing the signal later destroys the stream with the same `CanceledError`, matching axios, whose `config.signal.addEventListener('abort', ...)` stays live for as long as the stream itself does. Unsubscribing the Observable with no signal of your own is different: it has no effect once the stream has been emitted. See [Unsubscribing aborts the request](#httpservice). **Always consume or `.destroy()` a `responseType: 'stream'` response**, especially when reusing one `AbortSignal` across several requests. The listener this library attaches to that signal is only removed once the stream itself closes, so an abandoned, never-drained, never-destroyed stream keeps that listener, and everything it closes over, alive indefinitely. This matches axios' own behaviour, since its `stream.finished(...)` listener has the same lifetime. It isn't a leak specific to this library, but it's easy to hit by accident with a shared/long-lived signal. An unconsumed stream also keeps `HttpModule`'s underlying dispatcher open. `app.close()`/`HttpService.onModuleDestroy` no longer waits on it forever, though. Past a short internal grace period it force-aborts whatever is still open. See [Dispatchers and connection lifecycle](/docs/http/http.service.md#dispatchers-and-connection-lifecycle). |
| `cancelToken` | ✅ | Rejects with `CanceledError` carrying the cancel message. |
| `validateStatus` | ✅ | `validateStatus: null` (or `undefined` set as an explicit key) means every status resolves, as in axios; leaving it unset entirely falls back to the default 2xx range. |
| `allowAbsoluteUrls: false` (axios ≥1.8) | ✅ | With a `baseURL`, an absolute request `url` is combined with it anyway, by naive concatenation, instead of replacing it outright. This is axios' own `buildFullPath` semantics. |
| `maxRedirects` | ✅ | Follows up to 21 redirects by default, like axios. `maxRedirects: 0` returns the 3xx response as-is, through `validateStatus` like any other status. 301/302 turn `POST` into `GET`; 303 turns anything but `HEAD` into `GET` (both drop the body and `Content-*` headers); 307/308 keep the method and body. `Authorization`/`Cookie`/`Proxy-Authorization` are dropped across a protocol downgrade or a host (including port) change. Exceeding the limit rejects with `ERR_FR_TOO_MANY_REDIRECTS` ("Maximum number of redirects exceeded"), with no `response`, same as axios. A streamed request body (a `Readable`, not a `Buffer`/string/`FormData`) can't be resent on a redirect that keeps it (307/308, or a non-POST 301/302): that rejects with `ERR_FR_REDIRECTION_FAILURE` instead of sending a broken request; buffer the body yourself first, or use `maxRedirects: 0`. |
| `beforeRedirect` | ✅ | Called before each hop with `(options, responseDetails, requestDetails)`, like axios; mutating `options.headers`/`.method`/`.protocol`/`.hostname`/`.port`/`.path` changes the next hop. Also settable at module level (`register({ beforeRedirect })`). A `beforeRedirect` that throws is wrapped like axios/`follow-redirects` does: `code: 'ERR_FR_REDIRECTION_FAILURE'`, message `"Redirected request failed: <message>"`, `error.cause` the original error. |
| `sensitiveHeaders` (axios ≥1.x, an array of extra header names) | ✅ | Extra header names (case-insensitive) dropped alongside `Authorization`/`Cookie`/`Proxy-Authorization`. Unlike that built-in 3 (dropped only on a protocol downgrade or a cross-host redirect that isn't to a subdomain), a header named here is dropped on *any* change of origin, including a subdomain redirect or an http-to-https upgrade. This matches axios' own, stricter rule for this option (`isSameOriginRedirect` in `lib/adapters/http.js`). Must be an array of strings, or rejects with `ERR_BAD_OPTION_VALUE`, "sensitiveHeaders must be an array of strings", the same as axios. It's validated up front, whenever redirects are actually followed (`maxRedirects` isn't `0`). Also settable on `axiosRef.defaults`/`axiosRef.create({ sensitiveHeaders })` and at module level (`register({ sensitiveHeaders })`), with the same request > `axiosRef.defaults` > module precedence as every other option. A per-request value wins outright, and is not merged. |
| `responseType: 'json' \| 'text' \| 'arraybuffer' \| 'blob' \| 'stream'` | ✅ | `arraybuffer` gives a `Buffer`; `blob` gives a UTF-8 string, matching axios in Node.js (no native `Blob` decoding there); `stream` gives the undici body (a Node.js `Readable`, transparently decompressed like axios), with `maxContentLength` enforced on it as bytes are read. See below. A `'stream'` response is also cancelled with a real `CanceledError`/`ERR_CANCELED` in the two cases axios itself cancels it in: destroying the request's own upload body stream mid-request, and the caller's `AbortSignal` firing after the stream was already handed back (see `signal` below). **Known limitation (undici bug):** a `'stream'` consumer that reads much slower than the server sends can fail with `UND_ERR_SOCKET` ("other side closed") against a server with a short `keepAliveTimeout` (Node's default is 5s), even though the whole body arrived. axios' Node `http` transport isn't affected. Workarounds: read the stream promptly (buffer it yourself if the sink is slow), or use a buffered `responseType`, which is protected when `maxRate`/`onDownloadProgress` is set (see `maxRate`). Details: `plan/reports/undici-slow-consumer.md`. |
| `maxContentLength` | ✅ | `ERR_BAD_RESPONSE`, "maxContentLength size of N exceeded", the same code and message as axios. Enforced against the *decompressed* size, as bytes arrive. For a compressed body, the decompression itself is streamed and checked chunk by chunk, so a small, highly compressible body (a "gzip bomb") can't fully decompress in memory before being rejected. For every response, compressed or not, crossing the limit destroys the raw response body/socket, not just the decompression stream sitting in front of it. `.pipe()` never propagates destruction back to its source, so that raw body/socket would otherwise dangle under backpressure. This is a real leak, fixed for both the buffered path and the `responseType: 'stream'` path below. Also enforced for `responseType: 'stream'`: it destroys the stream, and the raw body behind it, with the same error once the limit is crossed, matching axios' own streamed enforcement. This was previously unenforced for a stream response at all. The same disposal now also happens whenever a `responseType: 'stream'` consumer for a *compressed* response just stops reading early, `maxContentLength` or not. A per-request value wins over a module-level one. |
| `maxBodyLength` | ✅ | A string/Buffer body over the limit rejects synchronously, before ever dispatching, with `ERR_BAD_REQUEST`, "Request body larger than maxBodyLength limit", checked upfront, the same as axios. A stream body is checked as bytes are written; over the limit gives `ERR_FR_MAX_BODY_LENGTH_EXCEEDED`, the code axios' own default (redirect-following) transport uses for a streamed body. A per-request value wins over a module-level one. |
| `decompress` | ✅ | gzip/compress/x-compress/br/deflate/zstd are decompressed when `Content-Encoding` is set (`responseType: 'stream'` included, since the decompression stream is destroyed, alongside the raw response body/socket behind it, if a consumer stops reading early). `compress`/`x-compress` decode exactly like `gzip` (axios itself only aliases the name onto its gzip decoder; it doesn't implement the old LZW `compress` scheme either). `decompress: false` returns the raw compressed body, as in axios. `zstd` decoding is feature-detected (`zlib.createZstdDecompress`, present on every Node.js version this package supports, added in Node 22.15.0/23.8.0) the same way axios does; on a hypothetical Node build that lacks it, a `Content-Encoding: zstd` response is returned as the raw compressed bytes, matching axios' own fallback. Every decoder uses axios' own flush-tolerant zlib options (`finishFlush: Z_SYNC_FLUSH` etc.), so an empty or truncated-but-structurally-valid compressed body resolves (with `''`, or with whatever partial bytes could be decoded) instead of throwing. Only data that fails the format check entirely, meaning the wrong bytes altogether, rejects. See the `Content-Encoding` row under [Response](#response) for that error's shape. |
| `transformRequest` / `transformResponse` per request | ✅ | Replaces default serialisation/parsing entirely, like axios: `transformRequest` gets the raw `data`; `transformResponse` gets the raw response body (not yet JSON-parsed). |
| `parseReviver` | ✅ | Passed as `JSON.parse`'s second argument by the default JSON parsing (same as axios' own default `transformResponse`); has no effect when a custom `transformResponse` is set (matching axios: a custom `transformResponse` would have to read `this.parseReviver` itself). Also honoured on `axiosRef.defaults` and at module level (`register({ parseReviver })`). A per-request value wins. |
| `socketPath` per request | ✅ | `Agent({ connect: { socketPath } })`, cached per path. Overrides a module-level `socketPath`. |
| `proxy`, `httpAgent`, `httpsAgent`, `withCredentials` per request | ❌ | Module-level only (see below). |
| `cookieJar` per request | ❌ | Module-level only. This isn't an axios option. See [Cookies: `cookieJar`](#cookies-cookiejar). Building a `CookieAgent` per jar per request would be expensive; pass different `cookieJar`s to different `HttpModule.register()` calls instead. |
| `adapter` (a function) | ✅ | Called instead of dispatching through undici; see [`axiosRef`](#axiosref) above. A string name (`'http'`/`'xhr'`/`'fetch'`) is accepted but ignored. |
| `onUploadProgress` / `onDownloadProgress` | ✅ | See [Progress callbacks, `maxRate` and `formSerializer`](#progress-callbacks-maxrate-and-formserializer) below. |
| `maxRate` | ✅ | Both directions. See below. |
| `formSerializer` | ✅ | See below. |
| `xsrfCookieName` / `xsrfHeaderName` | ❌ | |

### Precedence: `axiosRef.defaults`

`HttpModule.register()`/`.registerAsync()` options only ever *seed* `axiosRef.defaults` once, at `HttpService` construction, exactly like `axios.create(moduleOptions)` seeds a real axios instance's `defaults`. From then on, **`axiosRef.defaults` is the single source of truth** for `headers`, `timeout`, `maxRedirects`, `baseURL`, `params`, `paramsSerializer`, `validateStatus`, `responseType`, `transformRequest`, `transformResponse`, `adapter`, `auth`, `maxContentLength`, `maxBodyLength`, `timeoutErrorMessage`, `decompress`, `socketPath`, `allowAbsoluteUrls` and `beforeRedirect`. A runtime mutation, such as `axiosRef.defaults.headers.common['X'] = '...'` or `axiosRef.defaults.timeout = 5000`, applies to every later request and always wins over the module-level value it started out equal to. Precedence is uniformly **request config > `axiosRef.defaults` > module options**.

```typescript
// module options seed axiosRef.defaults once, at setup:
HttpModule.register({ headers: { 'User-Agent': 'my-app/1.0' } });

// a runtime mutation always wins from then on, even though it started out
// equal to the module value above:
httpService.axiosRef.defaults.headers.common['User-Agent'] = 'my-app/2.0';
```

**Changed since 0.6.x.** Module `headers` used to win over `axiosRef.defaults.headers`, so changing a default header that the module also set had no effect, while `timeout` and `maxRedirects` already followed `axiosRef.defaults`. Every field now follows the same rule. Changing the object you passed to `register()`, or `httpService.undiciRef.headers`, after the fact has no effect either. Change `axiosRef.defaults` instead.

**`axiosRef.create(config)`** merges `config` onto the parent's `defaults` the same way axios' own `axios.create(config)` does with `mergeConfig`. `headers` merge per bucket, and any other field in the list above that `config` sets replaces the parent's value. That includes `auth`, `maxContentLength`, `maxBodyLength`, `timeoutErrorMessage`, `decompress`, `socketPath`, `allowAbsoluteUrls` and `beforeRedirect`. So `create({ auth })` sends those credentials, and `create({ maxContentLength })` enforces that limit.

Some axios options are left out of this merge on purpose:

- **`httpAgent`, `httpsAgent`, `proxy`, `httpVersion` and `cookieJar`.** `HttpService` turns these into its dispatcher once, when it's constructed (see [Configuring undici directly](#configuring-undici-directly)). `axiosRef.create()` shares that dispatcher instead of building a new one, which keeps instance creation cheap. So these can't change per `create()` or per `defaults`. `socketPath` is the exception. This package already resolves it per request from a small cache keyed by path, so it works in `defaults` and `create()` like the options above.
- **`signal`.** One `AbortSignal` firing would abort every request that shares it, so neither axios nor this package merges it from defaults. Pass it per request.
- **`xsrfCookieName` and `xsrfHeaderName`.** They do nothing at any level (see the module-level table below), so there is nothing to merge.
- **`insecureHTTPParser`, `lookup` and `family`.** This package doesn't implement them at any level: module options, `defaults` or per request.

### Progress callbacks, `maxRate` and `formSerializer`

As in axios, a progress callback runs decoupled from the request (via `process.nextTick`), so an exception it throws never alters or fails the response. It surfaces as an uncaught exception instead, which by default crashes a Node.js process, exactly as it would with axios. Catch errors inside the callback.

`onUploadProgress`/`onDownloadProgress`/`maxRate` are only ever wired up when actually set. A plain request with none of these pays no measurable extra cost, since a body/response is never wrapped in a counting stream otherwise.

| Feature | Status | Notes |
|---------|:------:|-------|
| `onDownloadProgress` | ✅ | Fires as response body bytes arrive, throttled the way axios throttles it (at most every ~333ms, plus a final flush once the body ends so the last event always reflects the true final state). Works with every `responseType`, including `'stream'` (the stream the caller reads from is the same one progress is reported on). `total` comes from the response's `Content-Length` header when present; otherwise `total`/`progress` are `undefined` and `lengthComputable` is `false`, as in axios. |
| `onUploadProgress` | ✅ | Same throttling/event shape, `upload: true`. Works for a string, `Buffer`, stream, or `FormData`/`postForm` body. `total` is the body's own byte length for a string/Buffer, or an already-known `Content-Length` header for anything else. A `postForm`/multipart body has neither, since this library doesn't pre-compute the encoded multipart size the way axios' own `formDataToStream` does, so `total`/`progress` stay `undefined` there even though `loaded` still tracks real bytes written. |
| `maxRate` (a number, or `[upload, download]`) | ✅ | Throttles actual throughput (not just the progress-event rate) in both directions, via the same windowed-chunk-splitting algorithm axios' `AxiosTransformStream` uses. For buffered responses (`json`/`text`/`arraybuffer`/`blob`) whose `Content-Length` is within `maxContentLength`, the raw body is read at full speed and only the output is paced, which avoids the undici slow-consumer bug described under `responseType`; memory use is the same as the buffered response itself. `'stream'` responses keep normal backpressure and are not covered. |
| `formSerializer` (`{ visitor, dots, metaTokens, indexes, maxDepth }`) | ✅ | Axios' own options for turning a plain object/array into `FormData`/a url-encoded body (`lib/helpers/toFormData.js`), applied to: `postForm`/`putForm`/`patchForm` with a plain object; a plain request whose `Content-Type` is explicitly `application/x-www-form-urlencoded` or `multipart/form-data`. Defaults match axios exactly: `dots: false`, `metaTokens: true`, `indexes: false` (`a[]=1&a[]=2` for an array), `maxDepth: 100`. A custom `visitor` replaces the default traversal entirely (called with `(value, key, path, helpers)`, `helpers.defaultVisitor`/`.isVisitable`/`.convertValue` match axios'). `formDataHeaderPolicy` (a `form-data`-package-specific option) isn't implemented. |
| The reverse: a real `FormData` sent with an explicit `Content-Type: application/json` | ✅ | Converted to a plain object first (axios' `formDataToJSON`, the inverse of the bracket-path convention above) and then `JSON.stringify`d, exactly like axios' default `transformRequest`. |

Precedence is the same **request > `axiosRef.defaults` > module options** rule as everything else in this section. `HttpModule.register({ onDownloadProgress, maxRate, formSerializer, ... })` seeds `axiosRef.defaults` once at setup, same as any other passthrough default.

```typescript
httpService.get(url, {
  responseType: 'stream',
  onDownloadProgress: ({ loaded, total, progress }) => {
    console.log(`${loaded}/${total ?? '?'} (${progress ? Math.round(progress * 100) : '?'}%)`);
  },
  maxRate: 5 * 1024 * 1024, // cap both directions at ~5 MB/s
});

httpService.postForm(url, { tags: ['a', 'b'] }, {
  formSerializer: { indexes: true }, // tags[0]=a&tags[1]=b instead of tags[]=a&tags[]=b
});
```

## Response

| Feature | Status | Notes |
|---------|:------:|-------|
| `status`, `statusText`, `headers['x-name']` | ✅ | Header names are lower-case, as in axios. `statusText` is the server's actual reason phrase. |
| A header sent multiple times (`res.setHeader('X-Dup', ['one', 'two'])`) | ✅ | Joined the way Node's `IncomingMessage.headers` (axios' own transport) joins them: `set-cookie` stays an array; `cookie` joins with `'; '`; a fixed "no duplicates" set (`content-type`, `content-length`, `user-agent`, `referer`, `host`, `authorization`, `proxy-authorization`, `if-modified-since`, `if-unmodified-since`, `from`, `location`, `max-forwards`, `retry-after`, `etag`, `last-modified`, `server`, `age`, `expires`) keeps only the first value; everything else (including a custom header like `X-Dup`) joins with `', '`. |
| JSON body with a JSON `Content-Type` (`application/json`, and any `+json` suffix like `application/problem+json`) | ✅ | Invalid JSON gives the raw string, an empty body gives `''`. |
| `204` / empty body | ✅ | `data` is `''`. |
| JSON-looking body with a non-JSON `Content-Type` (e.g. `text/plain`, no `Content-Type`) | ✅ | Parsed as JSON, like axios' `forcedJSONParsing`; falls back to the raw string silently if parsing fails. |
| Text-ish `Content-Type` (`text/*`, `application/xml`, `application/javascript`, `application/x-www-form-urlencoded`, `image/svg+xml`, `application/octet-stream`, no `Content-Type`) | ✅ | Decoded to a UTF-8 string, like axios' default `responseType: 'json'` handling. |
| Other binary `Content-Type` (images, PDFs, ...) | ⚠️ | Returned as a `Buffer`; axios also returns a UTF-8 string unless `responseType: 'arraybuffer'` is set (harder to use correctly, so this library keeps it a `Buffer` by default). Set `responseType: 'arraybuffer'` for binary downloads either way. |
| `Content-Encoding: gzip \| compress \| x-compress \| br \| deflate \| zstd` | ✅ | Decompressed automatically (`compress`/`x-compress` decode exactly like `gzip`, matching axios); `decompress: false` opts out. The header itself is then deleted from `response.headers`, matching axios exactly. This only happens when something was actually decoded, never with `decompress: false`, and never for an encoding this library doesn't recognize at all. **Breaking change from 0.6**: a caller reading `response.headers['content-encoding']` after a successful decode now sees `undefined`, where it used to still show the original, now-inaccurate value. `content-length` is left untouched either way; axios doesn't touch it on decode either, so it still reflects the *compressed* size. A body that fails to decode entirely, meaning the wrong format, not just truncated, rejects as a real `AxiosError` (`isAxiosError`/`.config`/`.request`/`.code` all set, `code` falling back to the raw zlib code such as `Z_DATA_ERROR`) for both a buffered response and `responseType: 'stream'` (the stream's own `'error'` event carries it). This matches axios' buffered-path shape exactly (`AxiosError.from(err, null, config, lastRequest, response)`), and is extended here to the stream path too, which axios itself leaves unwrapped. An empty or merely truncated, but structurally valid, compressed body never throws at all. It resolves with `''` or with whatever could be decoded from the partial bytes, matching axios' own flush-tolerant zlib options (`finishFlush: Z_SYNC_FLUSH` etc.). |
| `response.headers` as `AxiosHeaders` (`headers.get()`) | ❌ | A plain object, deliberately. Measured, using this library's own `AxiosHeaders` over a typical response's headers across 200k iterations, at about 955ns more per response just to construct, before counting that every later read on it also pays a Proxy-trap cost a plain object doesn't. That isn't worth it, unconditionally, on every response, against the `+10%` CPU-per-request budget the CI regression check enforces. Typed as `Record<string, any>`, assignable to and from axios' own `AxiosResponse.headers`, regardless. Index into it the normal way (`response.headers['content-type']`). |
| `response.config` | ⚠️ | Contains `url` (final URL including query string), `method` (lower-case, e.g. `'get'`, matching axios), `headers` (an `AxiosHeaders` preserving the casing each header was first set with, matching axios), `timeout`, `validateStatus`; no `params`, `baseURL` or `data`. |
| `response.request` | ✅ | Built from the hop that was actually dispatched, not the real `http.ClientRequest` axios exposes: `path`, `method`, `host`, `protocol`, and `res.responseUrl`, the final hop's URL, whether or not a redirect was followed. This matches axios' `responseUrl`, which is always set too. |

## Errors

| Feature | Status | Notes |
|---------|:------:|-------|
| `axios.isAxiosError(error)` / `error.isAxiosError` | ✅ | For status, network, timeout and cancellation errors. |
| `error.code` | ✅ | `ERR_BAD_REQUEST` (4xx, an unsupported protocol, undici argument-validation failures, `maxBodyLength` with a known-length body, a synchronous config-normalization error such as a throwing `paramsSerializer`), `ERR_BAD_RESPONSE` (5xx and others, `maxContentLength`), `ERR_BAD_OPTION_VALUE` (an unparsable `timeout`), `ECONNABORTED` for a timeout (`ETIMEDOUT` with `transitional.clarifyTimeoutError`), `ERR_CANCELED`, `ERR_FR_MAX_BODY_LENGTH_EXCEEDED` (`maxBodyLength` with a stream body, axios' default transport's own code), and network codes such as `ECONNREFUSED`/`ENOTFOUND`. Undici socket errors map to `ECONNRESET`. |
| `error.message` | ✅ | Same messages as axios (`Request failed with status code 404`, `timeout of 200ms exceeded`, `canceled`, `Unsupported protocol tel:`, `maxContentLength size of N exceeded`, `Request body larger than maxBodyLength limit`, ...). |
| `error.request` | ✅ | See `response.request` above; not set for an error where axios itself never builds a request object either (a signal already aborted before the request was ever dispatched, an unsupported protocol). |
| `error.response`, `error.config`, `error.status`, `error.toJSON()` | ✅ | `toJSON()` matches axios' key set, including the browser-only fields (always `undefined` on Node.js, as they are on a real axios error there too), and serialises `config.headers` as a plain object when it's an `AxiosHeaders` instance. |
| `axios.isCancel(error)` | ✅ | |
| `error instanceof AxiosError` | ✅ | True for this package's own `AxiosError`/`CanceledError` classes, always. **Also** true for `axios.AxiosError` when the optional `axios` peer is installed (`npm i axios`): this package lazily links its `AxiosError`'s prototype onto axios' own at module load. `error instanceof axios.CanceledError` specifically does not hold, because a prototype chain is linear (see the doc comment on `linkOptionalAxiosPeer` in `axios-error.ts`). Use `isCancel()` (from either package) to detect cancellation instead. Without `axios` installed, nothing changes. Use `isAxiosError()` (from either package). |
| `error.cause` | ✅ | The original undici/Node.js error for network, timeout and cancellation errors. |
| A dropped connection (`ECONNRESET`) | ⚠️ | `error.message` is undici's own (`"other side closed"`); axios' Node `http` transport instead gives `"socket hang up"`. `error.code`/`isAxiosError`/`error.cause` all match. |

**Known remaining gaps** (see the differential test suite for the exact repros): a query-string apostrophe (`'`) always comes out `%27`, because undici always dispatches through a WHATWG `new URL()` parse, which percent-encodes it for `http(s)` regardless of what string this library hands it, where axios' own encoder leaves it as-is. A timeout that lands after the response has already started streaming gives `ECONNABORTED`/"timeout of Nms exceeded" here, where axios' own internal race can instead give `ERR_BAD_RESPONSE`/"stream has been aborted", depending on whether axios' own response object happens to exist yet when its timeout fires. `error.stack` doesn't reliably reach back to the application's own call site the way axios' does. axios' entire request path is a native `await`/`.then()` chain, so a stack captured in its top-level `catch` already includes the caller via V8's async stack traces. This library's request path is an RxJS `Observable` instead, whose notifications don't carry that link back through `.subscribe()`/`firstValueFrom()`. An HTTP-originated error's stack still shows where in this library's own error handling it was built, from its own construction site, and an interceptor's own thrown error keeps its own, unmodified stack either way. A non-plain-object, non-string/Buffer request body, such as a bare `number` or `boolean` (e.g. `post(url, 5)`), is forwarded to the server as-is, stringified, with the usual `application/x-www-form-urlencoded` default `Content-Type`. axios itself rejects these synchronously with a config `TypeError` before ever dispatching.

```typescript
import { AxiosError, isAxiosError, isCancel } from 'nestjs-axios-undici';
```

## HttpModule

| Feature | Status | Notes |
|---------|:------:|-------|
| `HttpModule` imported without `register()` | ✅ | |
| `register(options)` | ✅ | |
| `registerAsync({ useFactory, inject, imports })` | ✅ | Axios options are mapped exactly like in `register()`. |
| `registerAsync({ useClass })` / `({ useExisting })` | ✅ | |
| `extraProviders`, `global` | ✅ | |
| Class-based interceptors in `registerAsync()` options | ✅ | Dependencies are resolved from `imports` and `extraProviders`; see [Interceptors with dependencies](/docs/guides/interceptors.md#interceptors-with-dependencies). |
| `registerAsync({})` with none of `useFactory`/`useClass`/`useExisting` | ✅ | Throws a clear error at setup (`HttpModule.registerAsync() requires one of useFactory, useClass or useExisting`) instead of silently registering a broken provider. |

## Types

`HttpModuleOptions` is a real, strictly-typed interface: every axios option this library maps and every undici option it passes through is spelled out, so a typo (`register({ timeuot: 5 })`) is a compile error, the same way it would be against `@nestjs/axios`' own `AxiosRequestConfig & { global? }`. `HttpModule.register()`/`.registerAsync()` accept `@nestjs/axios`' own `HttpModuleOptions`/`HttpModuleAsyncOptions` values directly.

The four overlapping request-config types this library used to export (`AxiosLikeRequestConfig`, `AxiosCompatibleRequestOptions`, `AxiosCompatibleRequestConfig`, `HttpRequestOptions`) are one type now, `AxiosLikeRequestConfig<D = any>`, used everywhere a request-level config is accepted (`request()`, `get`/`post`/etc.'s `config` argument, `axiosRef`'s promise methods). `post`/`put`/`patch` have a real second (body) type parameter: `post<T, D>(url, data?: D, config?: AxiosLikeRequestConfig<D>)`, matching `@nestjs/axios`.

`AxiosLikeResponse<T, D>` is structurally assignable to and from axios' own `AxiosResponse<T, D>`. A function declared `(): Observable<AxiosResponse<T>>` compiles when it returns this library's `HttpService.get()`, and a unit-test mock written `of({...} as AxiosResponse)` is assignable to `HttpService['get']`'s return type. This includes `config.headers`: this library's own `AxiosHeaders` class now mirrors axios' overloaded `set`/`get`/`has`/`delete`/`toJSON`/`normalize` signatures closely enough to be mutually assignable with axios' own `AxiosHeaders` class, so an axiosRef interceptor callback typed with axios' own `InternalAxiosRequestConfig` type-checks directly, with no cast. One narrow, unrelated gap remains for assigning the *whole* `axiosRef`/`HttpService` object to axios' own `AxiosInstance`/`HttpService` types, not needed for any of the above: axios' `Axios.request`/`get`/... carry a 4th generic (`R`, for fully overriding the response type) this library's methods don't mirror, with no effect at runtime.

axiosRef request interceptors receive a config whose `headers` is non-optional and narrowed to `AxiosHeaders` (matching axios' own `InternalAxiosRequestConfig.headers`), so `config.headers['Authorization'] = ...` and `config.headers.set(...)` (the README's own interceptor example) type-check under `strict` without a null check first.

`axios` itself is an optional peer (see [Errors](#errors)). Install it, and `error instanceof axios.AxiosError` also holds for errors this library throws.

## Module-level axios options

`HttpModule.register()` and `HttpModule.registerAsync()` detect these axios options:

| Option | Status | Notes |
|--------|:------:|-------|
| `baseURL`, `headers`, `auth`, `params`, `paramsSerializer`, `timeout`, `validateStatus`, `responseType` | ✅ | Applied to every request; per-request values win (headers and params are merged). `timeout` maps to undici's `headersTimeout`/`bodyTimeout`. `headers` accepts axios' method-keyed shape (`{ common: {...}, post: {...}, 'X-Flat': '...' }`), flattened per method at setup. |
| `maxRedirects`, `beforeRedirect` | ✅ | Applied to every request as the default; a per-request value wins. See [Request config](#request-config). |
| `maxBodyLength` / `maxContentLength` | ⚠️ | Size-limit checks (see error code note above). |
| `transformRequest` / `transformResponse` | ✅ | Replaces default serialisation/parsing entirely, like axios: `transformRequest` receives the raw `data`, `transformResponse` receives the raw response body (not yet JSON-parsed). |
| `httpAgent` / `httpsAgent` | ✅ | `maxSockets` maps to undici `connections`, `keepAlive` maps to `pipelining`, `timeout` maps to header/body timeouts (only when no module/request `timeout` is set). `httpsAgent`'s TLS options (`ca`, `cert`, `key`, `pfx`, `passphrase`, `rejectUnauthorized`, `servername`, `ciphers`, `minVersion`, `maxVersion`) map onto undici's `Agent({ connect: {...} })`. Module-level only. A per-request `httpAgent`/`httpsAgent` is ignored. |
| `proxy` | ✅ | An explicit `proxy: { host, port, protocol?, auth? }` creates an undici `ProxyAgent`. `proxy: false` disables proxying entirely, including the environment variables below. |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (and lower-case) | ✅ | Read once at module setup via undici's `EnvHttpProxyAgent`, matching axios' own default (`proxy-from-env`), but **only** when no `dispatcher`, `proxy` or `socketPath` is configured. As in axios, a custom `httpAgent`/`httpsAgent` doesn't turn this off; its TLS options still apply, including to targets reached through the proxy. This is a behaviour change from earlier versions, which never read these variables: with `HTTP_PROXY` set in the environment, a request to `http://127.0.0.1:...` now goes through that proxy by default unless `NO_PROXY` covers it or `proxy: false` is passed. See the note below. |
| `withCredentials` | ✅ | A no-op, matching axios itself on Node.js. Accepted (and kept in the types) for axios compatibility only. **Breaking change from 0.6:** used to enable a cookie jar shared by the whole service. See `cookieJar` below. |
| `socketPath` | ⚠️ | `Agent({ connect: { socketPath } })`, cached per path. Works at module level and per request; the request URL's host is still used for the `Host` header, as in axios. Accepts any path unconditionally. axios' `allowedSocketPaths`, an allowlist restricting which `socketPath` values are accepted, isn't implemented. |
| `httpVersion` | ✅ | `httpVersion: 2` maps to `Agent({ allowH2: true })`. Module-level only; needs a target that speaks HTTP/2 over TLS (undici has no plaintext HTTP/2). `http2Options` is accepted but has no effect (undici has no per-session HTTP/2 tuning). |
| `decompress` | ✅ | Applied as the default for every request; a per-request `decompress` overrides it. |
| `xsrfCookieName`, `xsrfHeaderName` | ❌ | Ignored (a warning is logged). |
| `onUploadProgress` / `onDownloadProgress` / `maxRate` / `formSerializer` | ✅ | Seeded into `axiosRef.defaults` once at setup; a per-request value wins. See [Progress callbacks, `maxRate` and `formSerializer`](#progress-callbacks-maxrate-and-formserializer). |
| `cookieJar` | - | Not an axios option. See [Cookies: `cookieJar`](#cookies-cookiejar) below. |

### Precedence: an explicit `dispatcher` always wins

A `dispatcher` passed directly in module options (`register({ dispatcher })`) is never overridden by `httpAgent`/`httpsAgent`, `socketPath`, `proxy`, `cookieJar` or the `HTTP_PROXY`/`HTTPS_PROXY` environment variables. None of that mapping runs once a `dispatcher` is set, so a `cookieJar` next to a `dispatcher` is ignored. A per-request `dispatcher` wins over all of those too, including a per-request `socketPath`. Use this to configure undici directly when the axios-shaped options above aren't expressive enough (see [Configuring undici directly](#configuring-undici-directly)).

Full precedence, highest first: a per-request `dispatcher` > a per-request `socketPath` > the module's own dispatcher (an explicit module `dispatcher`, or one built from `httpAgent`/`httpsAgent`/`socketPath`/`proxy`/env-proxy/`httpVersion`/`cookieJar`) > this `HttpService`'s per-service default `Agent`, built once at startup even with none of the above configured. See [Dispatchers and connection lifecycle](/docs/http/http.service.md#dispatchers-and-connection-lifecycle). **Breaking:** this replaces falling back to undici's own global dispatcher.

A request-level `socketPath` gets its own cached `Agent` per path (at most 32 paths; the oldest is closed to make room), so use a small, fixed set of socket paths.

Every dispatcher this module creates, meaning `httpAgent`/`httpsAgent`/`socketPath`/`proxy`/env-proxy/`httpVersion`/`cookieJar`, the cached per-path `socketPath` `Agent`s, and the per-service default `Agent`, is closed gracefully on `app.close()` (`HttpService` implements `OnModuleDestroy`), bounded by a short internal grace period. Past that period, anything still open, most likely an abandoned `responseType: 'stream'` response, is force-aborted instead of left hanging shutdown indefinitely. See [Dispatchers and connection lifecycle](/docs/http/http.service.md#dispatchers-and-connection-lifecycle). A `dispatcher` you supply yourself is never closed.

### Connection pooling and TLS: `httpAgent` / `httpsAgent`

```typescript
import { Agent } from 'http';
import { Agent as HttpsAgent } from 'https';

HttpModule.register({
  httpAgent: new Agent({ keepAlive: true, maxSockets: 10 }),
});

// TLS options (module-level only)
HttpModule.register({
  httpsAgent: new HttpsAgent({
    ca: fs.readFileSync('ca.pem'),
    rejectUnauthorized: true, // false to trust any certificate (e.g. local dev)
  }),
});
```

### Unix domain sockets: `socketPath`

```typescript
HttpModule.register({ socketPath: '/var/run/docker.sock' });
// or per request:
httpService.get('http://localhost/containers/json', { socketPath: '/var/run/docker.sock' });
```

### HTTP/2

```typescript
HttpModule.register({
  httpVersion: 2,
  httpsAgent: new HttpsAgent({ rejectUnauthorized: false }), // if needed for the target's cert
});
```

### Proxy

An explicit `proxy` always wins over the environment variables below:

```typescript
HttpModule.register({
  proxy: {
    host: 'proxy.example.com',
    port: 8080,
    auth: { username: 'user', password: 'pass' },
  },
});
```

With no `proxy` (and no `dispatcher`/`socketPath`), `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (case-insensitive) are read once at module setup, matching axios:

```bash
HTTP_PROXY=http://proxy.example.com:8080 NO_PROXY=localhost,127.0.0.1,.internal node app.js
```

```typescript
// Opt out entirely, even with HTTP_PROXY/HTTPS_PROXY set in the environment:
HttpModule.register({ proxy: false });
```

**Behaviour change / risk:** earlier versions of this library never read `HTTP_PROXY`/`HTTPS_PROXY`. If your environment sets them (common in corporate networks and some CI runners) and you don't pass `proxy: false`, requests, including ones to `localhost`/`127.0.0.1`, now go through that proxy by default unless `NO_PROXY` covers the target. This matches axios, but if you rely on `HttpModule.register({})` never proxying, either set `proxy: false` or add your local hosts to `NO_PROXY`.

### Size limits

```typescript
HttpModule.register({
  maxBodyLength: 10 * 1024 * 1024,    // 10MB request body limit
  maxContentLength: 50 * 1024 * 1024, // 50MB response content limit
});
```

Both are also accepted per request, and a per-request value always wins over this module-level one, as in axios. See the [Errors](#errors) table above for the exact codes/messages.

### Cookies: `cookieJar`

`withCredentials` is a no-op, matching axios itself on Node.js. It's accepted, and stays in the types, purely for axios compatibility:

```typescript
HttpModule.register({ withCredentials: true }); // accepted, does nothing
```

**Breaking change from 0.6:** `withCredentials: true` used to turn on a cookie jar shared by the whole `HttpService`. Every caller of that service saw every other caller's cookies, including a `Set-Cookie` from one user's upstream call being replayed on a different user's later request. Cookie handling is now opt-in through an explicit `cookieJar` module option instead, a [`tough-cookie`](https://www.npmjs.com/package/tough-cookie) `CookieJar` instance:

```typescript
import { CookieJar } from 'tough-cookie';

HttpModule.register({ cookieJar: new CookieJar() });
```

The module wraps whatever dispatcher it built from the other transport options (`httpAgent`/`httpsAgent`, `socketPath`, `proxy`, ...) in an [`http-cookie-agent`](https://www.npmjs.com/package/http-cookie-agent) `CookieAgent` around that jar, so combining `cookieJar` with those options works (unlike the old `withCredentials`, whose cookie agent could conflict with them).

- **Only a jar instance is accepted, never `true`.** A `true` shorthand that built one jar per service would just reintroduce the same shared-jar leak with a different trigger. Passing the jar yourself means you decide its scope: one jar per `HttpModule.register()` call (the common case, isolated per service), one jar shared on purpose across several services (pass the same instance to each), or a fresh jar per request/user if you build the `HttpService`, or a request-scoped wrapper around it, per request. This library doesn't do that for you.
- **Module-level only.** There's no per-request `cookieJar`. Wiring one up builds a `CookieAgent`, which only happens once per `HttpService`, in its constructor, never on the request path. A per-request jar would mean building one per request, or caching per jar and adding its own bookkeeping, for no clear benefit over just registering a second module with its own `cookieJar`.
- **Optional peer dependencies.** `http-cookie-agent` and `tough-cookie` are not installed by default; install them yourself (`npm i http-cookie-agent tough-cookie`) to use `cookieJar`. They're loaded lazily, only the first time a `cookieJar` is actually configured, so a project that never uses this option pays nothing for it. Requiring both costs about 100-150ms at startup. Setting `cookieJar` without them installed throws a clear error at module setup (`cookieJar requires the optional peer dependencies http-cookie-agent and tough-cookie; install them with npm i http-cookie-agent tough-cookie`) instead of a confusing `Cannot find module`.

### XSRF

XSRF headers are not added automatically. Use an interceptor:

```typescript
const xsrfInterceptor: HttpInterceptorFunction = (request, next) => {
  request.options.headers = { ...request.options.headers, 'X-XSRF-TOKEN': readToken() };
  return next.handle(request);
};

HttpModule.register({ interceptors: [xsrfInterceptor] });
```

## Configuring undici directly

The axios-shaped options above are mapped to undici once, at module setup. There's no per-request mapping cost. If they aren't expressive enough for your case, pass a `dispatcher` built directly from undici's own `Agent`/`ProxyAgent`/etc. and skip the mapping entirely. See [Advanced configuration (dispatchers)](/docs/guides/configuration.md#advanced-configuration-dispatchers) for the snippet.
