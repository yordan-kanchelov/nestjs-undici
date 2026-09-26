#!/usr/bin/env node
// A light end-to-end A/B check: no Docker, no k6. Starts the mock backend and
// the shared Express app (benchmarks/apps/nestjs-app) once per client, on the
// same runner, and drives load with the built-in generator in ./load.js.
// Rounds alternate axios/undici first so runner drift cancels out; the
// reported ratio is the median across rounds.
//
// Usage: node e2e/run.js [--rounds 3] [--duration 3] [--warmup 1] [--connections 20] [--interceptor]
'use strict';
const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { runLoad } = require('./load');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : pairs), [])
);
const rounds = Number(args.rounds || 3);
const durationMs = Number(args.duration || 3) * 1000;
const warmupMs = Number(args.warmup || 1) * 1000;
const connections = Number(args.connections || 20);
const interceptor = Boolean(args.interceptor);

const ROOT = path.resolve(__dirname, '..');
const UPSTREAM_PORT = 4500;
const APP_PORT = 4501;
const UPSTREAM_URL = `http://127.0.0.1:${UPSTREAM_PORT}/`;
const APP_URL = `http://127.0.0.1:${APP_PORT}/api`;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ready = (child) =>
  new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code) => reject(new Error(`exited with code ${code} before it became ready`)));
  });
const stop = (child) =>
  new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });

async function runApp(client) {
  const app = fork(path.join(ROOT, 'apps/nestjs-app/src/main.ts'), [], {
    cwd: ROOT,
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    env: {
      ...process.env,
      TS_NODE_PROJECT: path.join(ROOT, 'apps/nestjs-app/tsconfig.app.json'),
      CLIENT: client,
      PLATFORM: 'express',
      PORT: String(APP_PORT),
      MOCK_SERVICE_URL: UPSTREAM_URL,
      INTERCEPTOR: interceptor ? '1' : '0',
    },
    silent: true,
  });
  await ready(app);
  await runLoad(APP_URL, { connections, durationMs: warmupMs }); // warm up (JIT, connection pool)
  const result = await runLoad(APP_URL, { connections, durationMs });
  await stop(app);
  return result;
}

async function main() {
  const upstream = fork(path.join(__dirname, 'upstream.js'), [String(UPSTREAM_PORT)], { silent: true });
  await ready(upstream);

  const results = { axios: [], undici: [] };
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? ['undici', 'axios'] : ['axios', 'undici'];
    for (const client of order) {
      const result = await runApp(client);
      if (result.errors > 0) throw new Error(`${client}: ${result.errors} request(s) failed`);
      results[client].push(result);
      console.error(`round ${round + 1} ${client}: ${result.rps.toFixed(0)} req/s, p95 ${result.p95.toFixed(1)}ms`);
    }
  }
  await stop(upstream);

  const m = (client, field) => median(results[client].map((r) => r[field]));
  const throughputRatio = median(results.undici.map((r, i) => r.rps / results.axios[i].rps));
  const p95Ratio = median(results.axios.map((r, i) => r.p95 / results.undici[i].p95));

  const title = `## End-to-end A/B: nestjs-axios-undici vs @nestjs/axios${interceptor ? ' (with an interceptor)' : ''}`;
  const md = [
    title,
    '',
    `NestJS + Express, ${connections} connections, ${rounds} alternating rounds of ${durationMs / 1000}s (Node.js ${process.version}). No Docker, no k6 - see \`benchmarks/e2e/run.js\`.`,
    '',
    '| Client | req/s (median) | p50 ms | p95 ms |',
    '|---|--:|--:|--:|',
    `| @nestjs/axios | ${m('axios', 'rps').toFixed(0)} | ${m('axios', 'p50').toFixed(1)} | ${m('axios', 'p95').toFixed(1)} |`,
    `| nestjs-axios-undici | ${m('undici', 'rps').toFixed(0)} | ${m('undici', 'p50').toFixed(1)} | ${m('undici', 'p95').toFixed(1)} |`,
    '',
    `**Throughput ratio: ${throughputRatio.toFixed(2)}x. P95 latency ratio: ${p95Ratio.toFixed(2)}x lower.**`,
    '',
  ].join('\n');

  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  if (args.markdown) fs.writeFileSync(args.markdown, md);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ throughputRatio, p95Ratio, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
