# nestjs-axios-undici vs @nestjs/axios: behavioural compatibility audit before 1.0

**Setup.** Tested an export of origin/main (commit 2bcdf30) against axios 1.20.0 (the latest) and @nestjs/axios 4.0.1 under Jest. @nestjs/axios 12.0.1 is ESM-only, so it can't load in the repo's CJS Jest setup. Its `HttpService` has the same `makeObservable` as 4.0.1 and only adds `query()`. A separate Node ESM check (`plan/prototypes/compat/nest12-smoke.mjs`) confirms the built lib works with Nest 12.1 and @nestjs/axios 12.

**Prototype tests.** They are in `plan/prototypes/compat/`; copy the folder to `tests/diff/` to run it. Each test sends the same call through both libraries to one local node:http server and asserts `undici == axios`. Run them with `npx jest tests/diff --testTimeout=8000`. Result: 213 tests, **100 fail**; each failure is a real difference.

- `harness.ts` holds the server, `pair()` and the result normalizers.
- Specs:
  - `response.diff.spec.ts`
  - `request.diff.spec.ts`
  - `errors.diff.spec.ts`
  - `interceptors.diff.spec.ts` (also covers Observable behaviour)
  - `module.diff.spec.ts`
  - `tls-socket.diff.spec.ts`
  - `ecosystem.diff.spec.ts`
  - `retry-once.diff.spec.ts`
- Type check: `types/migration-types.ts`.
- Hot-path cost benchmark: `bench/hot-path-costs.js`.
- Ad-hoc template: `probe.ts` with `p0.probe.spec.ts`.
- Extra dev packages, installed with `--no-save`: axios@1.20.0, @nestjs/axios@4.0.1, axios-retry, axios-mock-adapter, axios-auth-refresh.
- Jest gotcha: `it.each` callbacks must be written `(...[, a, b]: any[])`. A callback with more parameters than table columns is treated as expecting `done()` and hangs.

**Benchmark** (raw undici, 20k requests, concurrency 50, baseline about 19k req/s):

| Added per request | Throughput cost |
|---|---|
| AbortController | −3 to 5% |
| AbortController plus a timer | −8 to 10% |
| undici redirect interceptor | −10 to 20% (noisy) |
| static default headers | −2 to 3% |

These are upper bounds; the cost end to end through the library will be smaller.

## Must fix for 1.0

1. **Custom fields on `error.config` are lost, so "retry once" interceptors loop.**
   - Repro: `if (!cfg._retry) { cfg._retry = true; return axiosRef.request(cfg) }` on a 401 sends 2 requests with axios and loops forever here (capped at 20 in the test). A persistent synchronous error (bad header) blocks the event loop.
   - Replaying a POST through `error.config` sends an **empty body**.
   - axios-retry sends 1 request instead of 3, and axios-auth-refresh never replays.
   - Cause: `response.config` and `error.config` are rebuilt without `data`. Request interceptors receive a copy where `data` is the serialized string, `url` is the full URL, there is no `params` or `baseURL`, `method` is `'POST'` instead of `'post'`, and `headers` has no `setAuthorization` or `setContentType`.
   - Fix: carry one config object through request interceptors, dispatch and `response.config`/`error.config`, with raw `data`, `params`, `baseURL`, lower-case `method` and `AxiosHeaders`.
   - Cost: only on the axiosRef interceptor path. Plain requests can build the config lazily through a getter, so no cost.
2. **Request interceptors run once per Observable, not once per subscription.** They start in a Promise when `get()` is called.
   - Repro: `get().pipe(retry(2))` sends the X-N headers `2,2,2`; axios sends a fresh value on each attempt. Token refresh or signing combined with `retry()` breaks.
   - Fix: wrap the interceptor in `defer()`. No cost.
3. **Unsubscribing does not abort the request** (the docs mark this unsupported, ❌).
   - Repro: `timeout()`, `race` and `switchMap` leave upstream requests running; the server sees `aborted=false`.
   - Fix: an AbortController per subscription, aborted in teardown only if nothing was emitted and `responseType` is not `stream`, as @nestjs/axios does.
   - Cost: per request, about 3–5% raw.
