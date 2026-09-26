---
'nestjs-axios-undici': major
---

**1.0.0: a stable, axios-compatible `HttpModule`/`HttpService` on undici.**

1.0 makes the `@nestjs/axios` drop-in promise hold for real code. Every PR runs `@nestjs/axios`' own specs and axios' own HTTP adapter tests against this package, along with a side-by-side differential harness against `@nestjs/axios`. The remaining differences are listed, each with its reason, on the [Axios compatibility](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options) page.

Highlights since 0.6:

- **Behaviour matches axios:**
  - redirects are followed by default, like axios;
  - `axiosRef` is a real axios-like instance (callable, `create`, `getUri`, `*Form`, function adapters);
  - interceptor order and `config` shape follow axios;
  - errors (codes, timeouts, `maxContentLength`/`maxBodyLength`, cancellation) follow axios;
  - response decoding covers gzip, deflate, br, zstd and compress;
  - duplicate response headers are joined as in axios;
  - `data:` URLs, progress callbacks, `maxRate`, `formSerializer`, `parseReviver`, `sensitiveHeaders` and strict JSON parsing are supported.
- **Transport:**
  - TLS through `httpsAgent`;
  - `socketPath`;
  - HTTP(S) and environment proxies;
  - explicit `allowH2`;
  - an opt-in `cookieJar`;
  - a per-module dispatcher that's closed on shutdown.
- **API:**
  - strict `HttpModuleOptions`;
  - a trimmed public API, checked in CI against `etc/nestjs-axios-undici.api.md`;
  - `axios` as an optional peer, so `instanceof axios.AxiosError` also holds.
- **Performance:** the gains are kept. CI runs a CPU-per-request regression check on every PR and a full benchmark on release.

Upgrading from 0.6.x includes breaking changes. The minor entries below mark them **BREAKING**, and the [migration guide](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/migration-guide?id=upgrading-from-06x) groups them by area with what to change.
