# Benchmarks

<!-- bench-headline:start -->
In the same NestJS app, with only the import changed, **nestjs-axios-undici served 4.0-4.2x the requests per second of @nestjs/axios, with 77% lower p95 latency**, on Express and Fastify with Node.js 24. These numbers are preliminary, from a short local run. The full Docker and k6 benchmark replaces them on the next release.
<!-- bench-headline:end -->

Full results, the ratio table and the chart are on the [benchmarks page](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/benchmarks). This page is only about running the benchmarks yourself.

## Quick check: no Docker, no k6

```bash
cd benchmarks
npm ci
npm run bench:ab
```

Starts the mock backend and the shared Express app ([`e2e/run.js`](e2e/run.js)) as child processes, drives load with a small built-in undici-based generator, and prints the throughput ratio and p95 latency ratio. Takes under a minute. Add `--interceptor` to test with the shared `axiosRef` interceptor, or `--rounds`/`--duration`/`--connections` to change the load.

## Full benchmark: Docker + k6

```bash
cd benchmarks
./scripts/pack-lib.sh          # build and pack the library from this checkout
npm ci && npm run install-lib  # install benchmark deps + the packed library
./test-all-node-versions.sh    # Docker + k6 across Node.js 22, 24 and 26
```

Or drive one Node.js version by hand:

```bash
docker compose -f docker-compose-node24.yml up -d --build
k6 run k6-scripts/test-node24.js
docker compose -f docker-compose-node24.yml down
```

k6 ramps virtual users from 0 to 50 to 100 over 70 seconds per configuration, one configuration after another. Results land in `results/node<version>-performance-summary.json` (and a matching `.csv`).

## Apps

One shared source, [`apps/nestjs-app`](apps/nestjs-app), parameterised by three environment variables:

| Variable | Values | Picks |
|---|---|---|
| `CLIENT` | `axios` \| `undici` | `HttpModule`/`HttpService` from `@nestjs/axios` or `nestjs-axios-undici` |
| `PLATFORM` | `express` \| `fastify` | the Nest HTTP adapter |
| `INTERCEPTOR` | `0` \| `1` | adds the shared `axiosRef` request/response interceptor |

Every combination calls `httpService.get(url)` and returns `res.data`. The app source is identical; only the import changes (see [`apps/nestjs-app/src/app/client.ts`](apps/nestjs-app/src/app/client.ts)). [`apps/undici-raw`](apps/undici-raw) calls `undici.request()` directly, with no `HttpModule` at all, as a floor. [`apps/mock-service`](apps/mock-service) is the backend every app calls; it runs with `logger: false` so its own logging never caps the numbers.

## Ports

Host ports are `<portBase> + <offset>`; portBase is 3010 (Node 22), 3020 (Node 24), 3030 (Node 26). See the `docker-compose-node*.yml` files.

| Offset | Service |
|---:|---|
| 1 | mock-service |
| 2 | Express + `@nestjs/axios` |
| 3 | Express + `nestjs-axios-undici` |
| 4 | Fastify + `@nestjs/axios` |
| 5 | Fastify + `nestjs-axios-undici` |
| 6 | Express + `@nestjs/axios` + interceptor |
| 7 | Express + `nestjs-axios-undici` + interceptor |
| 8 | Raw undici (floor) |

## Generating the report

```bash
node generate-comparison-report.js --docs ../docs/benchmarks.md
node generate-comparison-report.js --headline ../README.md   # root README
node generate-comparison-report.js --headline README.md      # this file
```

Both `--headline` calls write the same one-line, ratio-based headline, computed once and shared by both files, between the `bench-headline` markers above. `--docs` writes the full benchmarks page: ratio table, chart, full results, environment and how to reproduce. See [`generate-comparison-report.js`](generate-comparison-report.js).

## Regression check

Every pull request that touches `src/` also runs `micro/compare.js`, a client-CPU-per-request check against the base branch; see [`micro/`](micro).
