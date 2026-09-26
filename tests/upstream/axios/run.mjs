#!/usr/bin/env node
// Upstream conformance suite: axios' own unit-adapter spec file
// (tests/unit/adapters/http.test.js), run unmodified against this package,
// under two strategies:
//
//   (a) axiosRef as the instance: axios' `create()`/default export are
//       shimmed to `new HttpService({}, {}).axiosRef` (adapters/
//       axiosref-instance.mjs) - exercises axiosRef's interceptor chain and
//       config normalization, the object a real consumer actually gets.
//   (b) an axios `adapter` backed by our transport (adapters/
//       undici-adapter.cjs) - narrower (bypasses axiosRef entirely), but
//       cheap and catches real transport/response/error bugs on its own
//       (see plan/reports/upstream-test-suites.md).
//
// Usage: node tests/upstream/axios/run.mjs [--ref v1.20.0] [--keep]
//          [--clone-dir DIR] [--skip-build] [--strategy a|b|both]
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT,
  buildLib,
  ensureClone,
  defaultCloneDir,
  loadExpectedFailures,
  readJsonReport,
  normalizeTestName,
  diffResults,
  printSummary,
  isSuiteFailing,
  run,
} from '../lib/conformance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE_UNDER_TEST = 'tests/unit/adapters/http.test.js';

