---
'nestjs-axios-undici': minor
---

`onUploadProgress`/`onDownloadProgress`, `maxRate` and `formSerializer` are now supported (plan.md phase 2, the last item before docs).

**Progress callbacks and `maxRate`:**

- `onDownloadProgress`/`onUploadProgress` fire with axios' own `AxiosProgressEvent` shape (`loaded`, `total`, `progress`, `bytes`, `rate`, `estimated`, `lengthComputable`, `upload`/`download`), throttled the way axios throttles it (at most every ~333ms, plus a final flush so the last event always reflects the true final state). `onDownloadProgress` works with every `responseType`, including `'stream'`. `onUploadProgress` works for a string, `Buffer`, stream, or `FormData`/`postForm` body - a `postForm`/multipart body doesn't have a known `total` (this library doesn't pre-compute the encoded multipart size the way axios' own `formDataToStream` does), so `total`/`progress` stay `undefined` there even though `loaded` still tracks real bytes written.
- `maxRate` (a number, or `[upload, download]`) throttles actual throughput in both directions, via the same windowed-chunk-splitting algorithm axios' `AxiosTransformStream` uses.
- All three work at request level, through `axiosRef.defaults`, and through `HttpModule.register()`/`.registerAsync()` options (seeded into `axiosRef.defaults` once at setup, like every other passthrough default) - request config always wins.
- A request that sets none of these pays no measurable extra cost: the request/response body is only ever wrapped in a counting/throttling stream when at least one is actually configured.

**`formSerializer`:**

- Axios' own options for turning a plain object/array into `FormData`/a url-encoded body (`{ visitor, dots, metaTokens, indexes, maxDepth }`, ported from `lib/helpers/toFormData.js`) are now honoured by `postForm`/`putForm`/`patchForm`, and by a plain request whose `Content-Type` is explicitly `application/x-www-form-urlencoded` or `multipart/form-data`. Defaults match axios exactly (`dots: false`, `metaTokens: true`, `indexes: false`, `maxDepth: 100`); a custom `visitor` replaces the default traversal entirely. With no `formSerializer` set, behaviour and cost are unchanged.
- The reverse also works: a real `FormData` sent as `data` with an explicit `Content-Type: application/json` is converted to a plain object first (axios' `formDataToJSON`) and then `JSON.stringify`d, instead of being encoded as multipart - matching axios' default `transformRequest`.

**Types:** `HttpModuleOptions`, `AxiosLikeRequestConfig` and `AxiosRefDefaults` all gained `onUploadProgress`/`onDownloadProgress`/`maxRate`/`formSerializer`. New exported types: `AxiosProgressEvent`, `FormSerializerOptions`, `SerializerVisitor`, `FormDataVisitorHelpers`, `FormDataLikeTarget` - matching axios' own type names field-for-field, including `SerializerVisitor`'s `path: Array<string | number> | null` (no `undefined`) so a callback written against axios' own types is mutually assignable.

Not implemented: `formDataHeaderPolicy` (a `form-data`-package-specific option, not part of `formSerializer` itself) and pre-computing a `Content-Length` for a multipart upload (see the `onUploadProgress` note above) - both documented in `docs/axios-supported-options.md`.
