# Performance and benchmark automation audit (pre-1.0)

Audited `origin/main` @ b52afff. Measured on a 4 vCPU Xeon sandbox running Node 22.22.2, undici 7.30.0 and axios 1.20.0. Docker had no daemon and k6 was not installed, so the k6 suite was reviewed by reading it, not by running it. The prototype scripts are in `plan/prototypes/perf/`. To run them, symlink a `node_modules` that holds the repo's devDependencies next to them. `--lib` is a built checkout (a directory containing `lib/`).

## Key measurements

**The PR check in `compare.js` gives false alarms.** I ran it 4 times with the CI settings (5 rounds × 5 s, 10% threshold) and the **same build on both sides**. **2 of the 4 runs failed**, on the `request` scenario, at -18.5% and -13.2%. The other results were +1.2%, +4.8%, and between -4.3% and +3.8% for `interceptors`. Single samples of the same code ranged from 15.4k to 26.2k req/s (rps coefficient of variation 11–35%).

**It also misses real regressions.** The library code accounts for about 10–15% of the client CPU per request. The rest is undici and socket I/O. So the library's own overhead could roughly double before the end-to-end rps drops by 10%.

**CPU time per request is a much steadier statistic** (`process.cpuUsage()/requests`). The prototype `compare2.js` compared the same code on both sides, 3 runs × 5 scenarios × 6 rounds of 3 s:

| statistic | worst change with identical code on both sides | CV of samples |
|---|--:|--:|
| rps (current) | -5.1% / +6.9% | 11–35% |
| client CPU µs/req, median | ±3.9% | 3.5–10% |
| CPU/req ÷ raw-undici CPU/req measured in the same round | ±0.1 of the ratio | 4–13% |

**Library overhead is small, so hot-path tuning can gain little.** I measured it with `overhead.js`, which uses the undici MockAgent (no sockets) and runs each case in its own process:

| case | µs/req |
|---|--:|
| raw undici `request()` + `body.json()` | 15.3 |
| nau `get` | 16.8 |
| nau `axiosRef.get` | 14.7 (within noise of `get`) |
| nau `post` with a JSON body | 18.1 |
| nau `get` with params, headers and timeout | 24.7 |
| + 2 native interceptors | 15.2 (noise) |
| + 2 native interceptors, axios request and response interceptors | 22.2 |
| 404 error path | 23.5 |

Over real sockets (`run-matrix.js`), client CPU per request was 35 µs for raw undici, 41 µs for nau `get` and **510–560 µs for `@nestjs/axios`**. That is about 9–12x more CPU and 7–10x the rps in a client-bound test. About 8% of axios's time goes to building a `CanceledError` stack on every request, which is `@nestjs/axios` teardown work.

**Time spent in each stage** (`stages.js`):

| stage | ns |
|---|--:|
| `normalizeAxiosRequest` fast path | 490 |
| `normalizeAxiosRequest` with params, headers and timeout | 3,850 |
| `buildURL` with 2 params | 1,960 |
| `mergeHeaders` | 435 |
| `new Error` (status error stack) | 3,100 |

**No memory leaks** (`soak.js`). Across 200k requests at 50 concurrency, the heap stayed flat at 17–18 MB for `get`, the 404 error path and interceptors, and RSS stayed at 120–124 MB.

**Keep-alive works.** 50 concurrent requests use about 100 sockets, and raw undici behaves the same way. These sockets are reused, and the count does not grow: 600k requests ran over 301 connections. `@nestjs/axios` uses 51 sockets.

**Bug: unsubscribing does not abort the request** (`cancel.js`). I sent 100 requests to a 2 s endpoint with `timeout(100)`:

| client | upstream requests aborted |
|---|--:|
| `@nestjs/axios` | 100 of 100 |
| nau | **0 of 100** |

`executeRequest` has no teardown. With `timeout()`, `switchMap` or `takeUntil`, every cancelled call keeps its socket and the upstream work until the response ends. This breaks drop-in parity and wastes resources under load. Attaching an `AbortController` costs about 1–3 µs per request (`abort-cost.js`).

## Benchmark suite findings (k6/Docker)

**The apps are not like-for-like.**
- "Fastify + Undici" runs the upstream `nestjs-undici` package (raw body stream plus `body.json()`), not this library.
- The headline "Undici 66-71% faster than Axios" and the "Interceptor overhead 78%" row both describe a different library.
- There is **no plain (no-interceptor) nestjs-axios-undici app** at all.

**The interceptor apps do different work.**
- The nau app uses a native `HttpInterceptor` class. The axios apps use `axiosRef` request and response interceptors.
- Both call the Nest `Logger` twice per upstream call, which is 10 stdout lines per k6 request through the Docker log driver. That scenario mostly measures logging.

**Other problems:**
- The mock service runs Fastify with `logger: true`, so it logs every upstream call (about 11k lines/s at 2.2k rps). This can cap throughput and compresses the ratios.
- Each Node version runs on a different runner job. The table invites comparing Node 22 with Node 26, where the 2.5x gap is runner variance.
- The full benchmark runs only after an npm publish, so it never gates anything.

## Recommended fair app set

The Fastify axis is not what the library changes, so the setup should compare HTTP clients only.

**Replace the 7 apps with one parameterised app plus the mock.** The prototype is `plan/prototypes/perf/e2e/app.js`. It has one source file, and the HTTP module is chosen by `CLIENT=nau|axios`. That makes "change one import" literally true.

| key | client | interceptor |
|---|---|---|
| `nestjs_axios` | `@nestjs/axios` | none |
| `nau` | nestjs-axios-undici | none |
| `nestjs_axios_interceptor` | `@nestjs/axios` | identical `axiosRef` request + response interceptor, no stdout logging (set a header, compute a duration) |
| `nau_interceptor` | nestjs-axios-undici | same interceptor as above |
| `undici_raw` (floor) | a Nest service calling `undici.request()` + `body.json()` | none |

