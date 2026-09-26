import type { Observable } from 'rxjs';
import type { Dispatcher } from 'undici';
import type { UndiciURLType } from '../types';
import type { InternalAxiosLikeRequestConfig } from './axios-compatible.interface';

export interface HttpInterceptorRequest {
  url: UndiciURLType;
  /**
   * The per-request undici dispatch options this request is about to run
   * with (or ran with) - axios options already resolved into it (`method`,
   * `headers`, `body`, `query`, ...) plus whatever undici `Dispatcher`
   * fields were passed through. Deliberately loose (not `HttpModuleOptions`,
   * which is the *module*-level config surface and, unlike this, has no
   * index signature so typos in it are compile errors): interceptors see
   * whatever ad-hoc fields `normalizeAxiosRequest`/`buildAxiosConfig` put
   * here, including ones with no module-level equivalent (`data`, `signal`,
   * `cancelToken`, ...).
   */
  options: Record<string, any>;
  /**
   * The axios-shaped config this request was built from, when one is
   * available: eagerly, once axiosRef request interceptors have run, or
   * lazily otherwise (a getter, materialised on first access so a plain
   * request that nobody inspects `response.config`/`error.config` for never
   * pays to build it). `response.config` and `error.config` read this.
   */
  axiosConfig?: InternalAxiosLikeRequestConfig;
}

export interface HttpInterceptor {
  intercept(
    request: HttpInterceptorRequest,
    next: HttpInterceptorHandler,
  ): Observable<any>;
}

export interface HttpInterceptorHandler {
  handle(request: HttpInterceptorRequest): Observable<any>;
}

export type HttpInterceptorFunction = (
  request: HttpInterceptorRequest,
  next: HttpInterceptorHandler,
) => Observable<any>;
