---
'nestjs-axios-undici': minor
---

`withCredentials` is now a no-op, matching axios itself on Node.js; cookie handling is opt-in through an explicit `cookieJar` module option instead.

**BREAKING:** `withCredentials: true` used to turn on a single cookie jar shared by the whole `HttpService` - a `Set-Cookie` from one caller's upstream response could be replayed on a different caller's later request (a real leak risk in a server handling multiple users). `withCredentials` is still accepted (and stays in the types, for axios compatibility), but no longer does anything.

To keep cookie handling, pass a `tough-cookie` `CookieJar` instance explicitly:

```typescript
import { CookieJar } from 'tough-cookie';

HttpModule.register({ cookieJar: new CookieJar() });
```

- Only a jar **instance** is accepted, never `true`: a shorthand that built one jar per service would just reintroduce the same shared-jar leak with a different trigger, so the caller owns the jar's scope explicitly (one per module, shared on purpose across modules by passing the same instance, or a fresh one per request/user if you manage that yourself).
- Module-level only - there's no per-request `cookieJar`. Wiring one up builds an `http-cookie-agent` `CookieAgent` (wrapping whatever dispatcher the module built from `httpAgent`/`httpsAgent`/`proxy`/`socketPath`), which happens once per `HttpService`, never on the request path.
- `http-cookie-agent` and `tough-cookie` moved from regular `dependencies` to **optional** peer dependencies (`peerDependenciesMeta.optional`), loaded lazily only when `cookieJar` is actually set. Requiring both unconditionally cost about 100-150ms at startup; a project that never uses `cookieJar` now pays nothing for them and doesn't need to install them. Install both (`npm i http-cookie-agent tough-cookie`) to use `cookieJar` - setting it without them throws a clear error at module setup instead of a bare `Cannot find module`.

See [Cookies: `cookieJar`](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options?id=cookies-cookiejar) for the full details.
