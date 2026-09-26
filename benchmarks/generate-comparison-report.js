const fs = require('fs');
const path = require('path');

// Builds the README headline (--headline <file>) and docs/benchmarks.md
// (--docs <file>) from every results/node<version>-performance-summary.json
// that exists. Both come from the same numbers, computed here once, so the
// headline and the page never drift apart.

const RESULTS_DIR = 'results';

// One shared app (benchmarks/apps/nestjs-app), parameterised by CLIENT
// (axios|undici), PLATFORM (express|fastify) and INTERCEPTOR - see
// k6-scripts/lib/benchmark.js SERVICES for the matching k6 config.
const CONFIGS = [
  { key: 'express_axios', label: 'Express + @nestjs/axios' },
  { key: 'express_undici', label: 'Express + nestjs-axios-undici' },
  { key: 'fastify_axios', label: 'Fastify + @nestjs/axios' },
  { key: 'fastify_undici', label: 'Fastify + nestjs-axios-undici' },
  { key: 'express_axios_interceptor', label: 'Express + @nestjs/axios + interceptor' },
  { key: 'express_undici_interceptor', label: 'Express + nestjs-axios-undici + interceptor' },
  { key: 'undici_raw', label: 'Raw undici (floor)' },
];
// Platform x interceptor pairs for the ratio table: same framework, only the
// HTTP client import changes between the two rows in each pair.
const PAIRS = [
  { platform: 'Express', axios: 'express_axios', undici: 'express_undici' },
  { platform: 'Fastify', axios: 'fastify_axios', undici: 'fastify_undici' },
  { platform: 'Express, with an interceptor', axios: 'express_axios_interceptor', undici: 'express_undici_interceptor' },
];
const labelOf = (key) => CONFIGS.find((c) => c.key === key)?.label ?? key;

function readJSONFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error.message);
    return null;
  }
}

function loadResults() {
  const files = fs.existsSync(RESULTS_DIR) ? fs.readdirSync(RESULTS_DIR) : [];
  return files
    .map((file) => file.match(/^node(\d+)-performance-summary\.json$/))
    .filter(Boolean)
    .map((match) => ({ version: Number(match[1]), data: readJSONFile(path.join(RESULTS_DIR, match[0])) }))
    .filter((entry) => entry.data?.results)
    .sort((a, b) => a.version - b.version);
}

const num = (value) => (typeof value === 'number' ? value : parseFloat(value));
const isNum = (value) => typeof value === 'number' && !Number.isNaN(value);
const formatNumber = (value, decimals = 2) => (isNum(num(value)) ? num(value).toFixed(decimals) : 'N/A');
const average = (values) => {
  const nums = values.map(num).filter(isNum);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN;
};
const range = (values, decimals = 1, suffix = '') => {
  const nums = values.map(num).filter(isNum);
  if (!nums.length) return 'N/A';
  const fmt = (v) => {
    const text = v.toFixed(decimals);
    return Number(text) === 0 ? (0).toFixed(decimals) : text; // avoid "-0"
  };
  const lo = fmt(Math.min(...nums));
  const hi = fmt(Math.max(...nums));
  if (lo === hi) return `${lo}${suffix}`;
  return `${lo}-${hi}${suffix}`;
};

function metric(entry, key, field) {
  return entry.data.results[key]?.[field];
}

// Throughput ratio of `undiciKey` over `axiosKey` in the same app, e.g. 2.1
// means nestjs-axios-undici served 2.1x the requests/s of @nestjs/axios.
function throughputRatio(entry, undiciKey, axiosKey) {
  const u = metric(entry, undiciKey, 'rps');
  const a = metric(entry, axiosKey, 'rps');
  return isNum(u) && isNum(a) && a > 0 ? u / a : NaN;
}

// How much lower `undiciKey`'s latency is than `axiosKey`'s, in percent
// (positive = undici is lower/better). Never "% faster".
function lowerPercent(entry, undiciKey, axiosKey, field) {
  const u = metric(entry, undiciKey, field);
  const a = metric(entry, axiosKey, field);
  return isNum(u) && isNum(a) && a > 0 ? ((a - u) / a) * 100 : NaN;
}

// Distinct test_info values across runs, e.g. the environment the results came from.
function describeInfo(runs, field) {
  const values = [...new Set(runs.map((r) => r.data.test_info?.[field]).filter((v) => v && v !== 'unspecified'))];
  return values.length ? values.join('; ') : 'not recorded';
}

function packageVersion(name) {
  try {
    return require(`${name}/package.json`).version;
  } catch {
    const pkg = readJSONFile('package.json') || {};
    return pkg.dependencies?.[name] ?? 'N/A';
  }
}

