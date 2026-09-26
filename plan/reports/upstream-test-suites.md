# Exploration report: running upstream test suites as a conformance suite

Explorer run on 2026-09-25 against `origin/claude/v1.0.0`. Prototypes referenced below
have since been promoted into maintained CI jobs at `tests/upstream/` (`claude/upstream-
conformance`); `plan/prototypes/upstream-tests/` is deleted. Nothing under `src/` was
touched, then or since. Upstream repos are cloned at runtime by the suite's `run.mjs`
scripts, not committed. See `tests/upstream/README.md` for the maintained suites and
their current pass/expected-failure counts (higher than the numbers below: PRs #23 and
#25 landed `axiosRef` as a real axios instance and matched axios' errors after this
report was written).

Installed versions in this repo (`node_modules/*/package.json`): `@nestjs/axios` 12.0.1,
`axios` 1.20.0. Both projects are cloned at the matching tag, plus `nestjs/axios@main`
for comparison.

## Licences and practicality

Both `axios` and `@nestjs/axios` are MIT (confirmed from their `LICENSE` files). There is
no licence obstacle to running their test files against this package, or to vendoring a
copy - MIT permits both, with attribution kept in the copied file's header if we ever
commit a copy. **Recommendation: don't vendor.** Clone at a pinned tag at CI-run time,
same as the two `run.mjs` prototypes here do. That way a pin bump is a one-line diff to
the ref, upstream's own file (not a possibly-stale local copy) is what runs, and nothing
in this repo's tree needs the cloned repo's own dependency tree merged into ours.

## 1. `@nestjs/axios`

Its own tests: `tests/http.service.spec.ts`, `tests/http.module.spec.ts`, `tests/esm.spec.ts`,
all **vitest**, all against `nestjs/axios@main` (12.0.1 is effectively the same for this
purpose; `main` added nothing to these three files worth diffing separately). No jest,
no separate e2e folder - vitest's `describe`/`it` blocks are what upstream calls
"unit" and "e2e" is not a separate runner here.

- `http.service.spec.ts` and `http.module.spec.ts` run entirely through the public
  `HttpModule`/`HttpService` API (`HttpModule.register()`, `service.get/post/...`,
  `service.axiosRef`) against one real local `node:http` server started in
  `beforeAll`. **Nothing mocks axios or spies on its internals.** This is exactly the
  shape our own `tests/*.e2e.spec.ts` and `tests/compat/differential/` are already
  written in, which is why porting them over was mechanical.
- `tests/esm.spec.ts` only checks **@nestjs/axios's own** `dist/`/`package.json`
  packaging contract (that `main`/`types`/`exports` point at files that exist, that
  emitted specifiers keep `.js`, that the built entry loads under plain Node ESM). It
  says nothing about behaviour we share. **Not transferable, not meaningful** - skipped.

**Classification of the two behavioural files: transferable as-is**, given two small
mechanical substitutions (not axios-internal spying, and no rewritten assertions):
`../lib/index.js` → this package's `HttpModule`/`HttpService`, and `../lib/http.constants.js`
→ this package's constants (`HTTP_MODULE_ID`/`HTTP_MODULE_OPTIONS` are literally the same
string tokens in both packages; `AXIOS_INSTANCE_TOKEN` has no real match - see below).

### Suite: `tests/upstream/nestjs-axios/`

`run.mjs` clones `nestjs/axios` at a pinned tag, copies the two behavioural spec files
verbatim into a scratch dir, and runs them with **this repo's own Jest + ts-jest**
(Node ≥24.9 with `--experimental-vm-modules`, needed because Nest 12/`@nestjs/testing`
are ESM-only - same finding as `plan/reports/automation.md` item 1). Two static shim
files (`shims/vitest.js`, `shims/lib-index.js`, `shims/http-constants.js`, all committed)
are wired in purely through `moduleNameMapper`, so the copied spec files are never
edited - the substitution happens at module-resolution time, matching what upstream's
own imports say.

**Result: 23 tests, 16 passed, 7 failed.**

Real incompatibilities the upstream test caught (not previously reported at this
level of precision):

