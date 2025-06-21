import { Observable, from, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import type {
  HttpInterceptorFunction,
  HttpInterceptorHandler,
  HttpInterceptorRequest,
} from '../interfaces/http-interceptor.interface';
import type { AxiosLikeRequestConfig, AxiosLikeResponse } from '../interfaces/axios-compatible.interface';
import type { AxiosInterceptorManager } from '../interfaces/axios-ref.interface';

/**
 * Stored interceptor with metadata
 */
interface StoredInterceptor<T> {
  id: number;
  onFulfilled?: (value: T) => T | Promise<T>;
  onRejected?: (error: any) => any;
}

/**
 * Converts axios request config to undici interceptor request
 */
function axiosConfigToInterceptorRequest(config: AxiosLikeRequestConfig): HttpInterceptorRequest {
  const { url, method, headers, data, timeout, ...restConfig } = config;
  
  const options: any = {
    method: method || 'GET',
    headers: headers || {},
  };

  // Handle body
  if (data !== undefined) {
    if (typeof data === 'string' || data instanceof Buffer) {
      options.body = data;
    } else {
      options.body = JSON.stringify(data);
      if (!options.headers['content-type'] && !options.headers['Content-Type']) {
        options.headers['content-type'] = 'application/json';
      }
    }
  }

  // Handle timeout
  if (timeout !== undefined) {
    options.headersTimeout = timeout;
    options.bodyTimeout = timeout;
  }

  // Map other axios options to undici
  if (config.maxRedirects !== undefined) {
    options.maxRedirections = config.maxRedirects;
  }

  return {
    url: url || '',
    options,
  };
}

/**
 * Converts interceptor request back to axios config
 */
function interceptorRequestToAxiosConfig(request: HttpInterceptorRequest): AxiosLikeRequestConfig {
  const { url, options } = request;
  
  return {
    url: typeof url === 'string' ? url : url.toString(),
    method: options.method,
    headers: options.headers as Record<string, string | string[]>,
    data: options.body,
    timeout: options.headersTimeout || options.bodyTimeout,
    maxRedirects: options.maxRedirections,
  };
}

/**
 * Creates an axios-style request interceptor manager
 */
export function createAxiosRequestInterceptorManager(
  addInterceptor: (interceptor: HttpInterceptorFunction) => void
): AxiosInterceptorManager<AxiosLikeRequestConfig> {
  const interceptors: Map<number, StoredInterceptor<AxiosLikeRequestConfig>> = new Map();
  let nextId = 0;

  return {
    use(
      onFulfilled?: (value: AxiosLikeRequestConfig) => AxiosLikeRequestConfig | Promise<AxiosLikeRequestConfig>,
      onRejected?: (error: any) => any
    ): number {
      const id = nextId++;
      const interceptor: StoredInterceptor<AxiosLikeRequestConfig> = {
        id,
        onFulfilled,
        onRejected,
      };
      interceptors.set(id, interceptor);

      // Create undici interceptor
      const undiciInterceptor: HttpInterceptorFunction = (request, next) => {
        // Convert request to axios config
        const axiosConfig = interceptorRequestToAxiosConfig(request);

        // Apply axios interceptor
        const applyInterceptor = from(
          Promise.resolve(axiosConfig)
            .then(config => onFulfilled ? onFulfilled(config) : config)
            .catch(error => {
              if (onRejected) {
                return onRejected(error);
              }
              throw error;
            })
        );

        return applyInterceptor.pipe(
          mergeMap(modifiedConfig => {
            // Convert back to interceptor request
            const modifiedRequest = axiosConfigToInterceptorRequest(modifiedConfig);
            return next.handle(modifiedRequest);
          }),
          catchError(error => {
            if (onRejected) {
              return from(Promise.resolve(onRejected(error)));
            }
            return throwError(() => error);
          })
        );
      };

      addInterceptor(undiciInterceptor);
      return id;
    },

    eject(id: number): void {
      // Note: Current implementation doesn't support removing individual interceptors
      // This would require tracking interceptors in HttpService
      interceptors.delete(id);
      console.warn('Interceptor ejection is not fully supported yet. Interceptor marked for removal but may still be active.');
    },

    clear(): void {
      interceptors.clear();
      console.warn('Interceptor clearing is not fully supported yet. Interceptors marked for removal but may still be active.');
    }
  };
}

/**
 * Creates an axios-style response interceptor manager
 */
export function createAxiosResponseInterceptorManager(
  addInterceptor: (interceptor: HttpInterceptorFunction) => void
): AxiosInterceptorManager<AxiosLikeResponse> {
  const interceptors: Map<number, StoredInterceptor<AxiosLikeResponse>> = new Map();
  let nextId = 0;

  return {
    use(
      onFulfilled?: (value: AxiosLikeResponse) => AxiosLikeResponse | Promise<AxiosLikeResponse>,
      onRejected?: (error: any) => any
    ): number {
      const id = nextId++;
      const interceptor: StoredInterceptor<AxiosLikeResponse> = {
        id,
        onFulfilled,
        onRejected,
      };
      interceptors.set(id, interceptor);

      // Create undici interceptor
      const undiciInterceptor: HttpInterceptorFunction = (request, next) => {
        return next.handle(request).pipe(
          mergeMap(response => {
            if (onFulfilled && response && typeof response === 'object' && 'data' in response) {
              // It's already an axios-like response
              return from(Promise.resolve(onFulfilled(response as AxiosLikeResponse)));
            }
            return of(response);
          }),
          catchError(error => {
            if (onRejected) {
              // Check if it's an axios-like error
              if (error && error.isAxiosError) {
                return from(Promise.resolve(onRejected(error)));
              }
              // Convert to axios-like error if it has response
              if (error && error.response) {
                return from(Promise.resolve(onRejected(error)));
              }
              // Create axios-like error
              const axiosError = {
                ...error,
                response: error.response || null,
                request: error.request || null,
                config: error.config || null,
                isAxiosError: true,
              };
              return from(Promise.resolve(onRejected(axiosError)));
            }
            return throwError(() => error);
          })
        );
      };

      addInterceptor(undiciInterceptor);
      return id;
    },

    eject(id: number): void {
      interceptors.delete(id);
      console.warn('Interceptor ejection is not fully supported yet. Interceptor marked for removal but may still be active.');
    },

    clear(): void {
      interceptors.clear();
      console.warn('Interceptor clearing is not fully supported yet. Interceptors marked for removal but may still be active.');
    }
  };
}