/**
 * The published package version, used for the default `User-Agent` request
 * header. `version.generated.ts` is a single constant written at build time
 * by `scripts/generate-version.js` (from `package.json`'s own `version`
 * field) - not a runtime `require('../package.json')` (plan.md phase 3
 * "src/version.ts"): a bundler that prunes non-JS files from its output, or
 * simply can't resolve a `require()` that reaches outside `lib/`, breaks
 * that (PR #16 review). The generator runs as `prebuild` (so `lib/version.js`
 * always ships the version being built) and as `pretest:jest`/`pretypecheck`
 * (so ts-jest and `tsc -p tsconfig.json`, which compile `src/` directly, see
 * one too) - see `package.json`'s scripts and `.gitignore` (the generated
 * file itself isn't committed).
 */
export { LIBRARY_VERSION } from './version.generated';
