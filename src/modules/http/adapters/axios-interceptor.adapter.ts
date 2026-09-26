import type {
  AxiosInterceptorManager,
  AxiosInterceptorOptions,
} from '../interfaces/axios-ref.interface';

/**
 * One registered interceptor. `null` marks an ejected slot: axios keeps the
 * slot (so later ids stay stable) rather than splicing the array, and so do
 * we - `entries` is walked directly by `HttpService`'s axios pipeline to
 * build the request (LIFO)/response (FIFO) chain per subscription.
 */
export interface AxiosInterceptorEntry<T> {
  fulfilled?: (value: T) => T | Promise<T>;
  rejected?: (error: any) => any;
  runWhen?: ((config: any) => boolean) | null;
  synchronous?: boolean;
}

/**
 * An `AxiosInterceptorManager` that also exposes its registration-ordered
 * entries, so the pipeline can build axios' actual execution order: request
 * interceptors run last-registered-first (LIFO), response interceptors
 * first-registered-first (FIFO) - see `HttpService`'s axios pipeline.
 */
export interface AxiosInterceptorStore<T> extends AxiosInterceptorManager<T> {
  readonly entries: ReadonlyArray<AxiosInterceptorEntry<T> | null>;
}

/**
 * Creates an axios-style interceptor store. Unlike the old design, `use()`
 * no longer wraps the handler as a generic `HttpInterceptorFunction` pushed
 * into `HttpService`'s undici-level interceptor chain (which lost `data`,
 * `baseURL`, `params` and any custom config fields on every round trip
 * through `response.config` / `error.config`). Instead `HttpService` reads
 * `entries` directly and runs them over the single axios-shaped config
 * object it builds for the request (see `buildAxiosConfig` /
 * `serializeAxiosConfig` in `axios-request.adapter.ts`).
 */
export function createInterceptorStore<T>(): AxiosInterceptorStore<T> {
  const entries: Array<AxiosInterceptorEntry<T> | null> = [];

  return {
    entries,

    use(
      onFulfilled?: (value: T) => T | Promise<T>,
      onRejected?: (error: any) => any,
      options?: AxiosInterceptorOptions,
    ): number {
      entries.push({
        fulfilled: onFulfilled,
        rejected: onRejected,
        runWhen: options?.runWhen,
        synchronous: options?.synchronous,
      });
      return entries.length - 1;
    },

    eject(id: number): void {
      if (entries[id]) entries[id] = null;
    },

    clear(): void {
      entries.length = 0;
    },
  };
}
