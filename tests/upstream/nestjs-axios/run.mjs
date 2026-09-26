#!/usr/bin/env node
// Upstream conformance suite: @nestjs/axios's own behavioural specs
// (tests/http.service.spec.ts, tests/http.module.spec.ts), run unmodified
// against this package's HttpModule/HttpService.
//
// Usage: node tests/upstream/nestjs-axios/run.mjs [--ref 12.0.1] [--keep]
//          [--clone-dir DIR] [--skip-build]
//
// Clones nestjs/axios at the pinned tag (matching the installed
// @nestjs/axios devDependency - bump both together), copies its
// transferable-as-is specs into a scratch working dir, points their
// `../lib/index.js` / `../lib/http.constants.js` imports at this repo's
// built HttpModule/HttpService via jest `moduleNameMapper` (see shims/),
// and runs them with this repo's own Jest + ts-jest.
//
// tests/esm.spec.ts is intentionally NOT copied: it only checks @nestjs/
// axios's own dist/package.json packaging contract, not shared behaviour
// (see plan/reports/upstream-test-suites.md).
import { mkdirSync, rmSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  REPO_ROOT,
  buildLib,
  ensureClone,
  defaultCloneDir,
  loadExpectedFailures,
  readJsonReport,
  diffResults,
  printSummary,
  isSuiteFailing,
  run,
} from '../lib/conformance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export async function main(argv = process.argv.slice(2)) {
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? def : argv[i + 1];
  };
  const REF = flag('ref', '12.0.1');
  const KEEP = argv.includes('--keep');
  const SKIP_BUILD = argv.includes('--skip-build');
  const CLONE_DIR =
    flag('clone-dir', null) ?? defaultCloneDir(`nestjs-axios-${REF}`);
  const WORK_DIR = path.join(HERE, `.run-${process.pid}`);
  const RESULTS_FILE = path.join(WORK_DIR, 'results.json');

  console.log("[nestjs-axios] [1/5] building this repo's lib/ ...");
  if (!SKIP_BUILD) buildLib();

  console.log(`[nestjs-axios] [2/5] cloning nestjs/axios @ ${REF} ...`);
  ensureClone({
    url: 'https://github.com/nestjs/axios.git',
    ref: REF,
    dir: CLONE_DIR,
  });

  console.log(
    `[nestjs-axios] [3/5] copying transferable specs into ${WORK_DIR} ...`,
  );
  mkdirSync(path.join(WORK_DIR, 'tests'), { recursive: true });
  const SPECS = ['tests/http.service.spec.ts', 'tests/http.module.spec.ts'];
  for (const spec of SPECS) {
    cpSync(path.join(CLONE_DIR, spec), path.join(WORK_DIR, spec));
  }

  console.log('[nestjs-axios] [4/5] writing jest config ...');
  const configPath = path.join(WORK_DIR, 'jest.config.cjs');
  const tsJestPath = require.resolve('ts-jest', { paths: [REPO_ROOT] });
  const SHIMS = path.join(HERE, 'shims');
  writeFileSync(
    configPath,
    `module.exports = {
  rootDir: ${JSON.stringify(WORK_DIR)},
  transform: { '^.+\\\\.ts$': ${JSON.stringify(tsJestPath)} },
  testEnvironment: 'node',
  testRegex: '\\\\.spec\\\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  testTimeout: 15000,
  moduleNameMapper: {
    '^vitest$': ${JSON.stringify(path.join(SHIMS, 'vitest.js'))},
    '^\\\\.\\\\./lib/index\\\\.js$': ${JSON.stringify(path.join(SHIMS, 'lib-index.js'))},
    '^\\\\.\\\\./lib/http\\\\.constants\\\\.js$': ${JSON.stringify(path.join(SHIMS, 'http-constants.js'))},
  },
};
`,
  );

  console.log('[nestjs-axios] [5/5] running jest ...\n');
  // Nest 12 / @nestjs/testing are ESM-only; Jest's CJS `require(esm)` support
  // needs Node >=24.9 plus this flag (see plan/reports/automation.md item 1).
  const jestBin = path.join(
    REPO_ROOT,
    'node_modules',
    'jest',
    'bin',
    'jest.js',
  );
  const status = run(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--disable-warning=ExperimentalWarning',
      jestBin,
      '--config',
      configPath,
      '--runInBand',
      '--json',
      `--outputFile=${RESULTS_FILE}`,
    ],
    {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        CONFORMANCE_REPO_LIB: path.join(REPO_ROOT, 'lib', 'index.js'),
        CONFORMANCE_REPO_CONSTANTS: path.join(
          REPO_ROOT,
          'lib',
          'modules',
          'http',
          'constants',
          'http.constants.js',
        ),
      },
    },
  );
  void status; // jest's own exit code reflects failing tests, which we diff below instead.

  const expectedFailuresFile = path.join(HERE, 'expected-failures.json');
  const expected = loadExpectedFailures(expectedFailuresFile);
  const results = existsSync(RESULTS_FILE) ? readJsonReport(RESULTS_FILE) : [];
  const diff = diffResults(results, expected);
  printSummary(
    '@nestjs/axios specs (against our HttpModule/HttpService)',
    diff,
  );

  if (!KEEP) {
    rmSync(WORK_DIR, { recursive: true, force: true });
  }

  return isSuiteFailing(diff) ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => process.exit(code));
}
