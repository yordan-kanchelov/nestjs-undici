#!/usr/bin/env node
// Consumer smoke matrix: installs the packed tarball into a fresh project per supported
// peer combination (with only the declared peers, like a consumer's `npm install`) and
// runs the same Nest app through a CommonJS and an ESM entry point.
//
// Usage: node scripts/consumer/run-matrix.mjs [--tarball <file.tgz>] [--only <id> ...]
//          [--node /path/to/node ...] [--work <dir>] [--jobs <n>]
// Without --tarball the repo is packed first. --node runs the scenarios with other Node
// binaries too (installs happen once, with the current Node).
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createProject,
  defaultWorkDir,
  fixtures,
  installedVersion,
  mapLimit,
  npmInstall,
  packageWithPeers,
  readJson,
  resolveTarball,
} from './shared.mjs';

// Supported combinations. The "min" row pins the lowest versions the peer ranges allow;
// the others take the latest release in each range.
const MATRIX = [
  {
    id: 'nest10-min',
    nest: '10.0.0',
    undici: '7.0.0',
    rxjs: '7.1.0',
    reflect: '0.1.13',
  },
  { id: 'nest10-undici8', nest: '^10', undici: '^8' },
  { id: 'nest11-undici7', nest: '^11', undici: '^7' },
  { id: 'nest11-undici8', nest: '^11', undici: '^8' },
  { id: 'nest12-undici7', nest: '^12', undici: '^7' },
  { id: 'nest12-undici8', nest: '^12', undici: '^8' },
];

const ENTRIES = ['smoke.cjs', 'smoke.mjs'];

const { values } = parseArgs({
  options: {
    tarball: { type: 'string' },
    work: { type: 'string', default: defaultWorkDir },
    only: { type: 'string', multiple: true },
    node: { type: 'string', multiple: true },
    jobs: { type: 'string', default: '3' },
  },
});

const combos = MATRIX.filter(c => !values.only || values.only.includes(c.id));
if (!combos.length) {
  console.error(`No combination matches --only ${values.only.join(', ')}`);
  process.exit(1);
}
const workDir = join(values.work, 'matrix');
mkdirSync(workDir, { recursive: true });
const tarball = resolveTarball(values.tarball, values.work);
const nodes = (values.node?.length ? values.node : [process.execPath]).map(
  bin => ({
    bin,
    version: execFileSync(bin, ['-v'], { encoding: 'utf8' }).trim(),
  }),
);
console.log(`Tarball: ${tarball}`);
console.log(`Node: ${nodes.map(n => n.version).join(', ')}\n`);

// Install all combinations in parallel (npm's cache is safe to share).
const installs = await mapLimit(combos, Number(values.jobs), async combo => {
  const dir = join(workDir, combo.id);
  const dependencies = packageWithPeers(tarball, combo);
  createProject(dir, `consumer-${combo.id}`, dependencies);
  for (const f of ['scenario.cjs', ...ENTRIES]) {
    copyFileSync(join(fixtures, f), join(dir, f));
  }
  const start = Date.now();
  try {
    await npmInstall(dir);
  } catch (error) {
    console.log(`FAIL ${combo.id}: install\n${error.message}`);
    return { combo, dir, error: error.message };
  }
  const peers = Object.keys(dependencies).slice(1);
  const versions = Object.fromEntries(
    peers.map(name => [name, installedVersion(dir, name)]),
  );
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `installed ${combo.id} in ${seconds}s: ${formatVersions(versions)}`,
  );
  return { combo, dir, versions, peers };
});
console.log();

const results = [];
for (const { combo, dir, versions, peers, error } of installs) {
  if (error) {
    results.push({ combo: combo.id, step: 'install', status: 'fail', error });
    continue;
  }
  for (const node of nodes) {
    // Skip where a peer itself does not support this Node (undici 8 needs >= 22.19)
    const unsupported = peers
      .map(name => [name, peerEngine(dir, name)])
      .find(([, range]) => range && !satisfies(node.version, range));
    for (const entry of ENTRIES) {
      const base = { combo: combo.id, node: node.version, entry, versions };
      if (unsupported) {
        const reason = `${unsupported[0]} requires node ${unsupported[1]}`;
        console.log(`SKIP ${combo.id} ${node.version} ${entry} (${reason})`);
        results.push({ ...base, status: 'skip', reason });
        continue;
      }
      const start = Date.now();
      const run = spawnSync(node.bin, [entry], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, NODE_NO_WARNINGS: '1', NODE_OPTIONS: '' },
      });
      const ms = Date.now() - start;
      const ok = run.status === 0;
      console.log(
        `${ok ? 'PASS' : 'FAIL'} ${combo.id} ${node.version} ${entry} (${ms}ms)`,
      );
      if (!ok) {
        const output = `${run.stdout}${run.stderr}${run.error ? run.error : ''}`;
        console.log(indent(output.split('\n').slice(0, 40).join('\n')));
      }
      results.push({ ...base, status: ok ? 'pass' : 'fail', ms });
    }
  }
}

writeFileSync(join(workDir, 'results.json'), JSON.stringify(results, null, 2));
const count = status => results.filter(r => r.status === status).length;
console.log(
  `\n${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`,
);
process.exit(count('fail') || !count('pass') ? 1 : 0);

function formatVersions(versions) {
  return Object.entries(versions)
    .map(([name, version]) => `${name}@${version}`)
    .join(' ');
}

function indent(text) {
  return text.replace(/^/gm, '    ');
}

function peerEngine(dir, name) {
  return readJson(join(dir, 'node_modules', name, 'package.json')).engines
    ?.node;
}

// Minimal engines check: `||` alternatives of space-separated <, <=, >, >=, = comparators.
// Anything fancier (^, ~, x-ranges) is treated as satisfied rather than guessed at.
function satisfies(version, range) {
  const v = parse(version);
  return range.split('||').some(alternative =>
    alternative
      .trim()
      .replace(/(<=|>=|<|>|=)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean)
      .every(comparator => {
        const m = /^(<=|>=|<|>|=)?v?(\d+(?:\.\d+){0,2})$/.exec(comparator);
        if (!m) return true;
        const cmp = compare(v, parse(m[2]));
        switch (m[1]) {
          case '>=':
            return cmp >= 0;
          case '>':
            return cmp > 0;
          case '<=':
            return cmp <= 0;
          case '<':
            return cmp < 0;
          default:
            return cmp === 0;
        }
      }),
  );
}

function parse(version) {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map(Number);
  return [major, minor, patch];
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
