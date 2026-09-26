---
'nestjs-axios-undici': minor
---

Transport options (`httpsAgent`/`httpAgent`, `socketPath`, proxy, `httpVersion`) now work as they do in axios:

- **TLS.** A module-level `httpsAgent`'s TLS options - `ca`, `cert`, `key`, `pfx`, `passphrase`, `rejectUnauthorized`, `servername`, `ciphers`, `minVersion`, `maxVersion` - are mapped onto undici's `Agent({ connect: {...} })`. `httpAgent`/`httpsAgent`'s `keepAlive` (→ `pipelining`) and `maxSockets` (→ `connections`) now work correctly too (`keepAlive` mapping was previously a no-op). Module-level only; a per-request `httpAgent`/`httpsAgent` is still ignored.
- **`socketPath`** now actually works, at module and request level: `Agent({ connect: { socketPath } })`, cached per path. It used to be silently ignored (a plain request went to TCP `127.0.0.1:80`) or, combined with other axios options, threw `Invalid URL protocol`. The request URL's host is still used only for the `Host` header, matching axios.
- **Proxy environment variables.** `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (case-insensitive) are now read at module setup, matching axios' default (`proxy-from-env`), via undici's `EnvHttpProxyAgent` - **only** when no `dispatcher`, `proxy` or `socketPath` is configured. As in axios, a custom `httpAgent`/`httpsAgent` doesn't turn this off; its TLS options still apply, including to targets reached through the proxy. `proxy: false` opts out entirely, as in axios.

  **Behaviour change:** earlier versions never read these variables. If your environment sets `HTTP_PROXY`/`HTTPS_PROXY` (common on some CI runners and corporate networks), requests now go through that proxy by default - including to `localhost`/`127.0.0.1`, unless `NO_PROXY` covers it. Pass `proxy: false` if you don't want that.
- **HTTP/2 opt-in.** `httpVersion: 2` maps to `Agent({ allowH2: true })` at module level (needs a target that speaks HTTP/2 over TLS; undici has no plaintext HTTP/2).
- **Precedence.** An explicit `dispatcher` (module- or request-level) always wins over all of the above - none of this mapping runs once one is set.

Also removed: the dead `__axiosCompat.baseURL` code path (baseURL was already applied correctly elsewhere; this one broke on a `UrlObject` URL) and the `unix:`-prefixed URL rewrite `socketPath` used to attempt.
