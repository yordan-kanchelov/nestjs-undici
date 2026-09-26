import type { ResolvedAgentOptions } from '../adapters/axios-config.adapter';
import type { HttpModuleOptions, UndiciRequestOptionsType } from '../types';

/**
 * The transport pieces `mapAxiosConfigToUndici` resolves once, at module
 * setup time, from axios-only options (`httpAgent`/`httpsAgent`/`httpVersion`,
 * an explicit `proxy`) - and `HttpService.setupDispatcher` consumes to build
 * the dispatcher. Internal only: never part of `HttpModuleOptions`, and never
 * exported from the package (plan.md phase 3 "Option mapping": "replace the
 * `__` casts with a typed resolved config").
 */
export interface ResolvedModuleConfig {
  agentOptions?: ResolvedAgentOptions;
  proxyAgent?: { uri: string; token?: string };
}

/**
 * The single internal, `__`-prefixed key `mapAxiosConfigToUndici` stores a
 * `ResolvedModuleConfig` under - kept as one well-known key (rather than the
 * previous `__agentOptions`/`__proxyAgent` pair, each read back with its own
 * `as any` cast) so every reader gets it through one typed field instead.
 */
export interface WithResolvedConfig {
  /** @internal Set once by `mapAxiosConfigToUndici`; not part of the public API. */
  __resolvedConfig?: ResolvedModuleConfig;
}

/**
 * `HttpModuleOptions` (or `UndiciRequestOptionsType`) plus the internal
 * `__resolvedConfig` field, threaded from `HttpModule`'s providers through to
 * `HttpService`'s constructor - see `WithResolvedConfig`.
 */
export type ResolvedHttpModuleOptions = HttpModuleOptions & WithResolvedConfig;
export type ResolvedUndiciRequestOptions = UndiciRequestOptionsType &
  WithResolvedConfig;
