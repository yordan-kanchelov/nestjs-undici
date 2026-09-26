# Exploration report: package quality and public API

Explorer run on 2026-09-25 against origin/main. Prototype scripts are in `plan/prototypes/quality/`.

## Verified findings

- **Packaging is clean.** publint finds nothing. attw is green for node10, node16 (CJS and ESM) and bundler, and ESM named imports work. The tarball is 79 KB with 139 files. It includes `src/`, so the `.map` → `../src` links resolve.
- **Dependency check.** `scripts/check-deps.js` scans the runtime imports and `.d.ts` imports in `lib/`.
  - The only failure was `@nestjs/core` in `http.module.js`, fixed in 0.6.1.
  - `reflect-metadata` is a peer but is never imported. Only the global `Reflect` in `InjectTypedHttpService` uses it.
- **Peer ranges match reality.** Smoke tests pass on the minimums (Nest 10.0.0, rxjs 7.1.0, undici 7.0.0, reflect-metadata 0.1.13). They also pass on the newest versions: Nest 12.1 (ESM-only, loaded through require(esm)) with undici 8.11.
  - **Mismatch:** undici 8 needs Node >= 22.19, but `engines` says >= 22.12.
- **Two copies of undici.** When Node's bundled undici 6.24 owns the global dispatcher (because the global `fetch` was used before npm undici loaded), plain requests quietly run on Node's bundled Agent. Only redirects use the module-level `fallbackAgent`.
  - Result: two connection pools, and the user's undici version is ignored for default requests.
  - undici 8 uses a different global symbol, so it isn't affected.
- **`tsc --strict` on `src` gives only 7 errors:**
  - two implicit-any `transform` params
  - three from `registerAsync({})` with no factory, which creates a provider whose `provide` is `undefined`
  - two where `headersTimeout` can be null
- **`forceExit` is unnecessary.** Without it, and with `--detectOpenHandles`, all 330 tests pass and no open handles are reported. It only hides leaks.

## Runtime problems confirmed by probes (`scripts/runtime-probes.js`, `scripts/socketpath-probe.js`)

- `baseURL` plus a UrlObject URL requests `/[object%20Object]`. The cause is the dead `__axiosCompat.baseURL` branch in `http.service.ts`.
- `socketPath` on its own is silently ignored and the request goes to TCP 127.0.0.1:80. Combined with other axios options it fails with `Invalid URL protocol`, because the code invents a `unix:` URL.
- Module config leaks into undici's `dispatch()` options: raw `auth` (credentials), `proxy`, `baseURL`, `timeout` and `__axiosCompat`.
- **Unsubscribing does not abort the request.** @nestjs/axios cancels on teardown (`makeObservable`). Here, rxjs `timeout()`, `switchMap` and `takeUntil` leave requests running.
- **Dispatchers the module creates are never closed.** After `module.close()` the server still sees a connection from the CookieAgent or Agent.
- **A static `HttpModule` import shares one `{}` options object across apps.** Calling `setGlobalDispatcher` in app 1 changes app 2.
- `interceptorCount` returns 1 on a fresh service.
- `response.config.headers` is a plain object at runtime, but it is typed `AxiosHeaders | AxiosRequestHeaders`.

## Found by reading the code

- `setInterceptors()` replaces every interceptor, including ones added through `axiosRef`.
- The response check in `SizeLimitInterceptor` never runs: it only ever sees the response after conversion.
- `maxContentLength` is only checked after the whole body is buffered.
- `keepAlive` is mapped to `pipelining`, which has no effect.
- TLS options on `httpsAgent` (`ca`, `cert`, `rejectUnauthorized`) are silently ignored.
- `HTTP_MODULE_ID` is provided but never injected. `INTERCEPTOR_METADATA` is unused.
- `axios-config.adapter.ts` has unused imports.
- `console.warn` / `console.info` calls at `http.module.ts:187` and `axios-config.adapter.ts:148`.

## Type compatibility with @nestjs/axios (`typecompat/run.sh`)

The script compiles 16 typical usage cases with `--strict` against both packages. @nestjs/axios passes all 16; ours fails 8:

- `post<User, Dto>()`: there is no second (D) type parameter.
- A function whose declared return type is `Observable<AxiosResponse<T>>`.
- `config.headers['Authorization'] = …` in an axiosRef interceptor (the README's own example).
- `config.headers.set(…)`, which works at runtime.
- Callbacks typed with axios' `InternalAxiosRequestConfig`.
- Test mocks written as `of({...} as AxiosResponse)`, because our headers type is too narrow.
- A typo such as `{ timeuot: 5 }` is accepted, because `HttpModuleOptions` is effectively `any` (`& any`, `Partial<any>`).

With the Nest 11 starter settings (only `strictNullChecks`), 7 of these still fail.

## Public API: 57 exported symbols (@nestjs/axios exports about 6)

**Keep:**
- `HttpModule`, `HttpService`, `HttpModuleOptions`, `HttpModuleAsyncOptions`, `HttpModuleOptionsFactory`
- `HttpInterceptor`, `HttpInterceptorHandler`, `HttpInterceptorRequest`, `HttpInterceptorFunction`
- `AxiosError`, `CanceledError`, `isAxiosError`, `isCancel`
- `AxiosHeaders`, `AxiosHeaderValue`, `RawAxiosHeaders`, `AxiosRequestHeaders`
- `AxiosRef`, `AxiosRefDefaults`, `AxiosInterceptorManager`, `AxiosLikeResponse`
- one request-config type
- `AxiosParamsSerializer`, `AxiosResponseType`, `AxiosCancelTokenLike`

**Remove before 1.0:**
- The legacy typed module: `TypedHttpModule`, `InjectTypedHttpService`, `ExtractHttpServiceType`, `HTTP_SERVICE_TYPE`, `TypedDynamicModule`. It is only a marker, and the decorator rewrites `design:paramtypes`.
- `AxiosResponseAdapterInterceptor` and `axiosResponseAdapter`, which now do nothing.
- `STATUS_TEXT_MAP`, `SizeLimitInterceptor`, `createSizeLimitInterceptor`, `SizeLimitOptions`.
- The internal error helpers `toAxiosError` (returns `any`), `buildAxiosErrorConfig` and `createStatusError`.
- `HTTP_MODULE_ID`.
- Unused types:
  - `HttpServiceOverloads`, which is not implemented and will drift.
  - `HttpServiceWithAxiosRef`, `BodyMixin`, `UndiciResponseWithParsedBody`.
  - `UndiciRequestArgsType`, `UndiciRequestType`, `UndiciResponseDataType`.
  - `CommonResponseHeaders`, `MethodHeaders`.

**Rename or reshape:**
- `setGlobalDispatcher` → `setDispatcher`: it doesn't set the global dispatcher.
- `setInterceptors`: make it internal.
- `interceptorCount`: return the real count, or remove it.
- `undiciRef`: return read-only options, without the `__` keys.
- `register(config: HttpModuleOptions & any)`: give it a real type.
- Merge the four overlapping config types: `AxiosLikeRequestConfig`, `AxiosCompatibleRequestOptions`, `AxiosCompatibleRequestConfig` and `HttpRequestOptions`.
- Consider exporting `AxiosResponse` / `AxiosRequestConfig` aliases, so migrating users can drop the `axios` package.
- `UNDICI_INSTANCE_TOKEN` and `HTTP_MODULE_OPTIONS` are plain strings identical to @nestjs/axios' tokens. Keep them only if they are documented for test overrides.

## Proposed PRs

### Must-fix before 1.0

1. **ci: package integrity gates.**
   - Run the declared-deps check, publint and attw on the `npm pack` tarball.
   - Add a peer-matrix job covering the minimums and Nest 12 + undici 8, and Node 22.x lowest.
   - Remove `forceExit`.
   - Fix the engines vs undici 8 mismatch.
   - (Covered by work item A plus the Nest 12 matrix, item B.)
2. **refactor!: trim and explicitly list the public API.**
   - Replace the `export *` barrels with named exports.
   - Remove the items listed above and drop the `reflect-metadata` peer.
   - Update docs. Optionally ship a 0.7 with `@deprecated` tags first.
3. **build: commit an api-extractor report**, after item 2. `api-extractor.json` plus `etc/*.api.md`; CI fails on any API change until the report is updated.
4. **fix(types)!: typed `HttpModuleOptions`.** Spell out the supported axios module options, the undici options, `interceptors` and `global`. Remove `& any` and `Partial<any>`.
5. **fix(types): make migrated @nestjs/axios code typecheck.**
   - Add the `D = any` generic.
   - Widen the response headers type.
   - Give axiosRef request interceptors non-optional `AxiosHeaders`.
   - Make the constructor param optional.
   - Turn on `strict` and fix the 7 errors; `registerAsync` without a factory should throw a clear error.
   - Run the typecompat test in CI.
6. **refactor!: clean up HttpService members:** `setDispatcher`, internal `setInterceptors`, a real `interceptorCount`, read-only `undiciRef`.
7. **decide:** `withCredentials` and the default redirect behaviour. Both are breaking changes, and both are hard to change after 1.0.
   - `withCredentials` does nothing in axios on Node. Here it enables one cookie jar per service, so a `Set-Cookie` from one user's upstream call is replayed on everyone's later calls. Proposal: an explicit `cookieJar` option, with `http-cookie-agent` and `tough-cookie` becoming optional, lazily loaded peers. Loading them currently costs about 150 ms.
   - Redirects: axios follows up to 21 by default; we follow none.

### Should-fix (not breaking)

8. **fix: abort on unsubscribe.** Use an AbortController in the `executeRequest` teardown, combined with the user's signal. Skip it for `responseType: 'stream'`.
9. **fix: resource cleanup and shared state.** `HttpService` implements `OnModuleDestroy` and closes the dispatchers it created, never ones the user supplied. The static module's default options become a factory.
10. **fix: option mapping.**
    - Replace the `__` casts with a typed resolved-config object, and strip axios-only keys before calling undici.
    - Delete the `__axiosCompat.baseURL` branch and the `__socketPath` URL rewrite. Implement `socketPath` with `new Agent({ connect: { socketPath } })`.
    - Warn about ignored `httpsAgent` TLS options, and fix `keepAlive`.
    - Remove the dead `SizeLimitInterceptor` response code and the unused imports. Use Nest `Logger`.

### Later

- `sideEffects: false`
- a streaming `maxContentLength` check
- take `statusText` from the server
- a total request `timeout`
- a test for the duplicate-undici case

## Docs inaccuracies found

- The `socketPath` row says it "fails with Invalid URL protocol"; on its own it is silently ignored.
- `interceptorCount` is off by one.
- The README's axiosRef interceptor example fails with `strictNullChecks`.
- "Each import creates its own HttpService" is not true for the static `HttpModule`.
- `docs/features.md` advertises `TypedHttpModule`.
- The CHANGELOG says ES2020, but the target is es2023.