4. **Response bodies are decoded differently.**
   - `application/problem+json`, `vnd.api+json` and `hal+json` come back as a **Buffer**.
   - Responses with no content type, `octet-stream`, JavaScript, form-urlencoded or SVG come back as a Buffer; axios returns a UTF-8 string.
   - JSON sent as `text/plain` is not parsed.
   - Fix: port axios' default `transformResponse` (decode to string unless `arraybuffer` or `stream`; `forcedJSONParsing`; `silentJSONParsing`).
   - Cost: none for JSON; one try-parse for text, gated on the first character.
5. **Compressed responses become garbage strings** (gzip, br, deflate).
   - Fix: decompress with zlib when `Content-Encoding` is present, and honour `decompress: false`.
   - Cost: none for uncompressed responses.
6. **Default request headers are missing.** axios sends `Accept: application/json, text/plain, */*`, `User-Agent: axios/x` and `Accept-Encoding`; this library sends none of them.
   - Repro: an endpoint that negotiates on `Accept` returns HTML instead of JSON. APIs that require a User-Agent (for example GitHub) reject the request.
   - Fix: seed `defaults.headers.common` at module setup (with a UA that names this library). Cost is about 0 if merged at setup.
7. **Redirects are not followed by default** (documented).
   - A redirect loop fails with `UND_ERR_INVALID_ARG` instead of `ERR_FR_TOO_MANY_REDIRECTS`.
   - A POST 301/302 converted to GET keeps its `Content-Type`.
   - There is no `request.res.responseUrl` and no `beforeRedirect`.
   - Fix: default `maxRedirects` to 21 and follow redirects in the service only when a 3xx with `Location` arrives. That costs nothing for non-3xx responses, whereas the undici redirect interceptor costs 10–20%.
8. **`httpsAgent` TLS options are ignored.** `rejectUnauthorized: false`, `ca`, `cert`/`key` all fail with `DEPTH_ZERO_SELF_SIGNED_CERT`.
   - Fix: map `agent.options` to `new Agent({ connect: {...} })`, with separate dispatchers for http and https. Setup-time cost only.
9. **`socketPath` is silently ignored and the request goes to TCP 127.0.0.1:80.** It is missing from the `hasAxiosOptions` check, and the docs' description of the failure is out of date.
   - Fix: `Agent({ connect: { socketPath } })`, created at setup or cached per path.
10. **`withCredentials` turns on a cookie jar shared by the whole service**; axios ignores this option in Node. In a server this can leak cookies between users.
    - Fix: make it a no-op (a breaking change, so it belongs before 1.0) and add an explicit `cookieJar` option.
11. **axios-style method keys in module headers are sent literally.** `register({ headers: { common: {...}, post: {...} } })` sends headers named `common` and `post` with the value `[object Object]`. Fix: flatten them at setup.
12. **Common migration code fails to type-check.** 7 errors, including `Promise<AxiosResponse<T>>` return types and passing an `AxiosRequestConfig` to `get`/`post`/`request`. Also, `e instanceof axios.AxiosError` compiles but is **false** at runtime.
    - Fix: make the response and config types structurally assignable to axios' types.
    - Make `axios` an optional peer dependency and, when it is installed, set `Object.setPrototypeOf(AxiosError.prototype, axios.AxiosError.prototype)` (the same for CanceledError). No cost.

## Should fix: common, but narrower

- **axiosRef interceptors** (none of these fixes has a hot-path cost):
  - Order is FIFO for requests and LIFO for responses, the reverse of axios on both.
  - `runWhen` and `synchronous` are ignored.
  - `handlers` and `forEach` are missing.
- **axiosRef as an axios instance:**
  - It is not callable (`axiosRef(config)`, which axios-retry uses).
  - `getUri`, `create`, `postForm`, `putForm`, `patchForm` and `query` are missing.
  - `defaults.adapter` is ignored, so **axios-mock-adapter does not work** (the usual way to mock HTTP in NestJS tests); the request goes to the network. Only call a function adapter when one is set.
  - Of `defaults`, only `baseURL`, `headers` and `timeout` are honoured; `validateStatus`, `params`, `maxRedirects`, `responseType`, `transform*` and `adapter` are ignored.
  - Module-level `headers` and `timeout` do not show up in `defaults`.
