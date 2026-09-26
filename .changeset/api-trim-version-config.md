---
'nestjs-axios-undici': minor
---

Trims the public API to a deliberate, explicit export list, checked against a committed [API Extractor](https://api-extractor.com/) report in CI (`etc/nestjs-axios-undici.api.md`, `npm run api:check`/`api:update`) so a future change to the surface is always a reviewed decision.

**BREAKING: removed, outright (no `@deprecated` step), because each one loses nothing** - either it never did anything, or a supported replacement already exists:

- The legacy typed module: `TypedHttpModule`, `InjectTypedHttpService`, `ExtractHttpServiceType`, `HTTP_SERVICE_TYPE`, `TypedDynamicModule`. Use `HttpModule`/`HttpService` directly - `HttpModuleOptions` is already strictly typed.
- `AxiosResponseAdapterInterceptor`/`axiosResponseAdapter` - dead code; `HttpService` already converts every response to the axios-compatible shape itself.
- `SizeLimitInterceptor`/`createSizeLimitInterceptor`/`SizeLimitOptions` - no longer has a use now that `maxBodyLength`/`maxContentLength` are enforced natively, with the right codes; this interceptor's own response-size check never ran. Use the `maxBodyLength`/`maxContentLength` module/request options instead.
- `STATUS_TEXT_MAP` - an internal lookup table, never meant to be consumed directly.
- `HTTP_MODULE_ID` - a provider token that was registered but never injected anywhere; it did nothing.
- The internal error helpers `toAxiosError`, `createStatusError`, `createTimeoutError`, `createUnsupportedProtocolError`, `isDeadlineTimeoutReason`, plus the `DeadlineTimeoutReason`/`EffectiveAbortSignal` types - implementation details of how this library builds `AxiosError`s. Use `AxiosError`/`isAxiosError`/`isCancel` (still exported) instead.
- Unused types: `HttpServiceWithAxiosRef`, `BodyMixin`, `CommonResponseHeaders`, `MethodHeaders`.

**Added: `AxiosRequestConfig`/`AxiosResponse`/`AxiosInstance`**, plain type aliases for this package's own `AxiosLikeRequestConfig`/`AxiosLikeResponse`/`AxiosRef` - so migrating code can drop its own `import ... from 'axios'` purely for these types.

**`UNDICI_INSTANCE_TOKEN`/`HTTP_MODULE_OPTIONS` stay exported** and are now documented as supported injection tokens for overriding a test module's providers directly (see the [testing guide](/docs/guides/testing.md#overriding-the-modules-own-providers)).

**`reflect-metadata` is no longer this package's own peer dependency.** Nothing in this library's source imports it; it's still required, transitively, because `@nestjs/common`/`@nestjs/core` themselves declare it as *their* peer dependency, so any app using this package already has to install it to satisfy Nest itself.

See the [migration guide](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/migration-guide?id=types) for the full list and replacements.

---

`src/version.ts` no longer does a runtime `require('../package.json')` for the default `User-Agent` version - a prebuild/pretest step (`scripts/generate-version.js`) now writes a build-time `LIBRARY_VERSION` constant from `package.json`, so a bundler that prunes non-JS files (or can't resolve a `require()` reaching outside `lib/`) doesn't break it. No behaviour change; a test now asserts the User-Agent version matches `package.json`.

---

Internal only, no behaviour change: the `__agentOptions`/`__proxyAgent` `as any` casts in the axios-config-to-undici option mapping are replaced with one typed, internal `ResolvedModuleConfig` object produced once by `mapAxiosConfigToUndici` and consumed by `HttpService`.