**Drop** `nestjs-express-axios*`, `nestjs-fastify-undici` and the `nestjs-undici` dependency. Optionally keep one extra `nau_native_interceptor` app to show the native interceptor API.

**Mock:** set `logger: false`.

**k6 (`k6-scripts/lib/benchmark.js`):**
- Change `SERVICES` to the 5 keys above, with new ports and startTimes.
- Change `interceptorOverhead` pairs to `nau`/`nau_interceptor` and `nestjs_axios`/`nestjs_axios_interceptor`.
- Change the summary comparisons to `nau_vs_nestjs_axios`, `nau_interceptor_vs_nestjs_axios_interceptor` and `nau_vs_undici_raw` (the adapter cost).

**`generate-comparison-report.js`:**
- Change `CONFIGS` to the new keys.
- Remove the `fastify_undici*`, `*_vs_express_axios` and framework-impact blocks.
- Remove the nestjs-undici caveat note and `packageVersion('nestjs-undici')`.
- Use two chart colours: `@nestjs/axios` and nestjs-axios-undici, with raw undici in grey.
- Show a "ratio vs @nestjs/axios" column instead of cross-Node tables.

**Compose:** use one template with a `NODE_VERSION` argument instead of 3 duplicated files. Either run all Node versions on the same runner in sequence, or keep the per-version tables separate with no juxtaposition.

## Proposed PRs

### Must-have for 1.0

**PR1. fix: abort the undici request when the Observable is unsubscribed**
- Files: `src/modules/http/services/http.service.ts` (`executeRequest`).
- In `executeRequest`, create an `AbortController` (or a cheap EventEmitter signal) and combine it with the user's `signal` via `AbortSignal.any`. The teardown aborts it when the Observable has not completed. For `responseType: 'stream'`, destroy the body.
- Acceptance: a unit test where `timeout(50)` on a slow server causes a client abort on the server (`cancel.js` shows 100/100). Rejections still map to `CanceledError`/`ERR_CANCELED` only for user-initiated aborts. The CPU cost of `get` goes up by no more than 5% (`overhead.js`).

**PR2. ci: make the PR regression check reliable and wider**
- Files: `benchmarks/micro/*`. Base it on `plan/prototypes/perf/compare2.js`, `client.js` and `server.js`.
- Scenarios: `get`, `post` JSON, `config` (params, headers, timeout), `interceptors` (2 native + axios request and response interceptors), `error` (404), `axiosRef`.
- Gate on the **median client CPU µs/req** (head vs base, alternating rounds). Also report the in-round overhead ratio against raw undici and rps as information only.
- Fail above +10% CPU/req, but only when the per-round paired change points the same way in at least 5 of 6 rounds. Automatically re-run a failing scenario once.
- Post the table as a sticky PR comment in addition to the step summary.
- Acceptance: 5 head-vs-head CI runs all pass. An artificial 5 µs busy-loop added to `executeRequest` fails the check. Runtime is under 6 minutes.

**PR3. bench: like-for-like app set**
- Scope: as described in "Recommended fair app set": the parameterised app, the mock logger turned off, the new k6 `SERVICES`, the report generator and a single compose template.
- Acceptance: the docs no longer need caveat notes. Every headline number compares `nau` with `@nestjs/axios` in identical apps. `npm run typecheck` passes. `generate-comparison-report.js` works on the new JSON.

**PR4. ci: lightweight end-to-end A/B benchmark on PRs and releases (no Docker, no k6)**
- Files: `benchmarks/e2e/{app,upstream,run}.js` from the prototype, and `benchmarks.yml`.
- The Nest+Fastify app from PR3 runs as a plain process. autocannon applies the load. Rounds alternate between nau and `@nestjs/axios` on the same runner. With `--pin`, `taskset` pins the load generator to CPU 0, the app to CPU 1 and the upstream to CPUs 2–3.
- It publishes the **throughput ratio**, which cancels out runner speed, plus p50/p99, to the step summary and a PR comment. On release, it attaches the ratio to the release notes.
- It could also run in the `changeset-release/main` Version PR, so numbers exist before publishing.
- Acceptance: runs in under 5 minutes, and the ratio's CV is 10% or less across 3 runs. **Note: the prototype has not been run.** It needs `npm i @nestjs/platform-fastify@11 autocannon` first.

### Later

**PR5. perf: cheaper axios adapter paths**
- Add a fast path in `buildURL`/`flattenParams` for flat primitive params: skip the regex replaces when `encodeURIComponent` produced no `%`. That cuts about 1.5 µs of the ~1.96 µs.
- Cache the "defaults are empty" check in `normalizeAxiosRequest`.
- In the axios request-interceptor adapter, avoid the `from(Promise)` + `mergeMap` + `AxiosHeaders` rebuild per request (about 7 µs today).
- Expect about 2–8 µs/req on those paths, which is ≤10% of client CPU. Only worth doing after PR2 can prove it.

**PR6. fix: enforce `maxContentLength` while streaming**
- Today `maxContentLength` is checked only after the whole body is buffered, so the limit gives no memory protection.
- Reject early when the `content-length` header is too large, and count bytes while reading.

**PR7. Deterministic instruction-count benchmarks**
- For example, a CodSpeed/valgrind mode (`valgrind` is available) on the MockAgent overhead cases. Its variance is under 1%, which would allow a threshold of about 3%.

**PR8. Run the full k6 suite before publishing**
- On the Version PR and by label, rather than only after the npm publish. Either run all Node versions on one runner, or stop presenting them side by side.