- **`HttpService.query()` is missing**; @nestjs/axios 12 with axios ≥1.13 has it.
- **`transformRequest` / `transformResponse`:**
  - Per request they are silently ignored.
  - At module level they get serialized or already-parsed data, not the raw input axios gives them.
  - `transformResponse` does not receive `(headers, status)`.
  - Run them in the axios pipeline only when set.
- **`AxiosHeaders` port is incomplete.**
  - 22 methods are missing, including `setContentType`, `setAuthorization`, `concat`, `normalize` and `toString`.
  - `new AxiosHeaders('A: b\n...')` produces keys indexed by character.
  - `response.headers` is a plain object with no `.get()`, and duplicate headers come back as arrays where Node joins them as `'a, b'`.
  - Fix by wrapping the headers and joining duplicates in one pass (per-request cost proportional to the number of headers).
- **Timeouts:**
  - Built on undici's idle timers, so a body that trickles in never times out (axios limits total time).
  - `timeoutErrorMessage` and `transitional.clarifyTimeoutError` are ignored.
  - Without a timeout, undici's 300 s defaults apply; axios has no limit.
  - Fix: a deadline timer only when a timeout is set.
- **Errors:**
  - `error.request` and `response.request` are never set.
  - Errors undici throws synchronously (unsupported protocol, CRLF in a header value) come through as a raw `InvalidArgumentError` with `isAxiosError` false.
  - `error.config.method` is upper case.
  - All of these are on the error path only.
- **Size limits:**
  - A module-level `maxContentLength` overrides the per-request value.
  - That error has code `ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED` and name `Error`; axios uses `ERR_BAD_RESPONSE`.
  - A per-request `maxBodyLength` is ignored.
- **Smaller options:**
  - Credentials in the URL (`http://u:p@host`) are dropped silently. Only parse them when the URL contains `@`.
  - `validateStatus: null` is not supported.
  - `allowAbsoluteUrls: false` is ignored.
  - `postForm` with a plain object is sent url-encoded, not multipart.
  - `HTTP_PROXY`/`NO_PROXY` are not read; use `EnvHttpProxyAgent` at setup, with `proxy: false` to opt out.

## Edge cases (fix cheaply or document)

- `statusText` comes from a fixed table, not the server's reason phrase, and an unknown status gives `'Unknown'` where axios gives `'unknown'`.
- A dropped connection reports `other side closed` / `SocketError`; axios reports `socket hang up` / `Error`.
- `responseType: 'blob'` gives a Buffer; axios in Node gives a string.
- Non-string `data` (`5`, `true`) and string `params` are sent, where axios rejects them.
- A `Blob` body loses its type as `Content-Type`.
- `'` in the query string is sent as `%27`, because WHATWG URL parsing encodes it.
- A POST with no body has no default `Content-Type`.
- axios ignores the XSRF options in Node too, so the warning is noise; mark it as a no-op.
- Plain `HttpModule` in @nestjs/axios shares the global axios instance, so interceptors are global; this library keeps them per service. That is a benign difference; document it.

## axios features missing entirely (feasibility, cost)

