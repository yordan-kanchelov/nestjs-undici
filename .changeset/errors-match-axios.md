---
'nestjs-axios-undici': minor
---

Errors, timeouts and size limits now match axios (checked against real axios 1.20 and its `follow-redirects` transport), and cover several fewer gaps than before.

**BREAKING: `timeout` is now a total (deadline) timeout, like axios, not an idle timeout.** Previously `timeout` only mapped to undici's `headersTimeout`/`bodyTimeout`, which reset on every chunk - a response body that trickled in slowly (or arrived just as the idle timer was about to fire) never timed out at all. `timeout` is now enforced from the moment the request starts until the response body is fully read (or, for `responseType: 'stream'`, until the response headers arrive - matching axios there too), with one timer per request, created only when `timeout > 0`. undici's own `headersTimeout`/`bodyTimeout` are still set alongside it, as a backstop. If your code relied on a slow-but-steady response never triggering `timeout`, it now will, at the configured value.

**BREAKING: size-limit error codes changed to match axios exactly.**

- `maxContentLength` exceeded now rejects with `ERR_BAD_RESPONSE` (was `ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED`), enforced against the *decompressed* size as bytes arrive - for a compressed response, the decompression itself is streamed and checked chunk by chunk (destroying both the compressed and decompression streams the moment the limit is crossed), so a small, highly compressible body ("gzip bomb") can't fully decompress in memory before being rejected.
- `maxBodyLength` is now actually enforced (previously silently ignored for most requests). A string/Buffer body over the limit rejects synchronously with `ERR_BAD_REQUEST`, "Request body larger than maxBodyLength limit" (axios checks this before ever dispatching). A stream body over the limit rejects as bytes are written, with `ERR_FR_MAX_BODY_LENGTH_EXCEEDED` - the code axios' own default (redirect-following) transport uses for this case.
- A module-level `maxContentLength`/`maxBodyLength` no longer overrides a per-request value - the more specific (per-request) value now wins, as in axios.
- The `SizeLimitInterceptor` (`createSizeLimitInterceptor`) is no longer registered automatically from `HttpModule.register({ maxBodyLength, maxContentLength })` (it used the old, wrong codes and buffered the whole response first); its own codes/messages were also updated to match axios, for anyone still using it directly.

**Other fixes:**

- Errors undici throws synchronously for a request this library can't send are now proper `AxiosError`s with `config`/`request` set, instead of a raw undici error class: an unsupported URL protocol (`tel:`, `ftp:`, ...) now gives axios' own `Unsupported protocol ${protocol}` (`ERR_BAD_REQUEST`), and undici's own argument-validation failures (an invalid header value, method, ...) get `ERR_BAD_REQUEST` instead of undici's raw code. A genuinely malformed URL (one `new URL()` itself rejects) still propagates unwrapped, matching `@nestjs/axios`.
- `error.request`/`response.request` are populated (`path`, `method`, `host`, `protocol`, and `res.responseUrl` - the final hop's URL, whether or not a redirect was followed), instead of a useless empty placeholder - matching the fields axios' own callers commonly read. Still not set for an error where axios itself never builds a request object either (an already-canceled signal, an unsupported protocol).
- `timeoutErrorMessage` and `transitional.clarifyTimeoutError` (code `ETIMEDOUT` instead of `ECONNABORTED`) are now honoured.
- `validateStatus: null` (or `undefined` set as an explicit key) now means every status resolves, as in axios; previously it fell back to the default 2xx range.
- Credentials embedded in a URL (`http://user:pass@host`) now become `Authorization: Basic ...`, as in axios, and are stripped from the request line/Host header; `config.auth` still wins when both are set.
- `allowAbsoluteUrls: false` (axios >=1.8) is now honoured: with a `baseURL`, an absolute request `url` is combined with it anyway (naive concatenation), instead of replacing it outright.
- Fixed two PR #15 review follow-ups: `resolveSignal` no longer leaves a listener on a long-lived caller `signal` when combined with a legacy `cancelToken`; `toAxiosError` now reads the actual per-request abort signal instead of the caller's pre-merge one, so cancellation-vs-timeout detection no longer depends on the `AbortError`/`UND_ERR_ABORTED` fallback working out.
- `AxiosError.prototype.toJSON()` now matches axios' key set exactly (added the browser-only fields, always `undefined` on Node, that axios itself includes) and serialises `config.headers` as a plain object when it's an `AxiosHeaders` instance.

**Known remaining gaps** (documented in the differential test suite, not fixed): a query-string apostrophe (`'`) always comes out `%27` (undici always dispatches through a WHATWG `new URL()` parse, which percent-encodes it for `http(s)` regardless of what string this library hands it - axios' own encoder leaves it as-is); undici rejects a header value with an embedded `\n` where Node's own `http` module (what axios uses) silently strips it; a timeout that lands after the response has already started streaming gives `ECONNABORTED`/"timeout of Nms exceeded" here, where axios' own internal race can instead give `ERR_BAD_RESPONSE`/"stream has been aborted" (depends on whether axios' own response object happens to exist yet when its timeout fires).

See [Errors](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options?id=errors) and the [error-handling guide](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/error-handling) for the full details.
