// Helpers shared by run-matrix.mjs and check-types.mjs.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../..');
export const fixtures = join(here, 'fixtures');
export const defaultWorkDir = join(tmpdir(), 'nestjs-axios-undici-consumer');

/** Returns the absolute path of the tarball to test, packing the repo if none was given. */
export function resolveTarball(tarball, workDir) {
  if (tarball) return resolve(tarball);
  mkdirSync(workDir, { recursive: true });
  console.log(`No --tarball given, packing ${repoRoot} ...`);
  const out = execFileSync(
    'npm',
    ['pack', '--silent', '--pack-destination', workDir],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return join(workDir, out.trim().split('\n').pop());
}

/**
 * The tarball itself plus its declared peers, and nothing else, at the versions a
 * combination asks for: { nest, undici, rxjs?, reflect? }. Throws on a *required* peer
 * the combinations don't know about, so a new one can't go untested.
 *
 * Optional peers (`peerDependenciesMeta[name].optional`, e.g. `http-cookie-agent` /
 * `tough-cookie` for the `cookieJar` option) are deliberately left out: every combination
 * here is meant to smoke-test the package the way a consumer who *hasn't* opted into that
 * feature gets it, which is also the case this matters most for - it's what proves the
 * package still loads and works without the optional peer installed.
 */
export function packageWithPeers(tarball, combo) {
  const manifest = JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
    }),
  );
  const optional = new Set(
    Object.entries(manifest.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional)
      .map(([name]) => name),
  );
  const versions = {
    '@nestjs/common': combo.nest,
    '@nestjs/core': combo.nest,
    undici: combo.undici,
    rxjs: combo.rxjs ?? '^7',
    'reflect-metadata': combo.reflect ?? '^0.2',
  };
  const dependencies = { [manifest.name]: `file:${tarball}` };
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
    if (optional.has(peer)) continue;
    if (!versions[peer]) {
      throw new Error(
        `peer ${peer} has no version in the consumer matrix (scripts/consumer)`,
      );
    }
    dependencies[peer] = versions[peer];
  }
  return dependencies;
}

/** Creates a fresh project directory with the given dependencies. */
export function createProject(dir, name, dependencies) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      { name, private: true, type: 'commonjs', dependencies },
      null,
      2,
    ),
  );
}

/**
 * Runs `npm install` like a consumer would: no lockfile, no --legacy-peer-deps, so a
 * peer range conflict fails the install. Resolves with the combined output.
 */
export function npmInstall(dir) {
  const args = [
    'install',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--loglevel=error',
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npm', args, { cwd: dir, env: npmEnv() });
    let output = '';
    child.stdout.on('data', d => (output += d));
    child.stderr.on('data', d => (output += d));
    child.on('error', reject);
    child.on('close', code =>
      code === 0
        ? resolvePromise(output)
        : reject(new Error(`npm install failed in ${dir}:\n${output}`)),
    );
  });
}

// Make sure a user or CI level setting can't hide peer conflicts.
function npmEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_(legacy_peer_deps|force)$/i.test(key)) delete env[key];
  }
  return env;
}

/** Runs async tasks with a concurrency limit, preserving order of results. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

export function installedVersion(dir, name) {
  const file = join(dir, 'node_modules', name, 'package.json');
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