| Feature | Feasibility | Cost |
|---|---|---|
| `decompress` control | easy | none unless the response is compressed |
| `socketPath` | easy | setup only |
| `onUploadProgress` / `onDownloadProgress` / `maxRate` | medium (wrap the body stream) | only when set |
| Proxy environment variables | easy | setup only |
| HTTP/2 (`httpVersion: 2`, `http2Options`) | easy via `Agent({ allowH2: true })` | setup only |
| `transitional` options (`clarifyTimeoutError`, `forcedJSONParsing`, `silentJSONParsing`) | easy | error or parse path only |
| `timeoutErrorMessage` | easy | error path only |
| `beforeRedirect` | easy with the manual redirect handling above | only when redirecting |
| `lookup` / `family` | easy (undici `connect` options) | setup only |
| `responseEncoding` | easy | only when set |
| `parseReviver` | easy | only when set |
| `formSerializer`, `formDataHeaderPolicy` | medium | postForm path only |
| `redact` / `sensitiveHeaders` (axios 1.20) | easy | error path only |
| `adapter` (function) | easy | only when set |
| `allowedSocketPaths` | easy | with `socketPath` |
| `insecureHTTPParser` | not possible (undici has no option) | document |
| `adapter: 'fetch'` / `fetchOptions` | not applicable | document |

## Proposed PRs (★ = must-fix for 1.0)

1. ★ **fix(response): decode bodies like axios.** Items 4 and 5, plus `blob`.
   - Files: `adapters/axios-response.adapter.ts`, `axios-response-type.adapter.ts`.
   - Done when: every `GET *`, `responseType *` and `compressed *` case in `response.diff.spec.ts` and `errors.diff.spec.ts` passes.
2. ★ **feat: axios default headers and Accept-Encoding.** Item 6.
   - Files: `axios-ref.factory.ts` (`createAxiosRefDefaults`), `axios-request.adapter.ts`.
   - Done when: the "default headers" and "negotiation" cases pass, and the benchmark shows no regression.
3. ★ **fix(observable): abort on unsubscribe; lazy interceptors.** Items 2 and 3.
   - Files: `services/http.service.ts` (`executeRequest`), `axios-interceptor.adapter.ts`.
   - Done when: the Observable-semantics block in `interceptors.diff.spec.ts` passes.
4. ★ **refactor(axiosRef): one axios config pipeline.** Item 1, interceptor order, `runWhen`, lower-case `method`, config shape, `transformRequest`/`transformResponse`.
   - Files: `axios-interceptor.adapter.ts`, `axios-request.adapter.ts`, `http.module.ts` (drop the transform interceptors).
   - Done when: `retry-once.diff.spec.ts` passes, `interceptors.diff.spec.ts` interceptor cases pass, and the transform cases in `module.diff.spec.ts` pass.
5. **feat(axiosRef): make it an axios instance.** Callable, `getUri`/`create`/form methods/`query`, `adapter`, full `defaults`; add `HttpService.query`.
   - Done when: `ecosystem.diff.spec.ts` and the surface/defaults tests pass.
6. ★ **fix: follow redirects by default** (manual handling on 3xx).
   - Done when: the redirect cases pass and non-3xx throughput is unchanged.
7. ★ **fix(config): transport options.** TLS options from agents, `socketPath`, proxy environment variables, method-key headers.
   - Files: `axios-config.adapter.ts`, `http.module.ts`, `http.service.ts` (`setupDispatcher`).
   - Done when: `tls-socket.diff.spec.ts` and the matching `module.diff.spec.ts` cases pass.
8. ★ **breaking: `withCredentials` becomes a no-op; add `cookieJar`.**
9. **fix(errors): match axios errors.** Wrap synchronous throws, set `request`, deadline timeouts, `timeoutErrorMessage`/`clarifyTimeoutError`, size-limit codes and precedence, `validateStatus: null`, URL credentials, `allowAbsoluteUrls`.
   - Files: `errors/axios-error.ts`, `http.service.ts`, `size-limit.interceptor.ts`.
10. ★ **types: axios interop.** Assignability, optional `axios` peer dependency with `instanceof` parity, complete `AxiosHeaders` port, response headers as `AxiosHeaders` with duplicates joined.
    - Done when: `types/migration-types.ts` compiles and the headers tests pass.
11. **docs:** update `docs/axios-supported-options.md` and `docs/migration-guide.md` for whatever remains. Corrections now: `socketPath` does not fail (it silently uses TCP); XSRF is a no-op in axios on Node too; "JSON with a JSON Content-Type ✅" is wrong for `+json` types.

To promote the prototypes into the repo's suite, pin `axios` to `^1.20` in devDependencies and add `form-data`.
