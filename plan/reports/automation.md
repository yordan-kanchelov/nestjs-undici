# Exploration report: test automation and compatibility coverage

Explorer run on 2026-09-25 against `origin/main` 2bcdf30. The prototypes it mentions are copied to `plan/prototypes/automation/`.

## Latest versions (npm, 2026-09-25)

- `@nestjs/common`, `@nestjs/core` and `@nestjs/testing` are at 12.1.0. They are ESM-only (`"type":"module"`). Other dist-tags: `legacy` = 11.2.6, `old` = 10.4.19.
- `@nestjs/axios` is at 12.0.1. It is ESM-only, with peers `@nestjs/common ^10||^11||^12` and `axios ^1.3.1`.
- `undici` is at 8.11.2 and needs Node >= 22.19. The `seven` tag is 7.30.0.
- `axios` 1.20.0, `rxjs` 7.8.2, and `http-cookie-agent` 8.0.0 (peer `undici ^7||^8`).

## 1. The test suite against Nest 12 and @nestjs/axios 12

- On Node 22, Jest (CommonJS) cannot load Nest 12: 24 of 30 suites fail with "Must use import to load ES Module". `--experimental-vm-modules` doesn't help, because Jest's require(esm) needs `vm.SourceTextModule.hasAsyncGraph`, which only exists from Node 24.9.
- On Node 24.21 and 26.10 with `NODE_OPTIONS=--experimental-vm-modules`, all 30 suites / 330 tests pass against Nest 12.1 and @nestjs/axios 12, with no other changes. Typecheck, lint and test:examples also pass on Nest 12.
- With Nest 10.4 and undici 8 installed over the lockfile, all 330 tests pass.
- **Smallest robust path:** keep Jest.
  - Move the devDeps to Nest 12.
  - Run Jest on Node 24/26 with the flag.
  - On Node 22, run Jest with a `npm i --no-save` overlay of Nest 11 (and 10) plus @nestjs/axios 4.
  - Cover Node 22 × Nest 12 with the consumer smoke test (Node's own loader).
  - Don't migrate to Vitest: it would also need an SWC plugin for decorator metadata.

## 2. Consumer-level package test (prototype passes)

Files are in `plan/prototypes/automation/consumer/`.

- `run-matrix.mjs` creates one fresh project per combination. It installs the packed tarball with only the declared peers, runs `npm install` without legacy-peer-deps, and runs the smoke test through both CJS and ESM on each `--node` binary.
- `scenario.cjs`, `smoke.cjs` and `smoke.mjs` hold the scenario, in plain JS with decorators applied by hand. It covers:
  - `register` and `registerAsync(imports, inject, useFactory)`
  - `get` with params, and a JSON `post`
  - axiosRef interceptors, including eject
  - redirects with `maxRedirects`
  - the `withCredentials` cookie jar
  - a 404 surfacing as an AxiosError, and ECONNREFUSED
  - a class interceptor with DI
  - that the returned value is an instance of the consumer's rxjs Observable
- `check-declared-deps.cjs` scans `lib/**` for bare imports that are not in dependencies or peerDependencies. On main it failed with `lib/modules/http/http.module.js: @nestjs/core`, which is exactly the bug that slipped through (fixed in 0.6.1). A pnpm install with `hoist=false` did not catch that bug, because the app's own `@nestjs/core` still resolves when Node walks up the directory tree. The static check is therefore the right guard.
- `consumer-types.ts` compiles a consumer file with tsc in nodenext mode, as both CJS and ESM. It passes for Nest 10 and Nest 12. Use the latest rxjs for type checks, because rxjs 7.1.0's types don't resolve under nodenext.
- **Matrix:** nest10 at the minimum versions (10.0.0, undici 7.0.0, rxjs 7.1.0, reflect-metadata 0.1.13), nest10 × undici 8, nest11 × undici 7/8, and nest12 × undici 7/8.
- **Result:** 36/36 pass on Node 22.22, 24.21 and 26.10. It takes about 40 s locally for all three Node versions with a warm cache, so expect about 1–1.5 min per Node job in CI.
- **New bug:** on Node 22.12–22.16, an ESM app using Nest 12 that imports this package before `@nestjs/common` fails. It gets `ERR_REQUIRE_CYCLE_MODULE` on 22.12–22.14 and `ReferenceError: Cannot access 'isUndefined'` on 22.15–22.16. Node 22.17+ works, and so does importing `@nestjs/common` first. Set `engines.node` to at least `>=22.17.0` (`>=22.19` matches undici 8).
- publint and attw are both clean on the tarball, about 1–2 s each.

## 3. Axios / @nestjs/axios compatibility gaps

**API-surface parity.** `plan/prototypes/automation/api-surface-parity.cjs` runs after a build, from the repo root. It exits 1 on a gap that isn't allowlisted. Missing today:
- `HttpService.query()`, new in @nestjs/axios 12 for the HTTP QUERY method. `instance` and `makeObservable` are protected, so allowlist them.
- On `axiosRef`: calling it directly as `axiosRef(config)`, `getUri`, `postForm`/`putForm`/`patchForm`, `query`, `create`.
- On `axiosRef.defaults`: `timeout`, `validateStatus`, `maxContentLength`, `transformRequest`, `adapter` and others are not present as defaults.
- On `AxiosHeaders`: `normalize`, `concat`, `toString`, `getSetCookie`, the `set/get/hasContentType` helpers, and the `Authorization`/`Accept` helpers.
- From axios: `HttpStatusCode`, `CancelToken`, `toFormData`, `mergeConfig`, and `AxiosError.ERR_FORM_DATA_DEPTH_EXCEEDED`.

**Type-level drop-in check.** `plan/prototypes/automation/differential/drop-in.types.ts` is compile-only. It fails on both Nest 11 and Nest 12:
- Our HttpService is not assignable to @nestjs/axios HttpService: `get(url, config: AxiosRequestConfig)` is rejected because of the headers type.
- `Observable<AxiosLikeResponse>` is not assignable to `Observable<AxiosResponse>`.
- `axiosRef` is not assignable to `AxiosInstance`.
- @nestjs/axios `HttpModuleAsyncOptions` is not accepted by `registerAsync`.

In practice, code that passes a variable typed `AxiosRequestConfig`, or returns `Observable<AxiosResponse>`, won't compile after swapping the import.

**Table-driven differential harness.** `plan/prototypes/automation/differential/` contains `differential-harness.ts` and a 33-case probe spec.
- Each case is a single line: a name, module options, `run(service, ctx)` and an optional normalizer.
- The harness runs each case through both libraries against the same local server. It compares what the server received and what the caller got back.
- A case marked `knownDifference` asserts that the difference still exists, so fixing one turns the test red and prompts a doc update.
- `DIFF_REPORT=file` dumps the results. The probe runs in about 6 s.

**Differences it found, must-have:**
- No default `Accept: application/json, text/plain, */*` or `User-Agent` header. Some APIs, GitHub for example, reject requests without a User-Agent.
- `query()` is missing.
- `timeout` resets on each chunk, so a trickling body never times out. axios uses a total timeout and fails with `ERR_BAD_RESPONSE`.
- `validateStatus: null` rejects instead of accepting every status.
- The error codes for `maxContentLength` and `maxBodyLength` don't match axios.
- `timeoutErrorMessage` is ignored.
- `transitional.clarifyTimeoutError` (`ETIMEDOUT`) is ignored.

**Should-have:**
- After a POST gets a 302, the redirected GET still carries `Content-Type`.
- A redirect loop fails with `UND_ERR_INVALID_ARG` instead of `ERR_FR_TOO_MANY_REDIRECTS`.
- Redirects are not followed by default.
- `response.request` and `error.request` are missing.
- `onDownloadProgress` and `onUploadProgress` are never called.
- `patchForm`/`postForm` with URLSearchParams sends it url-encoded; axios sends multipart.
- The missing axiosRef members listed above.

**Already matching:**
- `putForm(FormData)`
- A cold observable: subscribing twice sends two requests.
- A request interceptor that throws.
- `defaults.baseURL` and `defaults.timeout`.
- A 401 retried from a response interceptor.
- 303 and 307 redirects.
- A cross-origin redirect drops `Authorization`.
- Multiple `Set-Cookie` headers.
- `null` data.
- Undefined headers are dropped.
- Header merging is case-insensitive.
- An absolute URL ignores `baseURL`.

**Not probed yet:**
- decompression (gzip, br, deflate)
- proxy environment variables
- `beforeRedirect`
- `allowAbsoluteUrls`
- `socketPath`
- interceptor `runWhen` / `synchronous`
- `parseReviver`
- a response interceptor that changes the shape of the response

**Harness gotcha:** a @nestjs/axios `HttpModule` imported without `register()` uses the global axios singleton, so interceptors leak between tests. Always call `register({})`.

## 4. Gaps in the current tests

- **Coverage paths are broken.** With Jest 30, ts-jest 29 and TS 6, lcov writes `SF:src/file:/abs/...`, which Codecov can't map. `coverageProvider: 'v8'` fixes it, giving 95% lines and 87% branches with correct paths.
- **Worst-covered files (istanbul):**
  - `http-typed.module.ts`: 40% of lines, 0% of branches.
  - `size-limit.interceptor.ts`: 64% of lines, 41% of branches.
  - `axios-interceptor.adapter.ts`: 52% of branches.
  - `axios-response-adapter.interceptor.ts`: 67% of branches.
  - `axios-response.adapter.ts`: 84% of lines.
  - `axios-error.ts`: 81% of branches.
- **No real HTTP.** 16 of 30 spec files never start a server. `http.service.spec.ts` mocks `undici.request`, and several e2e "Nest" specs only compile modules against `https://api.example.com`.
- **Tests of implementation details.** There is heavy `(x as any).privateField` use, about 45 times in the opentelemetry and http-config-module specs. Three specs use `jest.mock('@opentelemetry/api')`.
- **Timing-sensitive tests.** The "unsubscribe does not abort" test uses 50/300/400 ms sleeps. The real-world specs assert `totalTime > 300`. The 200 ms timeout tests depend on undici's timer resolution of about 1 s.
- **`forceExit: true` is unnecessary.** No open handles show up without it, so it only hides future leaks.
- **`form-data` isn't declared.** The matrix spec imports it, but it only arrives through axios. It should be a devDependency.

## 5. CI layout (sketch: `plan/prototypes/automation/ci/compat.yml`)

- **package job** (Node 24, about 2 min): pack, run the declared-deps check, run `publint --strict` and attw, and upload the tarball.
- **jest job:**
  - Node 24 and 26 on the lockfile (Nest 12) with `--experimental-vm-modules`.
  - Node 22 with the Nest 11 and Nest 10 overlays.
  - Coverage from the Node 24 job only.
- **consumer job:** needs the package job. It runs on Node 22.17, 22, 24 and 26 across the 6 combinations, with a cached `~/.npm`.
- **perf:** make the micro-benchmark regression check required for `src/**`, and add scenarios for `post-json`, `params+headers merge`, `error-404` and `axiosRef-interceptors`.
- **Weekly `schedule` run:** catches upstream releases within the peer ranges. It would have flagged `query()`.
- **Total:** about 4–5 min of wall-clock per PR, about 15 runner-minutes.

## Proposed PRs (foundation first)

**Must-have:**
1. **ci:** a packaging check (declared deps, publint and attw on the tarball).
2. **test:** a consumer smoke matrix, `engines.node >= 22.17`, and a supported-versions table in the README.
3. **chore:** devDeps on Nest 12 / @nestjs/axios 12, a multi-Nest Jest matrix, `form-data` as a devDependency, `forceExit` removed, and `coverageProvider: 'v8'`.
4. **test:** API-surface parity and type-level drop-in checks.
5. **test:** a table-driven differential harness. Port the matrix and probe cases, and check the known-differences list against the docs.
6. **perf:** more micro-benchmark scenarios, and make the regression check required.
7. **Compatibility fixes, one small PR each.** Each one flips a differential case and must pass the perf check:
   - default `Accept` and `User-Agent` headers
   - `query()`
   - a total `timeout`, plus `timeoutErrorMessage` and `clarifyTimeoutError`
   - `validateStatus: null`
   - axios error codes for `maxContentLength`/`maxBodyLength`
   - assignability to the `AxiosRequestConfig`, `AxiosResponse` and `AxiosInstance` types

**Nice-to-have:**
8. `axiosRef` `getUri`, the `*Form` methods and calling it directly; the `AxiosHeaders` helpers.
9. Redirect details: drop body headers after a 302, and fail with `ERR_FR_TOO_MANY_REDIRECTS`.
10. Progress callbacks and `response.request`.
11. Coverage for the worst files; convert the mock-only specs to real servers.
12. Replace the sleep-based timing tests with event-based ones.
