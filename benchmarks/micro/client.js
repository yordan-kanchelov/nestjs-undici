#!/usr/bin/env node
// Runs one measurement: an implementation, against one scenario, for one library build.
// Usage: node client.js --impl nau|nestaxios|raw --lib <dir> --url <url> --scenario get|post|config|error|interceptors
//        [--duration 3] [--concurrency 50] [--warmup 1000]
// Prints one JSON line: { impl, scenario, rps, cpuUsPerReq, requests, errors, heapMB, rssMB }.
//
// cpuUsPerReq is process.cpuUsage() (user+system) divided by the request count during the
// measured window: client CPU time per request, independent of how busy the runner otherwise is.
require('reflect-metadata');
const path = require('node:path');
const { lastValueFrom } = require('rxjs');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), [])
);
const base = args.url.replace(/\/$/, '');
const durationMs = Number(args.duration || 3) * 1000;
const concurrency = Number(args.concurrency || 50);
const impl = args.impl;
const scenario = args.scenario;
const payload = { name: 'x', tags: ['a', 'b'], nested: { a: 1, b: 'two' } };
const passThrough = (request, next) => next.handle(request);

function build() {
  if (impl === 'raw') {
    // Reference floor: raw undici, no library code at all.
    const { request } = require(require.resolve('undici', { paths: [path.resolve(args.lib)] }));
    const ok = (status) => status >= 200 && status < 300;
    return async () => {
      const res = await request(base + '/json');
      const data = await res.body.json();
      if (!ok(res.statusCode)) throw new Error(`status ${res.statusCode}`);
      return { status: res.statusCode, data };
    };
  }

  let service;
  if (impl === 'nau') {
    const { HttpService } = require(path.resolve(args.lib));
    service = scenario === 'interceptors' ? new HttpService({}, { interceptors: [passThrough, passThrough] }) : new HttpService({});
  } else if (impl === 'nestaxios') {
    // Reference: @nestjs/axios, for the "x faster / x less CPU" numbers. Informational only.
    const { HttpService } = require(require.resolve('@nestjs/axios', { paths: [path.resolve(args.lib)] }));
    const axios = require(require.resolve('axios', { paths: [path.resolve(args.lib)] }));
    service = new HttpService(axios.create());
  } else {
    throw new Error(`unknown impl ${impl}`);
  }

  if (scenario === 'interceptors') {
    // Same user-visible work on both sides: one axios request interceptor and one axios response interceptor.
    service.axiosRef.interceptors.request.use((config) => {
      config.headers['x-trace'] = '1';
      return config;
    });
    service.axiosRef.interceptors.response.use((response) => response);
  }

  switch (scenario) {
    case 'get':
    case 'interceptors':
      return () => lastValueFrom(service.get(base + '/json'));
    case 'post':
      return () => lastValueFrom(service.post(base + '/echo', payload));
    case 'config':
      return () =>
        lastValueFrom(
          service.get(base + '/json', {
            params: { q: 'a b', page: 2 },
            headers: { 'x-a': '1', Authorization: 'Bearer t' },
            timeout: 5000,
          })
        );
    case 'error':
      return () =>
        lastValueFrom(service.get(base + '/404')).then(
          () => {
            throw new Error('expected a 404');
          },
          (error) => ({ status: 200, data: error.response.data })
        );
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

async function main() {
  const once = build();

  const warmupEnd = Date.now() + Number(args.warmup || 1000);
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Date.now() < warmupEnd) await once();
    })
  );
  global.gc?.();

  let requests = 0;
  let errors = 0;
  const cpuStart = process.cpuUsage();
  const start = process.hrtime.bigint();
  const end = Date.now() + durationMs;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Date.now() < end) {
        requests++;
        try {
          const res = await once();
          if (res.status !== 200 || res.data?.id !== 1) errors++;
        } catch (error) {
          errors++;
          if (process.env.DEBUG) console.error(error);
        }
      }
    })
  );
  const seconds = Number(process.hrtime.bigint() - start) / 1e9;
  const cpu = process.cpuUsage(cpuStart);
  global.gc?.();
  const mem = process.memoryUsage();

  console.log(
    JSON.stringify({
      impl,
      scenario,
      rps: requests / seconds,
      cpuUsPerReq: (cpu.user + cpu.system) / requests,
      requests,
      errors,
      heapMB: mem.heapUsed / 2 ** 20,
      rssMB: mem.rss / 2 ** 20,
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
