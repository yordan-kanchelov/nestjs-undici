# Upstream conformance suites

These suites check this package's behaviour against the *real, unmodified* test
files of the two projects it's a drop-in replacement for: `@nestjs/axios` and
`axios`. They live under `tests/`, not `plan/prototypes/`, which they replace.
See `plan/reports/upstream-test-suites.md`. They're runnable, maintained CI
jobs now, not one-off explorations. They sit under their own
`tests/upstream/` folder rather than plain `tests/*.spec.ts` because Jest's
`testRegex` (`(/__tests__/.*|(\.|/)(test|spec))\.(t|j)s$`, in the root
`jest.config.js`) must never pick up a spec file this suite copies out of an
upstream clone at run time. None of the files below are named
`*.spec.*`/`*.test.*` themselves, so `npm run test:jest` never sees them.

## What runs, and why two axios strategies

- **`nestjs-axios/`**: `@nestjs/axios`'s own `tests/http.service.spec.ts` and
  `tests/http.module.spec.ts` (vitest originals), run unmodified through this
  repo's Jest with a `moduleNameMapper` shim pointing `../lib/index.js` /
  `../lib/http.constants.js` at this package's built `HttpModule`/
  `HttpService`. `tests/esm.spec.ts` is intentionally not copied: it only
  checks `@nestjs/axios`'s own packaging, not shared behaviour.
- **`axios/`**: axios' `tests/unit/adapters/http.test.js`, run unmodified
  through axios' own vitest, under two strategies:
  - **(a) axiosRef as the instance** (`adapters/axiosref-instance.mjs`):
    aliases the test file's `import axios from '../../../index.js'` to
    `new HttpService({}, {}).axiosRef`, the object a real consumer of this
    package gets from `httpService.axiosRef`. Exercises axiosRef's
    interceptor chain and config normalization.
  - **(b) our transport as an axios `adapter`** (`adapters/undici-adapter.cjs`):
    a small `axios.defaults.adapter` function built from this package's own
    response/error/redirect code (`lib/modules/http/adapters/*`,
    `lib/modules/http/errors/*`). Narrower: it bypasses axiosRef's
    interceptor/config-normalization pipeline entirely. But it's cheap, with
    no DI and no interceptor setup, and it still catches real
    transport/response/error bugs, as documented in
    `plan/reports/upstream-test-suites.md`.

Both projects are cloned at a pinned tag at run time into a temp/cache
directory (`--clone-dir`, defaulting under `os.tmpdir()`), never vendored.

## Expected failures

Each suite/strategy has an `expected-failures*.json`: `{ "<test full
name>": "<reason>" }`, or, for a test whose outcome depends on the runner's
own environment rather than on this package (see "IPv6" below), `{ "<name>":
{ "reason": "...", "environmentDependent": true } }`. A plain-string reason
is either a `plan.md` item (something still to fix) or one of `deliberate
difference` / `Node http-specific` / `harness limitation` (see each file for
specifics). The runner (`tests/upstream/lib/conformance.mjs`) diffs the
actual result set against this list on every run, the same `knownDifference`
discipline `tests/compat/differential/harness.ts` uses:

- an expected failure that still fails: fine, silently counted.
- an expected failure that now **passes**: the run **fails**, because the
  underlying fix landed and the entry should be removed from the list.
- a failure **not** on the list: the run **fails** (a new regression).
- an expected-failures entry for a test the suite no longer even runs (e.g. a
  rename after bumping the pinned tag): the run **fails**, since that's a
  stale entry. An `environmentDependent` entry is exempt: it's fine for one
  of those to go unseen on a run where a filter didn't happen to select it.
- an `environmentDependent` entry may pass **or** fail on any given run;
  either way it's tracked in its own bucket, never treated as new or fixed.
- a test whose chunk (see below) never produced a result at all, whether
  from a genuine hang or because the per-strategy deadline was reached
  first, is reported **NOT EVALUATED**, in its own bucket, and **always
  fails the run**. Pass/fail for it is simply unknown, and this runner
  never silently folds "unknown" into "expected" or "passed" the way a
  naive diff would.

A short summary (passed / expected failures / new failures / fixed / not
evaluated / environment-dependent) is printed to the console and appended to
`$GITHUB_STEP_SUMMARY` in CI.

`tests/upstream/axios/run.mjs` also keeps a small `HARD_EXCLUDES` list (tests
that must never even start, for example because they hang the whole file
rather than failing; see that file's comment for each bisected, concrete
case) as a filter passed to vitest's `-t`, separate from
`expected-failures*.json`, since those tests never run at all.

## Keeping the axios suite from hanging

A full, unfiltered run of axios' `tests/unit/adapters/http.test.js` hung early
when first prototyped (see `plan/reports/upstream-test-suites.md`), and again
on a real, dedicated GitHub Actions runner once this suite first shipped.
Bisecting it found two distinct, real causes:

