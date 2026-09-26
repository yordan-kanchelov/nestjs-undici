---
'nestjs-axios-undici': minor
---

Requests now send axios' default headers:

- `Accept: application/json, text/plain, */*`.
- `User-Agent: nestjs-axios-undici/<version>` (axios sends `axios/<version>`). Override it the axios way, `httpService.axiosRef.defaults.headers.common['User-Agent'] = '...'`, or through module/per-request headers.
- `Accept-Encoding: gzip, deflate, br`, only when decompression is enabled (unlike axios, `compress` isn't advertised since neither library decodes it). A module-level `decompress: false` omits the header entirely.
- A POST/PUT/PATCH with no body still gets the default `Content-Type: application/x-www-form-urlencoded`, matching axios; a `Blob` body's own `type` is now used as its `Content-Type` instead of that default.

The defaults are seeded into `axiosRef.defaults.headers.common`, so they can be read and changed at runtime the axios way. Module `headers` (`register()`/`registerAsync()`) and per-request `headers` override them case-insensitively, and a header explicitly set to `undefined`/`null` removes a default, as in axios.

**Precedence change:** module `headers` now take precedence over `axiosRef.defaults.headers`, for any header both set, not only the new built-in defaults. Before, a header set at runtime through `axiosRef.defaults.headers.common[...]` won over the same header from `register({ headers })`. To change a header at runtime, set it in `axiosRef.defaults` and leave it out of the module `headers`, or set it per request.

`register({ headers: { common: {...}, post: {...} } })` now flattens axios' method-keyed header shape per method at setup, instead of sending literal `common`/`post` headers.
