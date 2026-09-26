// A small built-in load generator: N concurrent connections hammer a URL with
// keep-alive undici requests for a fixed duration, recording every request's
// latency. autocannon isn't a dependency of this package (see plan/reports/
// performance.md), so this uses the undici the benchmarks already depend on.
'use strict';
const { request, Agent } = require('undici');

/**
 * @param {string} url
 * @param {{ connections?: number, durationMs?: number }} [opts]
 * @returns {Promise<{ requests: number, errors: number, rps: number, p50: number, p95: number, p99: number }>}
 */
async function runLoad(url, { connections = 20, durationMs = 3000 } = {}) {
  const agent = new Agent({ connections });
  const latencies = [];
  let errors = 0;
  const deadline = Date.now() + durationMs;

  async function worker() {
    while (Date.now() < deadline) {
      const start = performance.now();
      try {
        const res = await request(url, { dispatcher: agent });
        await res.body.dump(); // drain, keep the connection reusable
        if (res.statusCode >= 400) errors++;
      } catch {
        errors++;
      }
      latencies.push(performance.now() - start);
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: connections }, worker));
  const elapsedMs = Date.now() - started;
  await agent.close();

  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))] ?? 0;
  const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  return {
    requests: latencies.length,
    errors,
    rps: latencies.length / (elapsedMs / 1000),
    avg,
    min: latencies[0] ?? 0,
    max: latencies[latencies.length - 1] ?? 0,
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
  };
}

module.exports = { runLoad };
