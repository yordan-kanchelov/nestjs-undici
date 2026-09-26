#!/usr/bin/env node
// Consumer type check: installs the packed tarball into fresh projects and compiles
// fixtures/consumer-types.ts as both CommonJS (.cts) and ESM (.mts) with
// `module: nodenext`, strict mode and skipLibCheck off, so broken or unresolvable
// declarations in lib/ fail here the way they would in a consumer's build.
//
// Usage: node scripts/consumer/check-types.mjs [--tarball <file.tgz>] [--work <dir>]
// Each project is compiled with the repo's TypeScript version and with typescript@latest.
// rxjs is always the latest 7.x: older rxjs declarations don't compile under current
// TypeScript, which says nothing about this package.
import { spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
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
  repoRoot,
  resolveTarball,
} from './shared.mjs';

const PROJECTS = [
  { id: 'nest12-undici8', nest: '^12', undici: '^8' },
  { id: 'nest10-undici7', nest: '^10', undici: '^7' },
];

const { devDependencies } = readJson(join(repoRoot, 'package.json'));
const COMPILERS = [
  { name: 'typescript', range: devDependencies.typescript },
  { name: 'typescript-latest', range: 'npm:typescript@latest' },
];

const TSCONFIG = {
  compilerOptions: {
    target: 'es2022',
    module: 'nodenext',
    moduleResolution: 'nodenext',
    types: ['node'],
    strict: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    skipLibCheck: false,
    noEmit: true,
  },
  files: ['consumer-types.cts', 'consumer-types.mts'],
};

const { values } = parseArgs({
  options: {
    tarball: { type: 'string' },
    work: { type: 'string', default: defaultWorkDir },
  },
});
const tarball = resolveTarball(values.tarball, values.work);
console.log(`Tarball: ${tarball}\n`);

const results = await mapLimit(PROJECTS, PROJECTS.length, async project => {
  const dir = join(values.work, 'types', project.id);
  createProject(dir, `consumer-types-${project.id}`, {
    ...packageWithPeers(tarball, project),
    '@types/node': devDependencies['@types/node'],
    ...Object.fromEntries(COMPILERS.map(c => [c.name, c.range])),
  });
  for (const ext of ['cts', 'mts']) {
    copyFileSync(
      join(fixtures, 'consumer-types.ts'),
      join(dir, `consumer-types.${ext}`),
    );
  }
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2));
  try {
    await npmInstall(dir);
  } catch (error) {
    return [{ project, ok: false, output: error.message }];
  }
  return COMPILERS.map(compiler => {
    const pkgDir = join(dir, 'node_modules', compiler.name);
    const tsc = join(pkgDir, readJson(join(pkgDir, 'package.json')).bin.tsc);
    const run = spawnSync(process.execPath, [tsc, '-p', '.'], {
      cwd: dir,
      encoding: 'utf8',
    });
    return {
      project,
      label: `typescript@${installedVersion(dir, compiler.name)}, @nestjs/common@${installedVersion(dir, '@nestjs/common')}, undici@${installedVersion(dir, 'undici')}`,
      ok: run.status === 0,
      output: `${run.stdout}${run.stderr}`,
    };
  });
});

let failed = 0;
for (const { project, label, ok, output } of results.flat()) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${project.id} (${label ?? 'install'})`);
  if (!ok) {
    failed++;
    console.log(output.replace(/^/gm, '    '));
  }
}
process.exit(failed ? 1 : 0);