// ---------------------------------------------------------------------------
// The one-line headline, shared by the README and docs/benchmarks.md.

function buildHeadline(runs) {
  const versions = runs.map((r) => r.version).join(', ');
  const throughput = runs.flatMap((r) => PAIRS.filter((p) => !p.axios.endsWith('_interceptor')).map((p) => throughputRatio(r, p.undici, p.axios)));
  const p95 = runs.flatMap((r) => PAIRS.filter((p) => !p.axios.endsWith('_interceptor')).map((p) => lowerPercent(r, p.undici, p.axios, 'duration_p95')));
  // Results that didn't come from the full Docker + k6 run say so in the
  // headline itself, until the next full run replaces them.
  const local = runs.some((r) => /^Local run/i.test(r.data.test_info?.environment ?? ''));
  return (
    `In the same NestJS app, with only the import changed, **nestjs-axios-undici served ${range(throughput)}x the requests per second ` +
    `of @nestjs/axios, with ${range(p95, 0)}% lower p95 latency**, on Express and Fastify with Node.js ${versions}.` +
    (local ? ' These numbers are preliminary, from a short local run. The full Docker and k6 benchmark replaces them on the next release.' : '')
  );
}

function writeMarkers(filePath, name, content) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const text = fs.readFileSync(filePath, 'utf8');
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1) {
    console.error(`${filePath} is missing the ${name} markers; not updated`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(filePath, text.slice(0, from + start.length) + '\n' + content + '\n' + text.slice(to));
  console.log(`${filePath}: ${name} updated`);
}

// ---------------------------------------------------------------------------
// docs/benchmarks.md

const escapeXml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function niceStep(max, target = 5) {
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((step) => step >= raw);
}

const clientOf = (key) => (key === 'undici_raw' ? 'raw' : key.includes('undici') ? 'undici' : 'axios');

// Horizontal bars of one metric for one Node.js version, colored by HTTP client
// (undici blue, axios orange, the raw-undici floor grey). Always the light palette:
// the docs site is light-only, so a dark-mode override would put white text on a
// white page (see the "readable benchmark chart in dark mode" fix).
function barChart(run, { field, valueText, titleText, ariaLabel, valueWidth = 80 }) {
  const bars = CONFIGS.map((c) => ({
    key: c.key,
    label: c.label,
    value: metric(run, c.key, field),
    client: clientOf(c.key),
  })).filter((b) => isNum(b.value));
  const labelWidth = 260;
  const plotWidth = 400;
  const rowHeight = 30;
  const barHeight = 16;
  const top = 36;
  const width = labelWidth + plotWidth + valueWidth;
  const height = top + bars.length * rowHeight + 28;
  const step = niceStep(Math.max(...bars.map((b) => b.value)));
  const axisMax = Math.ceil(Math.max(...bars.map((b) => b.value)) / step) * step;
  const x = (v) => labelWidth + (v / axisMax) * plotWidth;

  const ticks = [];
  for (let v = 0; v <= axisMax + 1e-9; v += step) {
    ticks.push(
      `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${top - 6}" y2="${height - 24}"/>` +
        `<text class="tick" x="${x(v)}" y="${height - 8}" text-anchor="middle">${+v.toFixed(2)}</text>`
    );
  }
  const r = 4;
  const rows = bars.map((b, i) => {
    const y = top + i * rowHeight + (rowHeight - barHeight) / 2;
    const w = Math.max(x(b.value) - labelWidth, r);
    const x0 = labelWidth;
    const d = `M${x0},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${barHeight - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z`;
    return (
      `<g class="bar"><title>${escapeXml(titleText(b))}</title>` +
      `<rect x="0" y="${top + i * rowHeight}" width="${width}" height="${rowHeight}" fill="transparent"/>` +
      `<text class="label" x="${labelWidth - 10}" y="${y + barHeight / 2}" text-anchor="end" dominant-baseline="central">${escapeXml(b.label)}</text>` +
      `<path class="${b.client}" d="${d}"/>` +
      `<text class="value" x="${x(b.value) + 6}" y="${y + barHeight / 2}" dominant-baseline="central">${escapeXml(valueText(b))}</text></g>`
    );
  });
  const legend =
    `<g class="legend"><rect class="undici" x="${labelWidth}" y="6" width="12" height="12" rx="3"/>` +
    `<text class="label" x="${labelWidth + 18}" y="12" dominant-baseline="central">nestjs-axios-undici</text>` +
    `<rect class="axios" x="${labelWidth + 150}" y="6" width="12" height="12" rx="3"/>` +
    `<text class="label" x="${labelWidth + 168}" y="12" dominant-baseline="central">@nestjs/axios</text>` +
    `<rect class="raw" x="${labelWidth + 260}" y="6" width="12" height="12" rx="3"/>` +
    `<text class="label" x="${labelWidth + 278}" y="12" dominant-baseline="central">Raw undici</text></g>`;

  return [
    '<div style="overflow-x:auto">',
    `<svg class="bench-chart" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;min-width:620px" role="img" aria-label="${escapeXml(ariaLabel)}">`,
    '<style>',
    '.bench-chart{--ink:#0b0b0b;--ink-2:#52514e;--grid:#e4e3df;--undici:#2a78d6;--axios:#eb6834;--raw:#9a9890;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.bench-chart .label{fill:var(--ink)}.bench-chart .value,.bench-chart .tick{fill:var(--ink-2);font-variant-numeric:tabular-nums}',
    '.bench-chart .grid{stroke:var(--grid);stroke-width:1}.bench-chart .undici{fill:var(--undici)}.bench-chart .axios{fill:var(--axios)}.bench-chart .raw{fill:var(--raw)}',
    '.bench-chart .bar:hover path{opacity:.85}',
    '</style>',
    legend,
    ...ticks,
    ...rows,
    '</svg>',
    '</div>',
  ].join('');
}

function latencyChart(run) {
  return barChart(run, {
    field: 'duration_avg',
    valueText: (b) => `${formatNumber(b.value, 1)} ms`,
    titleText: (b) => `${b.label}: ${formatNumber(b.value)} ms average, ${formatNumber(metric(run, b.key, 'duration_p95'))} ms p95`,
    ariaLabel: `Average response time in milliseconds on Node.js ${run.version}, lower is better`,
  });
}

// Requests/s per configuration. Each nestjs-axios-undici bar also shows its
// multiple of the @nestjs/axios bar on the same platform (the PAIRS table), so
// the "Nx the requests" figure reads straight off the chart.
function throughputChart(run) {
  const rps = (v) => Math.round(v).toLocaleString('en-US');
  const ratioOf = (key) => {
    const pair = PAIRS.find((p) => p.undici === key);
    const ratio = pair ? throughputRatio(run, pair.undici, pair.axios) : NaN;
    return isNum(ratio) ? ratio : undefined;
  };
  return barChart(run, {
    field: 'rps',
    valueWidth: 150,
    valueText: (b) => {
      const ratio = ratioOf(b.key);
      return ratio === undefined ? `${rps(b.value)} req/s` : `${rps(b.value)} req/s (${ratio.toFixed(1)}x)`;
    },
    titleText: (b) => {
      const pair = PAIRS.find((p) => p.undici === b.key);
      const ratio = ratioOf(b.key);
      return ratio === undefined
        ? `${b.label}: ${rps(b.value)} requests/s`
        : `${b.label}: ${rps(b.value)} requests/s, ${ratio.toFixed(2)}x ${labelOf(pair.axios)}`;
    },
    ariaLabel: `Throughput in requests per second on Node.js ${run.version}, higher is better`,
  });
}

function ratioTable(runs) {
  const header = (cells) => `| ${cells.join(' | ')} |\n|${cells.map((_, i) => (i ? '---:' : '---')).join('|')}|`;
  const row = (cells) => `| ${cells.join(' | ')} |`;
  return [
    header(['Platform', 'Throughput', 'Avg latency', 'P95 latency']),
    ...PAIRS.map((p) =>
      row([
        p.platform,
        `${range(runs.map((r) => throughputRatio(r, p.undici, p.axios)))}x`,
        `${range(runs.map((r) => lowerPercent(r, p.undici, p.axios, 'duration_avg')), 0)}% lower`,
        `${range(runs.map((r) => lowerPercent(r, p.undici, p.axios, 'duration_p95')), 0)}% lower`,
      ])
    ),
  ].join('\n');
}

function resultsMatrix(runs, field, decimals, suffix) {
  const header = (cells) => `| ${cells.join(' | ')} |\n|${cells.map((_, i) => (i ? '---:' : '---')).join('|')}|`;
  const row = (cells) => `| ${cells.join(' | ')} |`;
  return [
    header(['Configuration', ...runs.map((r) => `Node ${r.version}`)]),
    ...CONFIGS.map((c) => row([c.label, ...runs.map((r) => `${formatNumber(metric(r, c.key, field), decimals)}${suffix}`)])),
  ].join('\n');
}

function buildDocsPage(runs) {
  const latest = runs[runs.length - 1];
  const versions = runs.map((r) => r.version).join(', ');
  const repo = 'https://github.com/yordan-kanchelov/nestjs-axios-undici';

  return [
    '# Benchmarks',
    '',
    `> Generated from [\`benchmarks/results\`](${repo}/tree/main/benchmarks/results) by \`benchmarks/generate-comparison-report.js --docs\`.`,
    '',
    buildHeadline(runs),
    '',
    '## Throughput and latency ratios',
    '',
    'Each row compares nestjs-axios-undici with `@nestjs/axios` in the same app on the same platform. Only the import changes. A throughput ratio above 1x means more requests per second.',
    '',
    ratioTable(runs),
    '',
    `## Throughput on Node.js ${latest.version}`,
    '',
    'Requests per second; higher is better. Each nestjs-axios-undici bar shows its multiple of `@nestjs/axios` on the same platform.',
    '',
    throughputChart(latest),
    '',
    `## Average response time on Node.js ${latest.version}`,
    '',
    'Lower is better. Hover a bar for its p95.',
    '',
    latencyChart(latest),
    '',
    "## What's measured",
    '',
    `- Each request to the app makes 5 parallel GET calls to a mock backend and returns the parsed bodies. For a given platform, only the \`HttpModule\`/\`HttpService\` import changes between the two rows. The app is [\`benchmarks/apps/nestjs-app\`](${repo}/tree/main/benchmarks/apps/nestjs-app).`,
    '- The "with an interceptor" rows add the same `axiosRef` request and response interceptor to both clients. It sets a header and times the call, and logs nothing per request.',
    `- [\`benchmarks/apps/undici-raw\`](${repo}/tree/main/benchmarks/apps/undici-raw) calls undici directly, with no \`HttpModule\`/\`HttpService\` at all, as a floor for the other rows.`,
    '',
    '## Full results',
    '',
    `Tested on Node.js ${versions}. The Environment section below says where these numbers come from.`,
    '',
    '### Average response time (ms)',
    '',
    resultsMatrix(runs, 'duration_avg', 2, ''),
    '',
    '### P95 response time (ms)',
    '',
    resultsMatrix(runs, 'duration_p95', 2, ''),
    '',
    '### Throughput (requests/s)',
    '',
    resultsMatrix(runs, 'rps', 0, ''),
    '',
    '## Environment',
    '',
    `- **Where**: ${describeInfo(runs, 'environment')}`,
    `- **Library build**: \`${describeInfo(runs, 'library_ref')}\``,
    `- **Packages**: nestjs-axios-undici ${packageVersion('nestjs-axios-undici')}, @nestjs/axios ${packageVersion('@nestjs/axios')}, axios ${packageVersion('axios')}, undici ${packageVersion('undici')}, @nestjs/core ${packageVersion('@nestjs/core')}`,
    `- **Runs**: ${[...new Set(runs.map((r) => r.data.test_info?.timestamp?.split('T')[0]).filter(Boolean))].join(', ') || 'N/A'}`,
    '',
    'Absolute latencies depend on the machine; compare configurations within a run.',
    '',
    '## Regression check',
    '',
    `Every pull request that touches \`src/\` runs an \`HttpService\` micro-benchmark against the base branch on the same runner and fails if client CPU per request rises by more than 10%. See [\`benchmarks/micro\`](${repo}/tree/main/benchmarks/micro). A lighter, no-Docker end-to-end check also runs on pull requests and publishes the throughput ratio; see [\`benchmarks/e2e\`](${repo}/tree/main/benchmarks/e2e).`,
    '',
    '## Reproduce',
    '',
    '```bash',
    'cd benchmarks',
    './scripts/pack-lib.sh          # build and pack the library from this checkout',
    'npm ci && npm run install-lib  # install benchmark deps + the packed library',
    './test-all-node-versions.sh    # Docker + k6 across Node.js 22, 24 and 26',
    'node generate-comparison-report.js --docs ../docs/benchmarks.md',
    'node generate-comparison-report.js --headline ../README.md   # root README',
    'node generate-comparison-report.js --headline README.md      # benchmarks/README.md',
    '```',
    '',
    `Or, without Docker or k6: \`npm run bench:ab\` (see [\`benchmarks/README.md\`](${repo}/tree/main/benchmarks/README.md)).`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------

const runs = loadResults();
if (runs.length === 0) {
  console.error(`No results/node<version>-performance-summary.json files found in ${RESULTS_DIR}/`);
  process.exit(1);
}

const docsIndex = process.argv.indexOf('--docs');
const headlineIndex = process.argv.indexOf('--headline');

if (docsIndex !== -1) {
  const target = process.argv[docsIndex + 1] || '../docs/benchmarks.md';
  fs.writeFileSync(target, buildDocsPage(runs));
  console.log(`Docs page written to ${target}`);
} else if (headlineIndex !== -1) {
  const target = process.argv[headlineIndex + 1] || 'README.md';
  writeMarkers(target, 'bench-headline', buildHeadline(runs));
} else {
  console.error('Usage: generate-comparison-report.js --docs [file] | --headline [file]');
  process.exit(1);
}
