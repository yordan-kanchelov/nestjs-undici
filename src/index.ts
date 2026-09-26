/**
 * The public API (plan.md phase 3 "Trim the public API"): every barrel below
 * re-exports an explicit, deliberate list of names - never `export *` - so
 * nothing reaches a consumer just because some internal file happens to
 * declare `export`. See `docs/migration-guide.md` ("Public API trim") for
 * what was removed and its replacement, if any.
 */
export { HttpModule } from './modules/http/http.module';
export * from './modules/http/interfaces';
export * from './modules/http/constants';
export * from './modules/http/services';
export * from './modules/http/errors';
export * from './modules/http/types';
