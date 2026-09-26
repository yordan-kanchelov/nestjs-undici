---
'nestjs-axios-undici': minor
---

Request-side axios parity fixes: a numeric-string `timeout`, a throwing `beforeRedirect`, and a malformed request URL.

- `timeout: '250'` (a numeric string) is now parsed the same way axios' own `parseInt(config.timeout, 10)` does and enforced exactly like `timeout: 250`. It used to reject with undici's raw `ERR_BAD_REQUEST`/"invalid headersTimeout" instead. An already-numeric `timeout` pays no extra cost.
- A `beforeRedirect` callback that throws is now wrapped the way axios (`follow-redirects`) wraps it: `error.code` is `'ERR_FR_REDIRECTION_FAILURE'`, `error.message` is `"Redirected request failed: <original message>"`, and `error.cause` is the original error. It used to propagate the raw, unwrapped error with `code: undefined`.

**BREAKING:** a request URL with an embedded null byte or other C0 control character, or a bare `\n` (e.g. `'\u0000https:example.com/users'`), used to be silently "fixed" (the offending characters stripped, matching how a WHATWG `new URL()` parse is forgiving about them for a special scheme like `http:`/`https:`) and actually dispatched over the network. It's now rejected synchronously, before ever dispatching, with `error.code === 'ERR_INVALID_URL'` and the message `Invalid URL "<url>": missing "//" after protocol` - the same axios (`buildFullPath`'s `assertValidHttpProtocolURL`) gives for the same input. Code that (knowingly or not) relied on such a URL being silently normalized and sent now gets a synchronous `AxiosError` instead.
