---
'nestjs-axios-undici': minor
---

Duplicate response headers are now joined the way axios (running on Node's `http`) joins them, not left as undici's raw arrays.

**BREAKING:** a header that a server sends more than once (e.g. two `X-Foo:` lines) used to come back on `response.headers` as a `string[]`. It now matches Node's `IncomingMessage.headers` getter exactly:

- `set-cookie` is still always an array.
- `cookie` joins repeats with `'; '`.
- A fixed set of "no duplicates" headers (`content-type`, `content-length`, `user-agent`, `referer`, `host`, `authorization`, `proxy-authorization`, `if-modified-since`, `if-unmodified-since`, `from`, `location`, `max-forwards`, `retry-after`, `etag`, `last-modified`, `server`, `age`, `expires`) keep only the first value and silently drop the rest.
- Every other header (including any custom one) joins repeats with `', '`.

Code that read a duplicated header expecting an array (other than `set-cookie`) now gets a string instead. This also fixes a latent crash: a duplicated `Content-Type` used to reach `String.prototype.trim()` as an array and throw; it's now read the same singleton way axios reads it.
