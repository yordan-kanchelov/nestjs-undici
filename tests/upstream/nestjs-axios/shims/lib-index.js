/* eslint-disable @typescript-eslint/no-require-imports --
 * a plain CJS `module.exports`/`require()` shim, matching this repo's own
 * CommonJS module type; it's a Jest moduleNameMapper target, not a source
 * module, so it isn't written as TypeScript/ESM. */
// Stands in for @nestjs/axios's `../lib/index.js` (its built entry point).
// The generated jest.config.cjs (run.mjs) maps that specifier here via
// moduleNameMapper, so the copied @nestjs/axios spec files import THIS
// package's HttpModule/HttpService instead, unmodified otherwise.
// CONFORMANCE_REPO_LIB is injected by run.mjs (absolute path to this repo's
// built `lib/index.js`) so the shim works no matter where it's invoked from.
const path = require('node:path');

const repoLib = process.env.CONFORMANCE_REPO_LIB;
if (!repoLib) {
  throw new Error(
    'lib-index shim: CONFORMANCE_REPO_LIB env var not set (run via run.mjs)',
  );
}

const built = require(path.resolve(repoLib));

module.exports = {
  HttpModule: built.HttpModule,
  HttpService: built.HttpService,
};