1. **`postForm` with a plain object sends `application/x-www-form-urlencoded`, not
   `multipart/form-data`.** Repro: `service.postForm('/form', { a: '1', b: '2' })`;
   the request never carries a `multipart/form-data` boundary. Already tracked under
   the "`feat(axiosRef): make it a real axios instance` → `*Form`" plan.md item, but
   this is now a concrete, upstream-sourced repro rather than an internal probe.
2. **`HttpService.query()` is missing** (`TypeError: service.query is not a function`).
   Already tracked in the same plan.md item.
3. **`axiosRef.defaults.timeout` is never populated from module options.**
   `createAxiosRefDefaults` (`src/modules/http/adapters/axios-ref.factory.ts`) only sets
   `baseURL` and `headers` - there is no `timeout` key at all, so
   `HttpModule.register({ timeout: 4200 })` leaves `axiosRef.defaults.timeout`
   `undefined` rather than `4200`. This is more specific than the existing "full
   `defaults`" bullet in plan.md suggested (that bullet reads as if `timeout` already
   passed).
4. **A `responseType: 'stream'` request is aborted on unsubscribe even before any
   response headers have arrived**, when real `@nestjs/axios` never aborts a stream
   request regardless of how much has (or hasn't) arrived. Repro: server delays 500ms
   before writing anything; `service.get('/slow', { responseType: 'stream' }).subscribe(...)`
   then unsubscribed at 50ms; our package tears the connection down (`abandoned`
   contains `/slow`), upstream does not. Root cause, read from `@nestjs/axios`'s own
   `http.service.ts`: its teardown is `if (config.responseType === 'stream') return;` -
   an unconditional skip based purely on `responseType`, never on whether anything was
   emitted. This repo's `executeRequest` (`src/modules/http/services/http.service.ts`)
   instead gates the abort on a `settled` flag that only flips once headers/response
   have actually arrived, so an early unsubscribe on a still-pending stream request
   still aborts it. **This is a genuinely new finding** - the existing differential
   harness and `plan.md`'s log entry for the abort-on-unsubscribe PR both describe the
   condition as "unless the response (or, for `responseType: 'stream'`, the headers)
   has already been emitted," which is exactly the behaviour this test disproves against
   real `@nestjs/axios`.

Not real bugs (harness/shim or cosmetic):

5. **`HTTP_MODULE_ID` length differs** (21-char nanoid vs. our 36-char `randomUUID()`).
   Nothing in the public contract promises a specific ID shape or length; skip.
6. **The `AXIOS_INSTANCE_TOKEN` DI-token test can't transfer.** `@nestjs/axios` provides
   the actual axios instance (an object with `.defaults`) under that token; this
   package's nearest equivalent, `UNDICI_INSTANCE_TOKEN`, provides the raw undici
   dispatcher options, not an axios-like object - there is no token here that resolves
   to something with `.defaults`. Aliased anyway so the DI graph doesn't crash; the
   resulting assertion failure is a shim limitation, not a product bug.

## 2. `axios`

`axios` 1.20.0 (the version installed here) has moved off mocha entirely: **vitest**,
with a `unit`/`browser`/`browser-headless` project split (`vitest.config.js`). The
"karma/browser" suites the task description anticipated are now the `browser` project
(`tests/browser/**/*.browser.test.js`, driven by Playwright) - not attempted here, since
none of it runs under Node and it tests `XMLHttpRequest`/`fetch` adapters we have no
analogue for. `tests/unit/adapters/http.test.js` is the Node-http-adapter suite the task
asked about; there's no separate `test/unit`/`test/specs` split any more, just
`tests/unit/**`.

`tests/unit/adapters/http.test.js` is 7248 lines, **246 `it()` blocks**. Baseline (real
axios, real Node `http`, run through the repo's own `vitest run --project unit`):
**244 passed, 2 failed** - both failures are `should handle errors` cases that resolve a
nonexistent DNS name and get a `403` back from this sandbox's outbound HTTP proxy
instead of `ENOTFOUND`; an environment artifact, not a real signal either way.

Most of the file (158+ call sites) drives the public `axios(...)`/`axios.create()`/
`instance.get/post` API against a real local server it starts itself - genuinely
relevant to us. A visible minority instrument `httpAdapter` and its unexported
`__setProxy`/`__isNodeEnvProxyEnabled` internals directly, or manipulate raw sockets
(`net.Socket`, `http.Agent` pooling, a `HangingConnectSocket` stub) - those have no
analogue in an undici-backed package and can't transfer under any strategy.

### Strategies compared

**(a) axiosRef as the instance under test.** Shim `axios`'s import so `axios.create()`
returns something built from `new HttpService(...)`'s `axiosRef`. Blocked today:
`axiosRef` isn't callable, has no `create`/`getUri`, and `defaults` is missing most axios
fields (confirmed above: not even `timeout`) - the "make axiosRef a real axios instance"
item is an **open** plan.md phase-2 bullet, being built on `claude/axiosref-instance` in
parallel. Every one of the 158+ `axios.create()`/instance-method call sites in
`http.test.js` depends on that work landing first (or on a prototype-only shim that
re-implements `create`/callable, which duplicates that PR's job rather than testing it).
**Not attempted here** for that reason - it's the higher-value strategy once that PR
lands, and the `nestjs-axios` prototype above already demonstrates the shimming
mechanics work end to end once there's an instance to point at.

**(b) An axios `adapter` backed by our transport.** Write
`adapter: (config) => Promise<AxiosResponse>` using this package's own transport/
response/error code, register it as `axios.defaults.adapter`, and run the real,
unmodified spec file with `-t` filtering (or unfiltered) against it.

- **What it tests:** the undici `request()` call plus this package's response decoding
  (`toAxiosLikeResponse`), status validation (`createStatusError`), redirect-hop building
  (`buildRedirectHop`/`isRedirectResponse`), and error adaptation (`toAxiosError`) -
  reused directly from `src/modules/http/adapters/*` and `src/modules/http/errors/*`
  (via the built `lib/`), not reimplemented. See
  `tests/upstream/axios/adapters/undici-adapter.cjs`'s header comment for the
  exact axios adapter contract it has to satisfy (config already transform-requested;
  it must build the full URL itself; return data still untransformed).
- **What it bypasses:** axiosRef's interceptor chain and config-normalization
  (`normalizeAxiosRequest`/`buildAxiosConfig`) entirely - real axios's own `Axios.request`
  plumbing stands in for those, so this only tells us about the transport/response/error
  layer, never about interceptor ordering, `defer()`-per-subscription, or the
  config-merge bugs `plan/reports/axios-compat.md` found (those need axiosRef itself,
  i.e. strategy (a)).
- **Maintenance cost when upstream changes:** low for the adapter contract itself (it's
  been stable across axios majors), but real: every axios release can rename or resolve
  more of `buildFullPath`'s signature, and the adapter's response object shape
  (`.config`, `.request` placeholders) has to keep matching what `dispatchRequest.js`
  expects of *any* adapter, not just the built-in ones - that's read directly out of the
  clone by the prototype, so a signature change surfaces as a clear crash rather than a
  silent mismatch.

**Recommendation:** ship strategy (a) once `claude/axiosref-instance` lands - it is the
one that actually exercises the code path a consumer uses (`httpService.axiosRef`), the
same way the `@nestjs/axios` prototype above already does for `HttpService` itself. Keep
strategy (b) as a standing, narrower transport/response/error conformance check
alongside it: it is cheap to run (no DI, no interceptor setup) and, per the concrete
finding below, still catches real bugs strategy (a) wouldn't reach any faster.

### Suite: `tests/upstream/axios/`

`run.mjs` clones `axios` at a pinned tag, `npm install`s its own dev dependencies (no
`--ignore-scripts`-driven browser downloads are triggered, because the generated vitest
config only declares the `unit` project - no `browser`/`browser-headless` project, so
Playwright is never invoked), writes a `setupFiles` entry that monkey-patches
`axios.defaults.adapter` to `undici-adapter.cjs`'s adapter (built from this repo's own
`lib/`), and runs the **unmodified** `tests/unit/adapters/http.test.js` against it
(optionally filtered with vitest's own `-t`).

**A full, unfiltered 246-test run doesn't complete.** First attempt: it hung, producing
zero output, for the full 280s the prototype was given. Isolating individual tests found
one concrete cause - `should support cancel` (legacy `axios.CancelToken`, not
`AbortController`) hung for the full 15s test timeout because the prototype adapter only
wired `config.signal` through to undici, not the legacy `cancelToken.promise` - and
because that test's server is then never cleanly closed, its fixed port (upstream's
fixture always listens on `8020`) stays bound, so every later test reusing it fails
closed with `EADDRINUSE`. Fixed in `undici-adapter.cjs` (listen for `cancelToken.promise`
too, matching real axios's own http adapter) - filtered re-runs confirm the fix. **The
unfiltered run still hangs with the fix applied**, so at least one more test (earlier in
file order than the 30 sampled below - not yet isolated) has a similar unhandled-hang
gap, most likely another socket/agent-internals test whose custom connection stub never
settles against a bare `undici.request()`. Given the time budget for this exploration,
that second hang is left as a named follow-up rather than fully bisected; see the PR
plan's acceptance criteria for the job needing a per-test timeout guard (already present,
15s) **and** a way to fail forward past a hung test instead of blocking the whole file -
vitest's own `--bail`-adjacent isolation, or splitting the upstream file into per-`describe`
runs, would do it.

**Filtered run (30 of the 246 tests, chosen to cover JSON, redirects, gzip/br/zstd/
compress decompression, default headers, size limits, streams/buffers, cancellation,
baseURL combining, protocol errors, and timeouts - i.e. transport/response/error
behaviour, not proxy/socket/agent internals): 15 passed, 15 failed.**

Real, concrete incompatibilities (grouped; each is either newly precise or newly
confirmed against a real upstream assertion rather than an internal probe):

- **Timeout error message/format.** Repro: `axios.get(url, { timeout: 250 })` against a
  server that never responds. Axios: `code: 'ECONNABORTED'`,
  `message: 'timeout of 250ms exceeded'`. Ours: `message: 'timeout exceeded'` (no
  duration). A separate case with `timeoutErrorMessage: 'oops, timeout'` set shows the
  option is **ignored outright** - message stays `'timeout exceeded'` instead of
  `'oops, timeout'`. Matches the open plan.md "fix(errors)" bullet
  (`timeoutErrorMessage`); this pins the exact expected string.
- **`response.request`/`error.request` is a useless placeholder.** Repro: after a
  redirect, `response.request.path` is `undefined`; axios sets it to `'/two'` (the
  final hop's path) because `response.request` is the real `http.ClientRequest`. Matches
  the already-tracked "`error.request`/`response.request` are never set" bullet, with a
  field (`.path`) confirmed to be read by real-world/upstream code, not just
  `!!response.request`.
- **`maxBodyLength` (request body size) is not enforced at all.** Repro: `axios.post(url,
  bigBody, { maxBodyLength: <bigBody.length - 1> })` resolves instead of rejecting.
  Matches the already-tracked "a per-request `maxBodyLength` is ignored" bullet, now with
  a passing/failing repro instead of a code-reading note.
- **Unsupported-protocol errors carry undici's message, not axios's.** Repro:
  `axios.get('tel:484-695-3408')`. Axios: `message: 'Unsupported protocol tel:'`. Ours:
  `message: 'Invalid URL protocol: the URL must start with \`http:\` or \`https:\`.'`
  (verbatim from wherever the URL gets rejected before undici is even reached). Matches
  the tracked "errors undici throws synchronously... come through raw" bullet, with the
  exact wording gap.
- **`compress` (legacy LZW) and `zstd` `Content-Encoding` are not decompressed.** This is
  already a *deliberately documented* gap for `compress`
  (`axios-response-type.adapter.ts`'s comment on `SUPPORTED_CONTENT_ENCODINGS`); `zstd`
  isn't mentioned there at all, so this test confirms it falls into the same,
  already-accepted "gzip/deflate/br only" boundary rather than being a fresh gap - noted
  for completeness, not as a new must-fix.

Not real bugs (harness/prototype limitations or environment artifacts):

- **No default `User-Agent`/`Accept`/`Accept-Encoding` headers on the bare adapter.**
  `should provides a default User-Agent header` expects `axios/<version>`; the prototype
  adapter sends whatever `config.headers` already contains, because default-header
  injection happens in `HttpService`'s own request path (and `axiosRef`'s defaults),
  both of which strategy (b) deliberately bypasses (see "what it bypasses" above). Real
  `HttpService.get()` calls *do* set a default `User-Agent` (`nestjs-axios-undici/<version>`,
  by design - see `DEFAULT_USER_AGENT` in `http.service.ts`); this failure is about the
  standalone prototype adapter, not the package.
- **The legacy-`CancelToken` hang and its 4 cascading `EADDRINUSE` failures** (`should
  support cancel`, `should combine baseURL and url`, `should support HTTP protocol`,
  `should support HTTPS protocol`, `should throw an error if http server that aborts a
  chunked request`) are the one root-cause prototype gap described above, not 5
  independent findings.
- **`should respect the timeout property during TCP connect with maxRedirects set to 0`**
  expects `ECONNABORTED` but gets `ENOTFOUND`. This exercises a DNS-timeout race against
  a non-routable address; the same sandbox proxy that turned the baseline's 2 real-DNS
  failures into `403`s (see above) is a strong confound here too. Inconclusive without a
  network-unrestricted environment - flagged, not counted as a finding either way.

Net: of 15 failures, **5 are real, reproducible package gaps** (all already tracked in
`plan.md` phase 2, now with concrete upstream-sourced repro strings), **1 is
inconclusive** (network sandbox), and **9** are one prototype wiring gap and its
cascade. That ratio - most failures traced to a single, fixable harness issue rather
than a long tail of unique problems - is itself useful signal: strategy (b)'s adapter
surface is small enough that fixing it once (legacy `CancelToken`) unblocks most of the
remaining, currently-unrun tests in the file.

## Proposed PR plan

1. **`ci(conformance): @nestjs/axios spec suite (strategy a).`** Add
   `tests/upstream/nestjs-axios/run.mjs` (promoted out of `plan/`) as a
   CI job: clone at a pinned tag, run, diff against a checked-in expected-failures list
   (see below) so the job only fails on a *new* regression, not on the known,
   already-tracked gaps §1 lists.
   - Acceptance: the job runs on a schedule (weekly, to catch new `@nestjs/axios`
     releases within `peerDependencies`' range) and on any PR touching `src/`; a bump to
     the pinned tag is a one-line diff; new failures not in the expected list fail the
     job with the failing test's name in the summary.
2. **`ci(conformance): axios adapter suite (strategy b).`** Same shape, pointed at
   `tests/unit/adapters/http.test.js`, filtered to exclude the httpAdapter-internals/
   proxy-agent/socket-pooling tests that have no analogue (an explicit exclude list, not
   a blanket skip, so a newly-added transferable test in a future axios release is
   picked up automatically).
   - Acceptance: same schedule; same expected-failures mechanism.
3. **Once `claude/axiosref-instance` merges:** extend the axios prototype to strategy
   (a) (`axios.create` → `new HttpService(...).axiosRef`) and re-run the same file
   unfiltered; fold its previously-`skipped` cases into the CI job once they're green or
   explicitly tracked.
4. **Expected-failures list.** A small JSON/YAML file next to each CI job, one entry per
   known-failing upstream test name plus the plan.md phase-2 item it's tracked under
   (mirrors `knownDifference` in `tests/compat/differential/harness.ts`); the job diffs
   the current failing-test set against it and only reports *new* names. Removing an
   entry when a fix lands is the same one-line discipline the differential harness
   already uses.
5. **Runtime cost.** The `@nestjs/axios` prototype run (build + clone + 23 tests) is a
   few seconds once the clone is cached. The axios prototype's baseline (246 tests,
   real axios) took ~66s in this sandbox; expect a similar order of magnitude for the
   adapter-swapped run. Both are far cheaper than the perf benchmark job, so a weekly
   schedule plus a PR-triggered run gated on `src/**` changes is reasonable, not
   "run on every commit."
