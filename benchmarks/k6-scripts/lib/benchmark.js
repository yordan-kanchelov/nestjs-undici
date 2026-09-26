import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Services under test: one shared app (benchmarks/apps/nestjs-app) built per
// CLIENT/PLATFORM/INTERCEPTOR, plus the raw-undici floor (apps/undici-raw).
// `port` is the offset from the Node version's port base
// (Node 22: 3010, Node 24: 3020, Node 26: 3030).
export const SERVICES = [
  { key: 'express_axios', label: 'Express + @nestjs/axios', exec: 'testExpressAxios', port: 2, tag: 'express-axios', startTime: '0s' },
  { key: 'express_undici', label: 'Express + nestjs-axios-undici', exec: 'testExpressUndici', port: 3, tag: 'express-undici', startTime: '1m15s' },
  { key: 'fastify_axios', label: 'Fastify + @nestjs/axios', exec: 'testFastifyAxios', port: 4, tag: 'fastify-axios', startTime: '2m30s' },
  { key: 'fastify_undici', label: 'Fastify + nestjs-axios-undici', exec: 'testFastifyUndici', port: 5, tag: 'fastify-undici', startTime: '3m45s' },
  { key: 'express_axios_interceptor', label: 'Express + @nestjs/axios + interceptor', exec: 'testExpressAxiosInterceptor', port: 6, tag: 'express-axios-interceptor', startTime: '5m00s' },
  { key: 'express_undici_interceptor', label: 'Express + nestjs-axios-undici + interceptor', exec: 'testExpressUndiciInterceptor', port: 7, tag: 'express-undici-interceptor', startTime: '6m15s' },
  { key: 'undici_raw', label: 'Raw undici (floor)', exec: 'testUndiciRaw', port: 8, tag: 'undici-raw', startTime: '7m30s' },
];

const STAGES = [
  { duration: '10s', target: 50 }, // Ramp up
  { duration: '20s', target: 50 }, // Stay at 50 users
  { duration: '10s', target: 100 }, // Ramp to 100
  { duration: '20s', target: 100 }, // Stay at 100 users
  { duration: '10s', target: 0 }, // Ramp down
];
const SCENARIO_DURATION_SECONDS = 70;

/**
 * Builds the k6 options, per-service test functions and summary handler for
 * one Node.js version. Must be called from the init context of the entry script.
 */
export function createBenchmark({ nodeVersion, portBase }) {
  const metrics = {};
  const tests = {};
  const scenarios = {};

  // Run the services in a shuffled order each time, so neither client is
  // always measured first (or last) on a warming or throttling machine.
  const order = SERVICES.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const slot = {};
  order.forEach((service, i) => {
    slot[service.key] = SERVICES[i].startTime;
  });

  for (const service of SERVICES) {
    const m = {
      duration: new Trend(`${service.key}_duration`, true),
      errors: new Rate(`${service.key}_errors`),
      requests: new Counter(`${service.key}_requests`),
    };
    metrics[service.key] = m;

    const url = `http://localhost:${portBase + service.port}/api`;
    const tag = nodeVersion === 20 ? service.tag : `${service.tag}-node${nodeVersion}`;

    tests[service.exec] = function () {
      const res = http.get(url, { tags: { service: tag } });
      const success = check(res, {
        'status is 200': (r) => r.status === 200,
        'has data': (r) => {
          try {
            const data = JSON.parse(r.body).data;
            // Every upstream response must be present and parsed.
            return Array.isArray(data) && data.length === 5 && data.every((d) => d && d.id !== undefined);
          } catch (e) {
            return false;
          }
        },
      });

      m.duration.add(res.timings.duration);
      m.errors.add(!success);
      m.requests.add(1);
    };

    scenarios[service.key] = {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: STAGES,
      exec: service.exec,
      startTime: slot[service.key],
    };
  }

  const options = {
    scenarios,
    // k6 omits p(99) from trend summaries unless requested explicitly.
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<1000'],
      http_req_failed: ['rate<0.1'],
    },
  };

  function handleSummary(data) {
    return buildSummary(data, nodeVersion);
  }

  return { options, tests, handleSummary };
}

function getMetrics(data, key) {
  const duration = data.metrics[`${key}_duration`];
  const errors = data.metrics[`${key}_errors`];
  const requests = data.metrics[`${key}_requests`];
  if (!duration) return {};

  const requestCount = requests ? requests.values.count : 0;
  return {
    requests: requestCount,
    duration_avg: duration.values.avg,
    duration_med: duration.values.med,
    duration_p95: duration.values['p(95)'],
    duration_p99: duration.values['p(99)'],
    duration_min: duration.values.min,
    duration_max: duration.values.max,
    error_rate: errors ? errors.values.rate : 0,
    rps: requestCount / SCENARIO_DURATION_SECONDS,
  };
}

// Lower-is-better improvement of `improved` over `baseline`, in percent.
function calcImprovement(baseline, improved) {
  if (!baseline || !improved) return 'N/A';
  return (((baseline - improved) / baseline) * 100).toFixed(2);
}

// Higher-is-better throughput change of `improved` over `baseline`, in percent.
function calcThroughputImprovement(baseline, improved) {
  if (!baseline || !improved) return 'N/A';
  return (((improved - baseline) / baseline) * 100).toFixed(2);
}

