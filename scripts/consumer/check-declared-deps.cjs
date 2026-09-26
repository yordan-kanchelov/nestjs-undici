#!/usr/bin/env node
'use strict';
// Fails when the built package imports a module a consumer won't have: every bare import
// in lib/, at runtime (.js) and in the type declarations (.d.ts), must be a dependency or
// a peerDependency. Node builtins are allowed, and so is `/// <reference types="node" />`.
// Catches bugs like 0.6.0 requiring @nestjs/core without declaring it.
//
// A runtime `require(...)` of an *optional* peer (`peerDependenciesMeta[name].optional`)
// is only a problem when it runs unconditionally as the module loads - i.e. it isn't
// nested inside a function/method body. That would crash `require()`ing this package for
// every consumer who hasn't installed the optional peer. A `require(...)` nested inside a
// function (loaded lazily, only when the feature that needs it is actually used - see
// `HttpService`'s `loadCookieAgent`) is fine and expected: that's the whole point of an
// optional peer. Runtime files are parsed with the full TypeScript AST for this reason;
// type (.d.ts) files have no such runtime-ordering concept and are still scanned with
// TypeScript's lightweight preprocessor.
//
// Usage: node scripts/consumer/check-declared-deps.cjs [<package dir> | <file.tgz>]
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { builtinModules } = require('node:module');
const ts = require('typescript');

const target = path.resolve(process.argv[2] || '.');
const root = fs.statSync(target).isDirectory() ? target : extract(target);
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const libDir = path.join(root, 'lib');
if (!fs.existsSync(libDir)) {
  console.error(`${libDir} does not exist, build the package first`);
  process.exit(1);
}

const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
]);
const optionalPeers = new Set(
  Object.entries(pkg.peerDependenciesMeta || {})
    .filter(([, meta]) => meta.optional)
    .map(([name]) => name),
);
const builtins = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
const isBuiltin = spec =>
  spec.startsWith('node:') ||
  builtins.has(spec) ||
  builtins.has(spec.split('/')[0]);

const problems = [];
const used = new Map(); // "name (kind)" -> Set of files
let scanned = 0;
for (const file of walk(libDir)) {
  const isTypes = /\.d\.[cm]?ts$/.test(file);
  if (!isTypes && !/\.[cm]?js$/.test(file)) continue;
  scanned++;
  const kind = isTypes ? 'type' : 'runtime';
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  const specs = isTypes ? typeSpecs(text) : runtimeSpecs(file, text);
  for (const { spec, topLevel } of specs) {
    if (spec.startsWith('.') || path.isAbsolute(spec) || isBuiltin(spec)) {
      continue;
    }
    const name = packageName(spec);
    const key = `${name} (${kind})`;
    used.set(key, (used.get(key) || new Set()).add(rel));
    if (name === pkg.name) continue;
    if (!declared.has(name)) {
      const hint = pkg.devDependencies?.[name] ? ' (only a devDependency)' : '';
      problems.push(
        `${kind} import '${spec}' in ${rel} is not a dependency or peerDependency${hint}`,
      );
    } else if (kind === 'runtime' && optionalPeers.has(name) && topLevel) {
      problems.push(
        `top-level runtime import of optional peer '${spec}' in ${rel} - load it lazily ` +
          `(require() nested inside a function, only called when the feature that needs ` +
          `it is used) so the package still loads without it installed`,
      );
    }
  }
}

console.log(`Bare imports in ${pkg.name}@${pkg.version} lib/:`);
for (const [key, files] of [...used].sort()) {
  console.log(`  ${key}: ${files.size} file(s)`);
}
for (const name of declared) {
  if (![...used.keys()].some(key => key.startsWith(`${name} `))) {
    console.log(`  note: ${name} is declared but never imported`);
  }
}
if (!scanned) {
  console.error(
    `No .js or .d.ts files found in ${libDir}; is the build complete?`,
  );
  process.exit(1);
}
if (problems.length) {
  console.error(
    `\nUndeclared imports:\n  ${[...new Set(problems)].join('\n  ')}`,
  );
  process.exit(1);
}
console.log('\nOK: every bare import is declared.');

/** `.d.ts` files: every referenced module, read with TypeScript's lightweight preprocessor. */
function typeSpecs(text) {
  const info = ts.preProcessFile(text, true, true);
  const specs = info.importedFiles.map(f => ({
    spec: f.fileName,
    topLevel: true,
  }));
  for (const ref of info.typeReferenceDirectives) {
    // `/// <reference types="node" />` means @types/node, which Node consumers have
    if (ref.fileName !== 'node')
      specs.push({ spec: ref.fileName, topLevel: true });
  }
  return specs;
}

/**
 * Runtime `.js` files: every `require('spec')` call and static `import ... from 'spec'`,
 * each tagged with whether it runs unconditionally as the module loads (`topLevel: true`)
 * or is nested inside a function/method body, so it only runs when that function is
 * actually called (`topLevel: false`) - see the file-level comment above. Parsed with the
 * full TypeScript AST (not the lightweight preprocessor above) because that distinction
 * needs real scope information.
 */
function runtimeSpecs(file, text) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );
  const isFunctionLike = node =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node);
  const isTopLevel = node => {
    for (let cur = node.parent; cur; cur = cur.parent) {
      if (isFunctionLike(cur)) return false;
    }
    return true;
  };

  const specs = [];
  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      // require('x'), import('x') and require.resolve('x')
      ((ts.isIdentifier(node.expression) &&
        node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'resolve' &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'require'))
    ) {
      specs.push({ spec: node.arguments[0].text, topLevel: isTopLevel(node) });
    } else if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      // `import`/`export ... from` can only appear at the top level of a module.
      specs.push({ spec: node.moduleSpecifier.text, topLevel: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function extract(tarball) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-deps-'));
  execFileSync('tar', ['-xzf', tarball, '-C', dir]);
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'package');
}
