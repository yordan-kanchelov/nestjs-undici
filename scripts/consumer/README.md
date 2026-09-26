# Consumer checks

Tests the published package the way a consumer gets it: from the packed tarball, installed next to only its declared peers. The unit and e2e tests run against `src/` with the repo's devDependencies, so they can't catch packaging bugs such as a missing peer dependency (0.6.0 required `@nestjs/core` without declaring it). The [Package workflow](../../.github/workflows/package.yml) runs these on pull requests that touch the package, and weekly.

| Script | What it checks |
| --- | --- |
| `check-declared-deps.cjs` | Every bare import in `lib/`, at runtime (`.js`) and in the declarations (`.d.ts`), is a `dependency` or `peerDependency`. Node builtins are allowed. |
| `run-matrix.mjs` | For each supported NestJS/`undici` combination (including the lowest version of every peer range), creates a fresh project, runs `npm install` with the tarball and only the declared peers (no lockfile, no `--legacy-peer-deps`), then runs a Nest app through a CommonJS (`fixtures/smoke.cjs`) and an ESM (`fixtures/smoke.mjs`) entry point. Combinations a peer doesn't support on the current Node version (`undici` 8 needs 22.19+) are skipped. |
| `check-types.mjs` | Compiles `fixtures/consumer-types.ts` as `.cts` and `.mts` with `module: nodenext`, `strict` and `skipLibCheck: false`, against NestJS 10 and 12, with the repo's TypeScript and `typescript@latest`. |

The app in `fixtures/scenario.cjs` covers `register()` and `registerAsync()` with DI, function and class interceptors, `axiosRef` interceptors, redirects, cookies, errors (`AxiosError`, `isAxiosError`) and rxjs `Observable` identity against a local HTTP server.

The scripts shell out to `tar` to read the tarball.

## Running locally

```bash
npm run build
node scripts/consumer/check-declared-deps.cjs       # the built package in the repo
node scripts/consumer/check-declared-deps.cjs x.tgz # or a tarball

node scripts/consumer/run-matrix.mjs                # packs the repo first
node scripts/consumer/run-matrix.mjs --tarball x.tgz --only nest12-undici8
node scripts/consumer/run-matrix.mjs --node ~/node-22.17.0/bin/node --node "$(which node)"
node scripts/consumer/check-types.mjs --tarball x.tgz
```

`--node` runs the scenarios with other Node binaries too (the installs use the current one). Projects are created under `$TMPDIR/nestjs-axios-undici-consumer` (`--work` to change it); `matrix/results.json` there has the versions and timings of the last run.

The installed peers are read from the tarball's `peerDependencies`, and the versions for each one come from `packageWithPeers()` in `shared.mjs`, which fails on a peer it doesn't know. When a peer is added or a range changes, update it and the combinations in `run-matrix.mjs` and `check-types.mjs`, and the "Supported versions" table in the main README.
