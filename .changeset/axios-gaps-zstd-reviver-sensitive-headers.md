---
'nestjs-axios-undici': minor
---

Three axios compatibility gaps found by the upstream conformance suite are fixed:

- **`zstd` decompression.** `Content-Encoding: zstd` responses are now decoded, for both buffered and `responseType: 'stream'`, honouring `decompress`/`decompress: false` and `maxContentLength` (checked against the decompressed size, streamed) exactly like the existing gzip/br/deflate support. Feature-detected the way axios does (`zlib.createZstdDecompress`, present on every Node.js version this package supports - added in Node 22.15.0/23.8.0); on a hypothetical Node build without it, a zstd response is returned as the raw compressed bytes, matching axios' own fallback. The default `Accept-Encoding` still doesn't advertise `zstd` - axios itself only does when `transitional.advertiseZstdAcceptEncoding: true` is explicitly set (default `false`), so this matches axios' own out-of-the-box behaviour; override the header yourself if you want to advertise it.
- **`parseReviver`.** axios' reviver for the default (no custom `transformResponse`) JSON parsing is now passed to `JSON.parse`. Supported on per-request config, `axiosRef.defaults` and module options (`register({ parseReviver })`), with the same request > `axiosRef.defaults` > module precedence as every other passthrough default. No cost when unset.
- **Redirect `sensitiveHeaders`.** `config.sensitiveHeaders` (an array of extra header names, validated the same way axios validates it - `ERR_BAD_OPTION_VALUE` otherwise) is now honoured, dropping those headers alongside the built-in `Authorization`/`Cookie`/`Proxy-Authorization` on a redirect. Matches axios' own two-part rule exactly: the built-in 3 stay subdomain-exempt and downgrade-only, while a header named in `sensitiveHeaders` is dropped on *any* change of origin (including a subdomain redirect or an http→https upgrade). Settable at module level too; a per-request value wins.

See `docs/axios-supported-options.md` for the details of each. All three were previously listed as known gaps there; that's now updated.