- Upstream's own fixture (`tests/setup/server.js`, not modified) calls
  `server.listen(port, callback)` and only ever invokes `callback` on
  success. A bind failure (`EADDRINUSE`) has no way to reach it. Around 200
  of this file's tests share one fixed port, so if a previous test's socket
  hadn't fully released it yet, the next one could hang forever waiting for
  a callback that was never coming. `adapters/ephemeral-ports.cjs` patches
  `net.Server.prototype.listen` to swap that fixture's fixed ports for `0`,
  an OS-assigned one, transparently. Every test reads the real bound port
  back off `server.address().port` anyway, except one that hardcodes the
  literal port number in a redirect `Location` header, which is listed as
  an expected failure instead. This hang is fixed.
- The file's `progress`/`Rate limit` describe blocks are genuinely,
  deliberately slow **by test design**, not hung. For example, "should
  support upload progress capturing" `await`s a real `setTimeout(...,
  1100)` ten times in its own body (about 11 seconds), to produce ten
  distinct progress samples over real time. Several such tests sit close
  together in file order. Bundled into one chunk (below), their legitimate
  durations simply add up past a short per-attempt timeout,
  indistinguishable from a hang from the outside. This isn't a bug to fix
  in the adapter. It just needs a per-attempt timeout with headroom for a
  few such tests (`CHUNK_TIMEOUT_MS`), and a chunk small enough that a
  cluster of them doesn't dominate one attempt (`CHUNK_SIZE`).

`run.mjs` runs the file across several vitest processes instead of one (a
fresh process reclaims the OS port instantly on exit, unlike the graceful,
in-process `server.close()` the fixture's own cleanup relies on), and
recursively splits and retries any chunk that doesn't produce a report, down
to one test at a time, bounded by a per-strategy wall-clock deadline
(`STRATEGY_DEADLINE_MS`). Once that deadline is reached, whatever's left is
reported NOT EVALUATED (see "Expected failures" above) rather than silently
treated as failed or dropped. `.github/workflows/upstream.yml` runs the
nestjs-axios suite and axios' two strategies as **3 parallel matrix jobs**,
not one job in sequence, so a slow strategy's own deadline doesn't eat into
a sibling's budget or the job's `timeout-minutes`.

### IPv6

`should support IPv6 literal strings` needs IPv6 support/routing on the
runner (an `::1` bind and connect). It's marked `environmentDependent` in
both axios expected-failures files rather than given a fixed expected
outcome: it fails in a sandbox with no IPv6 and passes on a real Actions
runner, and neither outcome says anything about this package.

### Internet access

`should not throw TypeError when a proxy agent stream does not define
setKeepAlive (regression #10908)` passes a mock `transport`, a Node
http-specific option this package ignores, so the request goes out for real
to `http://example.com/`. It passes on a runner with internet access and
fails offline, so it's `environmentDependent` in both axios files too.

`should respect the timeout property during TCP connect with maxRedirects
set to 0` is the DNS flavour of the same thing. Its hanging custom
`httpAgent` is ignored here, so the request really resolves
`connect-timeout.test`, and whether the 100ms timeout or an `ENOTFOUND` wins
depends on the runner's resolver. It's `environmentDependent` in both
strategies.

## Licence

`@nestjs/axios` and `axios` are both MIT licensed. This package clones them at
run time and doesn't vendor a copy; running their own, unmodified test files
against a different implementation under test is within the scope MIT's
permissions grant regardless, but as a courtesy: **`@nestjs/axios`** is
Copyright (c) Nest, MIT licensed
(https://github.com/nestjs/axios/blob/master/LICENSE); **`axios`** is
Copyright (c) 2014-present Matt Zabriskie & axios Contributors, MIT licensed
(https://github.com/axios/axios/blob/main/LICENSE).

## Running locally

```bash
npm run test:upstream          # both suites
npm run test:upstream:nestjs   # just @nestjs/axios
npm run test:upstream:axios    # just axios (both strategies)
```

Each `run.mjs` also runs standalone with its own flags (`--ref`, `--keep`,
`--clone-dir`, `--skip-build`; `axios/run.mjs` also takes `--strategy a|b|both`).
See each file's header comment. Run with the proxy env vars (`HTTP_PROXY`/
`HTTPS_PROXY`) unset, since the suites start real local `node:http` servers,
and a proxy in front of `localhost` traffic breaks them.

## Bumping a pinned tag

Bump `--ref`'s default in `nestjs-axios/run.mjs` or `axios/run.mjs` together
with this repo's matching devDependency (`@nestjs/axios` / `axios` in
`package.json`), then run the suite. A new upstream release can rename or add
tests, which the stale-entry check above will catch as a failure pointing at
exactly what changed.