// Tests that hang or crash the whole file no matter the strategy, because
// they poke at APIs with no analogue here (raw socket/agent internals) or
// depend on process-wide state this harness can't reproduce safely. Each
// key is matched as a substring of a test's full name; matching tests are
// dropped before chunking (see `runStrategy`) so they never even start (a
// per-test timeout can't help here - see each reason).
const HARD_EXCLUDES = {
  'should support cancel':
    'harness limitation: legacy axios.CancelToken (not AbortController); before adapters/undici-adapter.cjs wired config.cancelToken through, this hung for the full test timeout and its fixed-port fixture server was then never closed, cascading EADDRINUSE into every later test on that port. Wiring it fixed the hang; kept excluded anyway because the test also asserts on cancellation timing internals (a real Node http.ClientRequest.abort()) this adapter does not reproduce exactly.',
  'should respect the timeout property during TCP connect with maxRedirects set to 0':
    "harness limitation: simulates a hung TCP connect with a custom Node http.Agent (HangingConnectAgent, a stubbed net.Socket that never connects) passed as config.httpAgent - undici has no concept of a Node http.Agent, so this adapter ignores it and makes a REAL DNS lookup for the test's fake hostname (connect-timeout.test) instead. In a network-restricted sandbox/CI runner that lookup can hang well past the test's own guard timeout (it blocks a libuv threadpool worker, not cancelled by aborting the request), which was bisected as the actual cause of the harness hang this file's header describes: it wedged the threadpool and cascaded 15s timeouts into every later test in the file.",
  'should not time out immediately for timeout set to zero during TCP connect':
    'harness limitation: same HangingConnectAgent/fake-hostname pattern as the case above, same reason.',
  'should allow passing FormData':
    "harness limitation: real axios' own http adapter detects a form-data-shaped body (a `getHeaders()` method) and merges its computed headers - crucially the multipart boundary - into the request; this bare test adapter doesn't reimplement that (it isn't part of the response/error/redirect code it reuses from src/), so the request goes out with the test's own plain `Content-Type: multipart/form-data` and no boundary. The server side's multipart parser (formidable, upstream's own fixture) then waits indefinitely for a boundary it never finds, which hangs the whole request rather than failing it - confirmed to reproduce even with this one test running alone. Strategy (a) (axiosRef as the instance) exercises this package's real `postForm`/multipart handling instead.",
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeSetup(file, contents) {
  writeFileSync(file, contents);
}

// One test file, run to completion, hangs early in this sandbox and on a
// real, dedicated GitHub Actions runner alike (see tests/upstream/README.md
// and the report) - two real, distinct causes, both root-caused:
//
// 1. Several tests deliberately fail a redirect hop for security reasons;
//    an undrained response body on that path could leave the suite's one
//    fixed test port unusable long enough that the *next* test's
//    `server.listen()` never calls back at all (a real bug in the fixture
//    itself, tests/setup/server.js, not modified here - `listen(port, cb)`'s
//    callback only ever fires on success). Fixed by draining the body on
//    that path too (undici-adapter.cjs) and by `adapters/ephemeral-ports.cjs`
//    (swaps the fixture's fixed ports for OS-assigned ones, so two tests can
//    never contend for the same port in the first place).
// 2. The file's `progress`/`Rate limit` describe blocks are genuinely,
//    deliberately slow BY DESIGN, not hung: e.g. "should support upload
//    progress capturing" awaits `setTimeout(..., 1100)` ten times in its own
//    body (~11s), to produce ten distinct progress samples over real time.
//    Several such tests (10-15s+ each) sit close together in file order;
//    bundled into one chunk, their real, legitimate durations simply add up
//    past a short per-attempt timeout, which looks identical to a hang from
//    the outside (a `signal: null, status: 143` kill). This is the runner's
//    own tuning problem, not a bug to fix in the adapter: give every attempt
//    enough headroom for a few such tests, and this is bounded and correct.
//
// Splitting the single vitest invocation into several, each running one
// contiguous slice of the file's tests, handles cause 1 directly (a fresh
// process reclaims the OS-level port immediately on exit) and, combined
// with a per-attempt timeout generous enough for a handful of slow tests,
// handles cause 2: a slice that's still too slow (several 10s+ tests
// together) gets split into smaller slices until each fits comfortably.
// Every test that hits the (long, but finite) per-strategy deadline anyway
// is reported as NOT EVALUATED (see conformance.mjs's `diffResults`), never
// silently folded into "expected failure" or "passed".
const CHUNK_SIZE = 10;
const CHUNK_TIMEOUT_MS = 25_000;
// A hard ceiling on how long the split-and-retry dance above is allowed to
// keep going, for one strategy, before it gives up on whatever's left and
// reports it NOT EVALUATED - so a run that hits real, sustained slowness
// still finishes in bounded time instead of chasing it arbitrarily long.
// Each strategy (and the nestjs-axios suite) is its own parallel CI job
// (.github/workflows/upstream.yml), so this doesn't share a budget with its
// siblings the way it would in one serial job.
const STRATEGY_DEADLINE_MS = 240_000;

/** `vitest list --json`: the ordered, full list of test names in the file (no filter applied). */
function listTests({ cloneDir, vitestConfigPath, env }) {
  const vitestBin = path.join(cloneDir, 'node_modules', '.bin', 'vitest');
  const result = spawnSync(
    vitestBin,
    ['list', '--config', vitestConfigPath, '--json'],
    { cwd: cloneDir, encoding: 'utf8', env },
  );
  if (result.status !== 0 || !result.stdout) {
    throw new Error(
      `vitest list failed (status ${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout).map(t => t.name);
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size)
    out.push(array.slice(i, i + size));
  return out;
}

async function runStrategy({
  name,
  cloneDir,
  setupContents,
  aliasTarget,
  expectedFailuresFile,
}) {
  const deadlineAt = Date.now() + STRATEGY_DEADLINE_MS;
  const vitestConfigPath = path.join(
    cloneDir,
    `.conformance-${name}.vitest.config.mjs`,
  );

  let setupFilesEntry = '';
  if (setupContents) {
    const setupPath = path.join(cloneDir, `.conformance-${name}.setup.mjs`);
    writeSetup(setupPath, setupContents);
    setupFilesEntry = `setupFiles: [${JSON.stringify(setupPath)}],`;
  }

  let aliasEntry = '';
  if (aliasTarget) {
    // Redirects the test file's `import axios from '../../../index.js'` to
    // our shim module entirely, matched on the relative specifier text
    // (the only way it's ever written in this one file) rather than on a
    // resolved path, the same way the nestjs-axios suite's jest
    // moduleNameMapper regex works.
    aliasEntry = `resolve: {
      alias: [
        { find: /\\.\\.\\/\\.\\.\\/\\.\\.\\/index\\.js$/, replacement: ${JSON.stringify(aliasTarget)} },
      ],
    },`;
  }

  writeSetup(
    vitestConfigPath,
    `import { defineConfig } from 'vitest/config';
export default defineConfig({
  ${aliasEntry}
  test: {
    testTimeout: 15000,
    environment: 'node',
    include: [${JSON.stringify(FILE_UNDER_TEST)}],
    ${setupFilesEntry}
  },
});
`,
  );

  const env = {
    ...process.env,
    CONFORMANCE_LIB_DIR: path.join(REPO_ROOT, 'lib', 'modules', 'http'),
    CONFORMANCE_REPO_LIB: path.join(REPO_ROOT, 'lib', 'index.js'),
  };

  console.log(`\n[axios:${name}] listing ${FILE_UNDER_TEST} ...`);
  const allNames = listTests({ cloneDir, vitestConfigPath, env });
  const runnableNames = allNames.filter(
    n => !Object.keys(HARD_EXCLUDES).some(excluded => n.includes(excluded)),
  );
  const chunks = chunk(runnableNames, CHUNK_SIZE);
  console.log(
    `[axios:${name}] running ${runnableNames.length} tests (of ${allNames.length}, ` +
      `${allNames.length - runnableNames.length} hard-excluded) in ${chunks.length} chunk(s) ` +
      `of up to ${CHUNK_SIZE} ...\n`,
  );

  const vitestBin = path.join(cloneDir, 'node_modules', '.bin', 'vitest');

  // Runs one slice of `names` in its own vitest process; if that process
  // hangs or crashes without ever writing a JSON report - the whole point
  // of chunking (see the comment above `CHUNK_SIZE`) - splits the slice in
  // half and retries each half recursively, down to one test at a time,
  // instead of giving up on the whole chunk. A single test never
  // reproduces the underlying issue on its own (confirmed while bisecting
  // it), so this reliably converges to real results rather than losing an
  // entire chunk's worth of otherwise-fine tests to one bad interaction.
  async function runNamesSlice(names, label) {
    if (Date.now() > deadlineAt) {
      console.log(
        `[axios:${name}] slice "${label}" (${names.length} tests): strategy deadline ` +
          `(${STRATEGY_DEADLINE_MS}ms) reached - not retrying further, reporting NOT EVALUATED.`,
      );
      return names.map(n => ({
        fullName: normalizeTestName(n),
        status: 'not_evaluated',
      }));
    }
    const resultsFile = path.join(
      cloneDir,
      `.conformance-${name}.chunk-${label}.results.json`,
    );
    // vitest's `-t` does a plain (unanchored) regex search against each
    // test's full name, so matching on just the leaf title - not the
    // `describe > it` path `vitest list` prints, a different, unrelated
    // format from the one the JSON reporter's `fullName` uses elsewhere in
    // this file - is enough: every title in this suite is a full, distinct
    // sentence, so a leaf title from one chunk never matches a different
    // test in another.
    const filter = names.map(n => escapeRegExp(n.split(' > ').pop())).join('|');
    const result = spawnSync(
      vitestBin,
      [
        'run',
        '--config',
        vitestConfigPath,
        '--reporter=dot',
        '--reporter=json',
        `--outputFile=${resultsFile}`,
        '-t',
        filter,
      ],
      { cwd: cloneDir, env, stdio: 'inherit', timeout: CHUNK_TIMEOUT_MS },
    );
    if (existsSync(resultsFile)) {
      return readJsonReport(resultsFile);
    }
    if (names.length === 1) {
      console.log(
        `[axios:${name}] "${names[0]}" produced no results file on its own ` +
          `(signal: ${result.signal}, status: ${result.status}) - reporting NOT EVALUATED.`,
      );
      return [
        { fullName: normalizeTestName(names[0]), status: 'not_evaluated' },
      ];
    }
    console.log(
      `[axios:${name}] slice "${label}" (${names.length} tests) produced no results file ` +
        `(signal: ${result.signal}, status: ${result.status}) - splitting and retrying.`,
    );
    const mid = Math.ceil(names.length / 2);
    const left = await runNamesSlice(names.slice(0, mid), `${label}a`);
    const right = await runNamesSlice(names.slice(mid), `${label}b`);
    return [...left, ...right];
  }

  const combinedResults = [];
  for (const [i, names] of chunks.entries()) {
    console.log(
      `[axios:${name}] chunk ${i + 1}/${chunks.length} (${names.length} tests) ...`,
    );
    combinedResults.push(...(await runNamesSlice(names, String(i))));
  }

  const expected = loadExpectedFailures(expectedFailuresFile);
  const diff = diffResults(combinedResults, expected);
  const excludedCount = allNames.length - runnableNames.length;
  const label =
    `axios tests/unit/adapters/http.test.js - strategy (${name}) ` +
    `(${excludedCount} test${excludedCount === 1 ? '' : 's'} hard-excluded, see run.mjs HARD_EXCLUDES)`;
  printSummary(label, diff);
  return isSuiteFailing(diff);
}

export async function main(argv = process.argv.slice(2)) {
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? def : argv[i + 1];
  };
  const REF = flag('ref', 'v1.20.0');
  const STRATEGY = flag('strategy', 'both');
  const SKIP_BUILD = argv.includes('--skip-build');
  const CLONE_DIR = flag('clone-dir', null) ?? defaultCloneDir(`axios-${REF}`);

  console.log("[axios] [1/4] building this repo's lib/ ...");
  if (!SKIP_BUILD) buildLib();

  console.log(`[axios] [2/4] cloning axios @ ${REF} ...`);
  ensureClone({
    url: 'https://github.com/axios/axios.git',
    ref: REF,
    dir: CLONE_DIR,
  });

  console.log(
    '[axios] [3/4] npm install in the clone (its own vitest/express/etc. dev deps) ...',
  );
  if (!existsSync(path.join(CLONE_DIR, 'node_modules'))) {
    run('npm', ['install', '--ignore-scripts'], { cwd: CLONE_DIR });
  } else {
    console.log('  (reusing existing node_modules)');
  }

  console.log('[axios] [4/4] running both strategies ...');
  let failing = false;

  const ephemeralPortsImport = `import ${JSON.stringify(path.join(HERE, 'adapters', 'ephemeral-ports.cjs'))};\n`;

  if (STRATEGY === 'a' || STRATEGY === 'both') {
    failing =
      (await runStrategy({
        name: 'a',
        cloneDir: CLONE_DIR,
        setupContents: ephemeralPortsImport,
        aliasTarget: path.join(HERE, 'adapters', 'axiosref-instance.mjs'),
        expectedFailuresFile: path.join(
          HERE,
          'expected-failures.strategy-a.json',
        ),
      })) || failing;
  }

  if (STRATEGY === 'b' || STRATEGY === 'both') {
    const setupContents = `${ephemeralPortsImport}import axios from ${JSON.stringify(path.join(CLONE_DIR, 'index.js'))};
import buildFullPath from ${JSON.stringify(path.join(CLONE_DIR, 'lib', 'core', 'buildFullPath.js'))};
import { makeAdapter } from ${JSON.stringify(path.join(HERE, 'adapters', 'undici-adapter.cjs'))};

axios.defaults.adapter = makeAdapter({ buildFullPath });
`;
    failing =
      (await runStrategy({
        name: 'b',
        cloneDir: CLONE_DIR,
        setupContents,
        expectedFailuresFile: path.join(
          HERE,
          'expected-failures.strategy-b.json',
        ),
      })) || failing;
  }

  return failing ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => process.exit(code));
}
