// Shared plumbing for the upstream conformance suites (tests/upstream/*).
//
// Each suite (nestjs-axios, axios strategy a, axios strategy b) clones its
// upstream project at a pinned tag, runs one of *its own, unmodified* spec
// files against this package, and diffs the resulting pass/fail set against
// a checked-in `expected-failures.json` (test full name -> reason), the same
// `knownDifference` discipline `tests/compat/differential/harness.ts` uses:
//
//   - a test that's expected to fail and does: fine, counted, not printed.
//   - a test that's expected to fail and now PASSES: the job fails ("remove
//     from list" - the fix landed, the expected-failures entry is stale).
//   - a test that isn't listed and fails: the job fails (a new regression).
//
// Nothing here touches src/.
'use strict';

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

export function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      const name = JSON.parse(readFileSync(pkg, 'utf8')).name;
      if (name === 'nestjs-axios-undici') return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not find repo root (package.json "nestjs-axios-undici")');
}

export const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

/** Builds this repo's `lib/` once. Cheap (~2s); safe to call from every suite. */
export function buildLib() {
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
}

/**
 * Base directory for a suite's clone, when `--clone-dir` isn't passed:
 * `$CONFORMANCE_CLONE_ROOT` if set (the CI workflow points this at a cached
 * directory, keyed by these run.mjs files' content, so a pin bump busts the
 * cache automatically), else a fixed spot under the OS temp dir.
 */
export function defaultCloneDir(name) {
  const root = process.env.CONFORMANCE_CLONE_ROOT ?? path.join(os.tmpdir(), 'conformance-clones');
  return path.join(root, name);
}

/**
 * Clones `url` at the pinned tag `ref` into `dir` (shallow, depth 1),
 * reusing an existing clone if `dir` already exists - the CI workflow keys
 * its cache on `ref`, so a cache hit skips this entirely.
 */
export function ensureClone({ url, ref, dir }) {
  if (existsSync(path.join(dir, '.git'))) {
    console.log(`  (reusing existing clone of ${url} @ ${ref} in ${dir})`);
    return;
  }
  mkdirSync(path.dirname(dir), { recursive: true });
  console.log(`  cloning ${url} @ ${ref} into ${dir} ...`);
  execFileSync(
    'git',
    ['clone', '--depth', '1', '--branch', ref, url, dir],
    { stdio: 'inherit' },
  );
}

/**
 * Reads `expected-failures.json`: `{ "<test full name>": "<reason>" }`, or,
 * for a test whose outcome depends on the environment rather than on this
 * package (no IPv6 on the runner, a DNS/proxy quirk of one particular box -
 * see `should support IPv6 literal strings`), `{ "<name>": { "reason":
 * "...", "environmentDependent": true } }`: that entry is allowed to pass
 * *or* fail on any given run, tracked separately, and never counted as a
 * "new failure" or a stale "now passing, remove it" the way a plain string
 * entry would be.
 */
export function loadExpectedFailures(file) {
  if (!existsSync(file)) return {};
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file}: expected a JSON object of {testName: reason}`);
  }
  for (const [name, value] of Object.entries(data)) {
    const ok =
      typeof value === 'string' ||
      (value && typeof value === 'object' && typeof value.reason === 'string');
    if (!ok) {
      throw new Error(
        `${file}: "${name}"'s value must be a reason string, or {reason, environmentDependent: true}`,
      );
    }
  }
  return data;
}

function isEnvironmentDependent(entry) {
  return !!(entry && typeof entry === 'object' && entry.environmentDependent);
}

/**
 * Normalizes a test's full name so it's stable across the different ways
 * this repo's tools print a `describe`/`it` chain (Jest and Vitest's own
 * `--reporter=json` join nested describes with a plain space; `vitest
 * list`'s own output, and its console reporters, join with ` > `) - both
 * collapse to the same key, so an expected-failures entry, or a name this
 * runner builds itself (e.g. for a chunk that produced no report at all),
 * matches regardless of which tool produced it.
 */
