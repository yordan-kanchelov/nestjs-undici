---
'nestjs-axios-undici': minor
---

Response bodies now decode like axios:

- `+json` content types (`application/problem+json`, `application/vnd.api+json`, `application/hal+json`, ...) are parsed as JSON, not returned as a `Buffer`.
- Responses with no `Content-Type`, or `text/*`, `application/xml`, `application/javascript`, `application/x-www-form-urlencoded`, `image/svg+xml` or `application/octet-stream`, decode to a UTF-8 string; a JSON-looking string is parsed and silently falls back to the string on failure, matching axios' `forcedJSONParsing`/`silentJSONParsing`. Other binary content types are unaffected and still come back as a `Buffer`.
- `responseType: 'blob'` now returns a string, matching axios in Node.js (which has no native `Blob` decoding there); use `responseType: 'arraybuffer'` for binary downloads.
- Responses with `Content-Encoding: gzip`, `br` or `deflate` are decompressed automatically. Set `decompress: false` (per request or in `register()`) to get the raw compressed body, as in axios.
- `statusText` is now the server's actual reason phrase instead of always coming from a static table.
