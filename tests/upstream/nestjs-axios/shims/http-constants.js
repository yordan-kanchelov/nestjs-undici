/* eslint-disable @typescript-eslint/no-require-imports --
 * see lib-index.js's shim in this same directory for why. */
// Stands in for @nestjs/axios's `../lib/http.constants.js`.
// HTTP_MODULE_ID and HTTP_MODULE_OPTIONS are the same string tokens in both
// packages, so those are passed through unchanged. AXIOS_INSTANCE_TOKEN has
// no real equivalent here: @nestjs/axios provides the *axios instance*
// (an object with `.defaults`) under that token, while this package's
// UNDICI_INSTANCE_TOKEN provides the raw undici dispatcher options, not an
// axios-like object. Aliasing it lets the DI graph resolve instead of
// throwing, but any assertion against `.defaults` on that token's value is
// expected to fail — tracked in expected-failures.json as a harness limitation.
const path = require('node:path');

const repoConstants = process.env.CONFORMANCE_REPO_CONSTANTS;
if (!repoConstants) {
  throw new Error(
    'http-constants shim: CONFORMANCE_REPO_CONSTANTS env var not set (run via run.mjs)',
  );
}

const built = require(path.resolve(repoConstants));

module.exports = {
  HTTP_MODULE_ID: built.HTTP_MODULE_ID,
  HTTP_MODULE_OPTIONS: built.HTTP_MODULE_OPTIONS,
  AXIOS_INSTANCE_TOKEN: built.UNDICI_INSTANCE_TOKEN,
};
