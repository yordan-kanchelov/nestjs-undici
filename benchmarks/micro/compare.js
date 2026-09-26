#!/usr/bin/env node
// Compares HttpService client CPU time per request of two library builds.
// Usage: node compare.js --base <libDir> --head <libDir> [--rounds 5] [--duration 3] [--threshold 10]
//
// Why CPU time and not throughput: req/s also captures how busy the runner's scheduler is, which is
// noisy enough on shared CI hardware that two builds of the *same* code can differ by 10%+. Client CPU
// time per request (process.cpuUsage() / requests) is far steadier, and dividing it by a raw-undici
// measurement taken in the same round cancels out runner speed entirely. See plan/reports/performance.md.
//
// Base and head are measured alternately, in fresh processes, across --rounds rounds, and the check
// fails only on the median paired ratio (head/base, computed per round then take the median) exceeding
// --threshold percent. A failing scenario is re-measured and judged on the pooled rounds before the job fails, since a
// single round can still get unlucky.
//
// Also prints, as information only (not part of the pass/fail decision): rps change, the overhead ratio
// against raw undici (base -> head), and head's ratio against @nestjs/axios (the headline "x faster"
// numbers used elsewhere in the docs).
const { fork, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), [])
);
const rounds = Number(args.rounds || 5);
const duration = String(args.duration || 3);
const threshold = Number(args.threshold || 10);
// The interceptors scenario is the noisiest (up to ~9.5% drift between identical builds in local
// runs), so it gets 1.5x the threshold instead of flaking the check on noise alone.
const thresholdFor = (sc) => (sc === 'interceptors' ? threshold * 1.5 : threshold);
const concurrency = String(args.concurrency || 50);
const warmup = String(args.warmup || 500);
const scenarios = (args.scenarios || 'get,post,config,error,interceptors').split(',');
const builds = { base: path.resolve(args.base), head: path.resolve(args.head) };

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const pctChange = (head, base) => ((head - base) / base) * 100;

let url;
function measure(impl, lib, scenario) {
  const out = execFileSync(
    process.execPath,
    [
      path.join(__dirname, 'client.js'),
      '--impl',
      impl,
      '--lib',
      lib,
      '--url',
      url,
      '--scenario',
      scenario,
      '--duration',
      duration,
      '--concurrency',
      concurrency,
      '--warmup',
      warmup,
    ],
    { encoding: 'utf8' }
  );
  const result = JSON.parse(out.trim().split('\n').pop());
  if (result.errors > 0) throw new Error(`${impl}:${scenario} on ${lib}: ${result.errors} failed requests`);
  return result;
}

// Measures `roundCount` rounds for the given scenarios. raw undici and the @nestjs/axios reference
// are measured once per round (always against the "get" scenario on the head build), not once per
// scenario, since they only exist to cancel out runner speed and don't depend on the scenario.
function measureRounds(scenarioList, roundCount) {
  const samples = {};
  for (const sc of scenarioList) samples[sc] = { base: [], head: [], raw: [], ref: [] };
  for (let round = 0; round < roundCount; round++) {
    const raw = measure('raw', builds.head, 'get');
    const ref = measure('nestaxios', builds.head, 'get');
    for (const sc of scenarioList) {
      // Alternate which build runs first each round so neither one always warms the runner for the other.
      const order = round % 2 ? ['head', 'base'] : ['base', 'head'];
      for (const name of order) samples[sc][name].push(measure('nau', builds[name], sc));
      samples[sc].raw.push(raw);
      samples[sc].ref.push(ref);
      const last = samples[sc];
      console.error(
        `round ${round + 1}/${roundCount} ${sc}: base ${last.base.at(-1).cpuUsPerReq.toFixed(1)}µs head ${last.head.at(-1).cpuUsPerReq.toFixed(1)}µs raw ${raw.cpuUsPerReq.toFixed(1)}µs`
      );
    }
  }
  return samples;
}

