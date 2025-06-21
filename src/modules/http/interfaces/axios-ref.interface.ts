import type { Observable } from 'rxjs';
import type { HttpInterceptor, HttpInterceptorFunction } from './http-interceptor.interface';
import type { AxiosLikeRequestConfig, AxiosLikeResponse } from './axios-compatible.interface';

/**
 * Axios-style interceptor manager interface
 */
export interface AxiosInterceptorManager<T> {
  /**
   * Add an interceptor
   * @param onFulfilled Success handler
   * @param onRejected Error handler
   * @returns Interceptor ID for later ejection
   */
  use(
    onFulfilled?: (value: T) => T | Promise<T>,
    onRejected?: (error: any) => any
  ): number;

  /**
   * Remove an interceptor by ID
   * @param id The interceptor ID returned by use()
   */
  eject(id: number): void;

  /**
   * Clear all interceptors
   */
  clear(): void;
}

/**
 * Axios-compatible reference interface
 * Provides axios-style API for interceptor management
 */
export interface AxiosRef {
  interceptors: {
    request: AxiosInterceptorManager<AxiosLikeRequestConfig>;
    response: AxiosInterceptorManager<AxiosLikeResponse>;
  };
}

/**
 * Extended HttpService interface with axios compatibility
 */
export interface HttpServiceWithAxiosRef {
  /**
   * Axios-compatible reference for interceptor management
   */
  axiosRef: AxiosRef;
}