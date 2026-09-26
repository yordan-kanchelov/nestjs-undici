/**
 * Injection token for this module's resolved undici/module options (see
 * `ResolvedUndiciRequestOptions`). Documented for test overrides in
 * `docs/guides/testing.md` - keep exporting it alongside `HTTP_MODULE_OPTIONS`
 * (plan.md phase 3 "Trim the public API").
 */
export const UNDICI_INSTANCE_TOKEN = 'UNDICI_INSTANCE_TOKEN';
/**
 * Injection token for the raw `HttpModuleOptions` passed to `register()`/
 * `registerAsync()`. Documented for test overrides in
 * `docs/guides/testing.md`.
 */
export const HTTP_MODULE_OPTIONS = 'HTTP_MODULE_OPTIONS';
