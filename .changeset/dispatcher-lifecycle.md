---
'nestjs-axios-undici': minor
---

Every `HttpService` now owns its own undici dispatcher end to end, and closes what it creates on shutdown (checked against real axios 1.20 semantics where relevant).

**BREAKING: per-service default dispatcher, no more falling back to undici's global dispatcher.** Each `HttpService` builds its own undici `Agent` once, at construction (`allowH2: false` unless `httpVersion: 2`, which already builds its own dispatcher and wins over this default), from this package's own undici copy - not from `undici.getGlobalDispatcher()`. Precedence, highest first: a per-request `dispatcher` > a per-request `socketPath` > the module's own dispatcher (an explicit module `dispatcher`, or one built from `httpAgent`/`httpsAgent`/`socketPath`/`proxy`/env-proxy/`httpVersion`/`cookieJar`) > this per-service default. `undici.setGlobalDispatcher()` elsewhere in the process has **no effect** on requests made through `HttpService` any more. This also fixes the "two copies of undici" case (a Node.js version bundling its own undici could previously own the global dispatcher, so a plain request silently ran on a completely different connection pool than the one this library's own undici copy manages) and undici 8's default HTTP/2 negotiation on the no-transport-options path (this default is always built with `allowH2: false`).

**BREAKING: `HttpService` implements `OnModuleDestroy`.** `app.close()` (or `moduleRef.close()` in a test) now gracefully closes (`Dispatcher#close()`, not `destroy()` - lets in-flight requests finish) every dispatcher this library created for that service: the per-service default `Agent`, the module-built dispatcher (whichever of `Agent`/`ProxyAgent`/`EnvHttpProxyAgent`/`CookieAgent` was built), and every cached per-path `socketPath` `Agent`. A `dispatcher` you supplied yourself - through module options, a per-request option, or `setDispatcher()` - is never closed by this library. Previously, none of these were ever closed, so a real app that called `app.close()` could still see a lingering open connection afterwards.

**BREAKING: the static `HttpModule` import (no `register()` call) no longer shares one options object across every app that imports it.** The default options are now built by a factory instead of one shared `{}` literal, so each app's `HttpService` gets its own - previously, `setDispatcher()`/the old `setGlobalDispatcher()` (or anything else mutating the shared object) in one app leaked into every other app's `HttpService` that also imported the bare `HttpModule`.

**BREAKING: `HttpService` member cleanup**, per the "breaking changes are fine before 1.0.0" decision:

- **`setGlobalDispatcher` is renamed to `setDispatcher`, with no alias.** It never touched undici's own global dispatcher - only this service - so the old name was misleading either way. If the dispatcher it replaces is one this service created itself (the module-built dispatcher, or the per-service default when nothing else was configured), that dispatcher is now closed; a dispatcher you supplied yourself is never closed.
- **`setInterceptors()` is no longer public.** It existed only for `HttpModule.register()`/`.registerAsync()` to hand the fully-resolved interceptor list to a freshly-constructed `HttpService`; that now happens through the constructor instead. Use `addInterceptor()` at runtime, or the module's `interceptors` option at setup.
- **`interceptorCount` is now the real count of the module-registered (`addInterceptor()`/module `interceptors`) chain only.** It used to add 1 for a phantom "axios response adapter" interceptor that hasn't existed since the axiosRef pipeline refactor, and separately counted `axiosRef`'s own request/response interceptors (a different chain, with no equivalent count on real axios either).
- **`undiciRef` now returns a read-only, frozen snapshot** (a fresh copy on every read, internal `__`-prefixed keys stripped), not the live, mutable options object. Mutating it already had no effect on `axiosRef.defaults`-backed fields (headers, timeout, ...); it's read-only for the rest too now.

**Fix: axios-only keys no longer leak into undici's per-request dispatch options.** `auth`, `httpAgent`, `httpsAgent`, `proxy`, `httpVersion`, `cookieJar`, `withCredentials`, `xsrfCookieName`/`xsrfHeaderName` and the internal `__`-prefixed keys used to be spread wholesale onto every request (harmlessly ignored by undici itself, but visible to anything inspecting the options, such as a custom `Dispatcher`). They're stripped once, at setup, instead of being carried on every request.

**Fix: axios compatibility warnings are now logged through Nest's own `Logger`** (context `HttpModule`), not `console.warn`.

See the [migration guide](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/migration-guide?id=dispatcher-lifecycle-and-httpservice-members) for the full list.

**Tests using undici's `MockAgent` with `setGlobalDispatcher(mockAgent)` must change.** The mock no longer intercepts `HttpService` requests; they reach the real network. Pass it as `HttpModule.register({ dispatcher: mockAgent })` or call `httpService.setDispatcher(mockAgent)`.