function verdicts(samples, scenarioList) {
  const result = {};
  for (const sc of scenarioList) {
    const l = samples[sc];
    // Per-round paired ratio of CPU/req (head/base), median across rounds. This is the statistic the
    // check gates on: it stays close to 0% even when absolute CPU/req swings with runner load, because
    // base and head are measured back to back in the same round.
    const pairedCpu = (median(l.head.map((x, i) => x.cpuUsPerReq / l.base[i].cpuUsPerReq)) - 1) * 100;
    const rpsChg = pctChange(median(l.head.map((x) => x.rps)), median(l.base.map((x) => x.rps)));
    const overheadBase = median(l.base.map((x, i) => x.cpuUsPerReq / l.raw[i].cpuUsPerReq));
    const overheadHead = median(l.head.map((x, i) => x.cpuUsPerReq / l.raw[i].cpuUsPerReq));
    const refCpu = median(l.ref.map((x, i) => x.cpuUsPerReq / l.head[i].cpuUsPerReq));
    const refRps = median(l.head.map((x, i) => x.rps / l.ref[i].rps));
    result[sc] = { pairedCpu, rpsChg, overheadBase, overheadHead, refCpu, refRps, failed: pairedCpu > thresholdFor(sc) };
  }
  return result;
}

async function main() {
  const server = fork(path.join(__dirname, 'server.js'));
  const { port } = await new Promise((resolve) => server.once('message', resolve));
  url = `http://127.0.0.1:${port}`;

  let result;
  const retried = new Set();
  try {
    const samples = measureRounds(scenarios, rounds);
    result = verdicts(samples, scenarios);
    const failing = scenarios.filter((sc) => result[sc].failed);
    if (failing.length) {
      // Measure the failing scenarios again and decide on the pooled rounds (one median over twice the
      // samples), rather than requiring two independent attempts to fail: that keeps a one-off noisy
      // round from failing the job without making a real, borderline regression easier to miss.
      console.error(`re-measuring before failing: ${failing.join(', ')}`);
      const extra = measureRounds(failing, rounds);
      for (const sc of failing) {
        for (const key of Object.keys(samples[sc])) samples[sc][key].push(...extra[sc][key]);
      }
      const pooled = verdicts(samples, failing);
      for (const sc of failing) {
        result[sc] = pooled[sc];
        retried.add(sc);
      }
    }
  } finally {
    server.disconnect();
  }

  const failed = scenarios.some((sc) => result[sc].failed);
  const rows = scenarios.map((sc) => {
    const r = result[sc];
    const name = retried.has(sc) ? `${sc} (re-run)` : sc;
    return `| ${name} | ${r.pairedCpu >= 0 ? '+' : ''}${r.pairedCpu.toFixed(1)}% | ${r.rpsChg >= 0 ? '+' : ''}${r.rpsChg.toFixed(1)}% | ${r.overheadBase.toFixed(2)}x → ${r.overheadHead.toFixed(2)}x | ${r.refRps.toFixed(1)}x rps, ${r.refCpu.toFixed(1)}x more CPU | ${r.failed ? '❌ regression' : '✅'} |`;
  });

  const markdown = [
    '## HttpService micro-benchmark',
    '',
    `Median client CPU time per request (\`process.cpuUsage()\`), paired against \`base\` in the same round, over ${rounds} alternating rounds of ${duration}s (${concurrency} concurrent requests, Node.js ${process.version}). Fails when head uses more than ${threshold}% more CPU/req than base (${thresholdFor('interceptors')}% for interceptors, the noisiest scenario); a failing scenario is re-measured and judged on the pooled rounds. rps change and the raw-undici / \`@nestjs/axios\` columns are informational.`,
    '',
    '| Scenario | CPU/req Δ (paired, median) | rps Δ (median) | CPU/req vs raw undici (base → head) | head vs @nestjs/axios (get) | Result |',
    '|----------|---------------------------:|----------------:|-------------------------------------:|-----------------------------:|--------|',
    ...rows,
    '',
  ].join('\n');

  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
  if (args.markdown) fs.writeFileSync(args.markdown, markdown);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ result, retried: [...retried] }, null, 1));
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