function getWinner(results, keys, field, lowerIsBetter) {
  const candidates = keys
    .map((key) => ({ key, value: results[key][field] }))
    .filter((c) => typeof c.value === 'number');
  if (candidates.length === 0) return 'N/A';
  const best = candidates.reduce((a, b) => ((lowerIsBetter ? b.value < a.value : b.value > a.value) ? b : a));
  return SERVICES.find((s) => s.key === best.key).label;
}

function comparison(results, baselineKey, candidateKey) {
  const baseline = results[baselineKey];
  const candidate = results[candidateKey];
  return {
    throughput_improvement: calcThroughputImprovement(baseline.rps, candidate.rps) + '%',
    avg_response_improvement: calcImprovement(baseline.duration_avg, candidate.duration_avg) + '%',
    p95_response_improvement: calcImprovement(baseline.duration_p95, candidate.duration_p95) + '%',
    p99_response_improvement: calcImprovement(baseline.duration_p99, candidate.duration_p99) + '%',
  };
}

function interceptorOverhead(results, key) {
  const base = results[key];
  const withInterceptor = results[`${key}_interceptor`];
  return {
    throughput_impact: calcThroughputImprovement(base.rps, withInterceptor.rps) + '%',
    avg_response_impact: calcImprovement(withInterceptor.duration_avg, base.duration_avg) + '%',
  };
}

function buildSummary(data, nodeVersion) {
  const results = {};
  for (const service of SERVICES) results[service.key] = getMetrics(data, service.key);

  const plain = SERVICES.filter((s) => !s.key.endsWith('_interceptor')).map((s) => s.key);
  const intercepted = SERVICES.filter((s) => s.key.endsWith('_interceptor')).map((s) => s.key);
  const fixed = (v, d = 2) => (v || 0).toFixed(d);

  const rows = [
    ['Total Requests', 'requests', (v) => String(v || 0), null],
    ['Throughput (req/s)', 'rps', fixed, false],
    ['Avg Response Time (ms)', 'duration_avg', fixed, true],
    ['Median Response Time (ms)', 'duration_med', fixed, true],
    ['P95 Response Time (ms)', 'duration_p95', fixed, true],
    ['P99 Response Time (ms)', 'duration_p99', fixed, true],
    ['Min Response Time (ms)', 'duration_min', fixed, null],
    ['Max Response Time (ms)', 'duration_max', fixed, true],
    ['Error Rate (%)', 'error_rate', (v) => ((v || 0) * 100).toFixed(2), true],
  ];

  const csv = [
    ['Metric', ...SERVICES.map((s) => s.label), 'Winner (No Interceptor)', 'Winner (With Interceptor)'].join(','),
    ...rows.map(([label, field, format, lowerIsBetter]) =>
      [
        label,
        ...SERVICES.map((s) => format(results[s.key][field])),
        lowerIsBetter === null ? '' : getWinner(results, plain, field, lowerIsBetter),
        lowerIsBetter === null ? '' : getWinner(results, intercepted, field, lowerIsBetter),
      ].join(',')
    ),
  ].join('\n');

  const summary = {
    test_info: {
      node_version: `Node.js ${nodeVersion}`,
      timestamp: new Date().toISOString(),
      duration_seconds: Math.round((data.state.testRunDurationMs || 0) / 1000),
      scenarios: SERVICES.map((s) => s.key),
      max_vus: 100,
      // Where and against what the run happened; set by CI / the runner script.
      environment: __ENV.BENCHMARK_ENVIRONMENT || 'unspecified',
      library_ref: __ENV.LIBRARY_REF || 'unspecified',
    },
    results,
    comparison: {
      // The two primary pairs: same framework, only the HTTP client changes.
      express_undici_vs_express_axios: comparison(results, 'express_axios', 'express_undici'),
      fastify_undici_vs_fastify_axios: comparison(results, 'fastify_axios', 'fastify_undici'),
      // Adapter cost: nestjs-axios-undici's HttpService against raw undici.
      express_undici_vs_undici_raw: comparison(results, 'undici_raw', 'express_undici'),
      interceptor_overhead: {
        express_axios: interceptorOverhead(results, 'express_axios'),
        express_undici: interceptorOverhead(results, 'express_undici'),
      },
    },
  };

  return {
    [`results/node${nodeVersion}-performance-comparison.csv`]: csv,
    [`results/node${nodeVersion}-performance-summary.json`]: JSON.stringify(summary, null, 2),
    stdout: renderTable(nodeVersion, results),
  };
}

// Plain-text results table for the console (no remote jslib dependency).
function renderTable(nodeVersion, results) {
  const header = ['Configuration', 'Requests', 'RPS', 'Avg ms', 'Med ms', 'P95 ms', 'P99 ms', 'Errors %'];
  const body = SERVICES.map((s) => {
    const r = results[s.key];
    return [
      s.label,
      String(r.requests || 0),
      (r.rps || 0).toFixed(1),
      (r.duration_avg || 0).toFixed(2),
      (r.duration_med || 0).toFixed(2),
      (r.duration_p95 || 0).toFixed(2),
      (r.duration_p99 || 0).toFixed(2),
      ((r.error_rate || 0) * 100).toFixed(2),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');
  return [
    '',
    `NestJS HTTP benchmark - Node.js ${nodeVersion}`,
    line(header),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...body.map(line),
    '',
  ].join('\n');
}
