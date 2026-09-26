---
'nestjs-axios-undici': minor
---

axiosRef request/response interceptors now run over one axios-shaped config object, carried through to `response.config`/`error.config`, matching axios:

- **Config shape.** Interceptors, `response.config` and `error.config` now see: raw (unserialised) `data`; `params` and `baseURL` as given (not merged into `url`); `url` as given (not combined with `baseURL`); a lower-case `method`; `headers` as `AxiosHeaders` (with `set`/`setAuthorization`/`setContentType` working); and any custom field set on the config (for example a `_retry` flag) survives a round trip through `error.config`. Before, `response.config`/`error.config` were rebuilt separately with the serialized body, the full combined URL, an upper-case method and no custom fields - so a "retry once on 401" interceptor (`if (!cfg._retry) { cfg._retry = true; return axiosRef.request(cfg) }`) looped forever, replaying a POST through `error.config` sent an empty body, and packages built on this pattern (`axios-retry`, `axios-auth-refresh`) didn't work.
- **Interceptor order changed to match axios**: request interceptors now run last-registered-first (LIFO), response interceptors first-registered-first (FIFO) - both were the other way round before.
- `runWhen` and `synchronous` (the 3rd argument to `interceptors.<request|response>.use()`) are now honoured; `runWhen` is evaluated once per request, against the config as built, before any interceptor has run - as in axios.
- **`transformRequest`/`transformResponse`** (module- and request-level) now run against the raw request data / raw response body, replacing default serialisation/parsing entirely when set - matching axios. Before, module-level transforms ran through a generic interceptor that only ever saw the already-serialised undici body (for requests) or the already-parsed value (for responses), and per-request transforms were silently ignored.
- `HttpService.interceptorCount` now also counts live axiosRef request/response interceptors (it previously only counted module-registered ones, since axiosRef interceptors no longer share that internal list).
- Fixed a pre-existing bug in `AxiosHeaders`: spreading an instance (`{ ...config.headers }`, a common pattern for adding a header in an interceptor) leaked its internal storage as an enumerable `headers` property, which undici then rejected as an invalid header value.
- Added `AxiosHeaders#setAuthorization`, `#setContentType` and `#getContentType`.

Requests with no axiosRef interceptors and no transforms keep the fast path; only `response.config`/`error.config` are built for them.

`transformResponse` follows axios for binary and stream responses: it is skipped for `responseType: 'stream'` and receives the raw `Buffer` for `'arraybuffer'`.