export function normalizeTestName(name) {
  return name
    .replace(/\s*>\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Runs a Jest- or Vitest-produced JSON report (both use the same
 * `--json`/`--reporter=json` `testResults[].assertionResults[]` shape, with
 * `fullName` and `status` per test) into a flat list of
 * `{ fullName, status }`, `status` one of 'passed' | 'failed'.
 *
 * Everything else (`pending`/`skipped`/`todo` - a test the `-t` filter
 * didn't select for this run) is dropped rather than kept as some third
 * status: a chunked run (tests/upstream/axios/run.mjs) merges *several*
 * reports together, each one covering the whole upstream file but only
 * really running its own slice - every other test in it shows up here as
 * `skipped`. Keeping those entries around would let one file's "skipped"
 * silently clobber another file's real "passed"/"failed" for the same test
 * once the caller merges by name (last write wins) - dropping them here
 * instead means only an actual pass or fail for a test is ever recorded.
 */
export function readJsonReport(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const out = [];
  for (const suite of raw.testResults ?? []) {
    for (const a of suite.assertionResults ?? []) {
      if (a.status !== 'passed' && a.status !== 'failed') continue;
      const entry = { fullName: normalizeTestName(a.fullName), status: a.status };
      // Both Jest's `--json` and Vitest's `--reporter=json` put each
      // failure's message+stack as one string in `failureMessages`; keeping
      // just the first line of the first one is enough to make a *new*
      // failure diagnosable from the job summary alone, without pulling up
      // the full (often huge) job log.
      if (a.status === 'failed' && a.failureMessages?.[0]) {
        entry.failureMessage = a.failureMessages[0].split('\n', 1)[0];
      }
      out.push(entry);
    }
  }
  return out;
}

/**
 * Diffs a suite's actual results against its expected-failures list and
 * returns the buckets the task asks for, plus whether the run should fail.
 *
 * `results` may include a third status, `'not_evaluated'`: a test whose
 * chunk (tests/upstream/axios/run.mjs) never produced a report at all
 * (hung, or the per-strategy deadline was reached first). Those are
 * *never* matched against `expected` - passing or failing is unknown, not
 * "expected" or "new" - and always get their own bucket, reported
 * separately, and always fail the run: an unevaluated test is exactly the
 * silent gap this runner must not paper over.
 *
 * An `expected` entry marked `environmentDependent` (see
 * `loadExpectedFailures`) is allowed to pass *or* fail on any given run;
 * either way it's tracked in its own bucket, never `fixed` or `newFailures`.
 */
export function diffResults(results, expected) {
  const passed = [];
  const expectedFail = [];
  const newFailures = [];
  const fixed = [];
  const environmentDependent = [];
  const notEvaluated = [];
  const seen = new Set();

  // A chunked run can, rarely, run the same test twice (a leaf title from
  // one chunk matching as a substring inside another test's full name);
  // keep only the last result for a given name rather than double-counting
  // it. A 'not_evaluated' result never overwrites a real passed/failed one
  // for the same name (and vice versa isn't possible: each name is only
  // ever in exactly one chunk's `names` list) - `not_evaluated` synthetic
  // entries and real results never collide in practice, but prefer a real
  // result if they ever do.
  const byName = new Map();
  for (const r of results) {
    const prior = byName.get(r.fullName);
    if (prior && prior.status !== 'not_evaluated' && r.status === 'not_evaluated') continue;
    byName.set(r.fullName, r);
  }

  for (const r of byName.values()) {
    seen.add(r.fullName);
    const entry = expected[r.fullName];
    const isExpected = Object.prototype.hasOwnProperty.call(expected, r.fullName);
    const envDependent = isEnvironmentDependent(entry);

    if (r.status === 'not_evaluated') {
      notEvaluated.push(r);
    } else if (envDependent) {
      environmentDependent.push(r);
    } else if (r.status === 'failed') {
      if (isExpected) expectedFail.push(r);
      else newFailures.push(r);
    } else if (r.status === 'passed') {
      if (isExpected) fixed.push(r);
      else passed.push(r);
    }
  }

  // An expected-failures entry for a test the suite no longer even runs
  // (renamed/removed upstream, or - this run - never evaluated) is just as
  // stale as one that now passes for a plain entry - surface it the same
  // way so the list stays accurate. An environment-dependent entry is
  // exempt: it's fine for it to go unseen on a run where, say, this
  // particular test didn't happen to be selected.
  const stale = Object.keys(expected).filter(
    name => !seen.has(name) && !isEnvironmentDependent(expected[name]),
  );

  return {
    passed,
    expectedFail,
    newFailures,
    fixed,
    environmentDependent,
    notEvaluated,
    stale,
  };
}

/** Prints the short summary the task asks for, and appends it to $GITHUB_STEP_SUMMARY if set. */
export function printSummary(suiteName, diff) {
  const lines = [];
  lines.push(`### ${suiteName}`);
  lines.push('');
  lines.push(
    `passed: ${diff.passed.length}, expected failures: ${diff.expectedFail.length}, ` +
      `new failures: ${diff.newFailures.length}, fixed (remove from list): ${diff.fixed.length}, ` +
      `not evaluated: ${diff.notEvaluated.length}, environment-dependent: ${diff.environmentDependent.length}` +
      (diff.stale.length ? `, stale entries: ${diff.stale.length}` : ''),
  );
  if (diff.notEvaluated.length) {
    lines.push('');
    lines.push(
      'NOT EVALUATED (the chunk running these never produced a result - hung, or the ' +
        'per-strategy deadline was reached first; pass/fail is unknown, not "expected"):',
    );
    for (const r of diff.notEvaluated) lines.push(`  - ${r.fullName}`);
  }
  if (diff.newFailures.length) {
    lines.push('');
    lines.push('New failures (not in expected-failures.json):');
    for (const r of diff.newFailures) {
      lines.push(`  - ${r.fullName}`);
      if (r.failureMessage) lines.push(`      ${r.failureMessage}`);
    }
  }
  if (diff.fixed.length) {
    lines.push('');
    lines.push('Now passing (remove from expected-failures.json):');
    for (const r of diff.fixed) lines.push(`  - ${r.fullName}`);
  }
  if (diff.stale.length) {
    lines.push('');
    lines.push('In expected-failures.json but not seen this run (stale entry):');
    for (const name of diff.stale) lines.push(`  - ${name}`);
  }
  const text = lines.join('\n');
  console.log(`\n${text}\n`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`, { flag: 'a' });
    } catch {
      // Non-fatal: CI still gets the console output above.
    }
  }
}

export function isSuiteFailing(diff) {
  return (
    diff.newFailures.length > 0 ||
    diff.fixed.length > 0 ||
    diff.stale.length > 0 ||
    diff.notEvaluated.length > 0
  );
}

/** Thin wrapper around spawnSync that always inherits stdio and returns the exit status. */
export function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
