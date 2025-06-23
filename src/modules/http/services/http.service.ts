import { Inject, Injectable, Optional } from '@nestjs/common';
import { request, ProxyAgent, Agent as UndiciAgent } from 'undici';
import { CookieAgent } from 'http-cookie-agent/undici';
import { CookieJar } from 'tough-cookie';

import { Observable, defer, of } from 'rxjs';
import { mergeMap } from 'rxjs/operators';

import {
  UNDICI_INSTANCE_TOKEN,
  HTTP_MODULE_OPTIONS,
} from '../constants/http.constants';

import type { UrlObject } from 'node:url';
import type { Dispatcher } from 'undici';
import type { HttpModuleOptions, UndiciRequestOptionsType } from '../types';
import type {
  HttpInterceptor,
  HttpInterceptorFunction,
  HttpInterceptorHandler,
  HttpInterceptorRequest,
  AxiosCompatibleRequestOptions,
  AxiosLikeResponse,
  AxiosRef,
} from '../interfaces';
import {
  createAxiosRequestInterceptorManager,
  createAxiosResponseInterceptorManager,
} from '../adapters/axios-interceptor.adapter';
import { axiosResponseAdapter } from '../interceptors/axios-response-adapter.interceptor';

@Injectable()
export class HttpService {
  private interceptors: Array<HttpInterceptor | HttpInterceptorFunction> = [];
  private _axiosRef: AxiosRef;
  private customDispatcher?: Dispatcher;
  private cookieJar?: CookieJar;

  public constructor(
    @Inject(UNDICI_INSTANCE_TOKEN)
    protected readonly instanceOptions: UndiciRequestOptionsType,
    @Optional()
    @Inject(HTTP_MODULE_OPTIONS)
    private readonly moduleOptions?: HttpModuleOptions,
  ) {
    // Initialize interceptors from module options if available
    if (this.moduleOptions?.interceptors) {
      // For now, we'll only handle function interceptors in the constructor
      // Class-based interceptors need to be resolved by the DI container
      this.interceptors = this.moduleOptions.interceptors
        .filter(interceptor => typeof interceptor === 'function')
        .map(interceptor => interceptor as HttpInterceptorFunction);
    }

    // Initialize axios-compatible interceptor managers
    this._axiosRef = {
      interceptors: {
        request: createAxiosRequestInterceptorManager((interceptor) => this.addInterceptor(interceptor)),
        response: createAxiosResponseInterceptorManager((interceptor) => this.addInterceptor(interceptor)),
      },
    };

    // Setup custom dispatcher based on axios compatibility options
    this.setupDispatcher();
  }

  private setupDispatcher(): void {
    const options = this.moduleOptions as any;
    if (!options) return;

    let baseDispatcher: Dispatcher | undefined;

    // Handle ProxyAgent first (highest priority)
    if (options.__proxyAgent) {
      baseDispatcher = new ProxyAgent(options.__proxyAgent);
    }
    // Handle custom agent options
    else if (options.__agentOptions) {
      baseDispatcher = new UndiciAgent({
        connections: options.__agentOptions.connections,
        pipelining: options.pipelining || 1,
      });
    }

    // Handle cookie support - wrap existing dispatcher if present
    if (options.__withCredentials) {
      this.cookieJar = new CookieJar();
      
      // Create cookie agent, optionally wrapping the base dispatcher
      const cookieAgentOptions: any = { 
        cookies: { jar: this.cookieJar } 
      };
      
      // If we have a base dispatcher (proxy or custom agent), wrap it
      if (baseDispatcher) {
        cookieAgentOptions.factory = () => baseDispatcher;
      }
      
      this.customDispatcher = new CookieAgent(cookieAgentOptions);
    } else if (baseDispatcher) {
      this.customDispatcher = baseDispatcher;
    }

    if (this.customDispatcher) {
      // Set as default dispatcher in instance options
      this.instanceOptions.dispatcher = this.customDispatcher;
    }
  }

  public setGlobalDispatcher(dispatcher: Dispatcher): void {
    this.instanceOptions.dispatcher = dispatcher;
  }

  public request<T = any>(
    url: string | URL | UrlObject,
    options?: { dispatcher?: Dispatcher } & Omit<
      Dispatcher.RequestOptions,
      'origin' | 'path' | 'method'
    > &
      Partial<Pick<Dispatcher.RequestOptions, 'method'>> & { timeout?: number },
  ): Observable<AxiosLikeResponse<T>> {
    // Handle timeout option for axios compatibility
    const { timeout, ...restOptions } = options || {};
    const mergedOptions = {
      ...this.instanceOptions,
      ...restOptions,
    };

    // Map timeout to undici's timeout options
    if (timeout !== undefined) {
      mergedOptions.headersTimeout = timeout;
      mergedOptions.bodyTimeout = timeout;
    }

    // Pass through size limit options from module config
    const moduleOpts = this.moduleOptions as any;
    if (moduleOpts?.maxBodyLength !== undefined) {
      (mergedOptions as any).maxBodyLength = moduleOpts.maxBodyLength;
    }
    if (moduleOpts?.maxContentLength !== undefined) {
      (mergedOptions as any).maxContentLength = moduleOpts.maxContentLength;
    }

    // Handle axios-specific options from module configuration
    let finalUrl = url;
    const axiosCompat = (this.moduleOptions as any)?.__axiosCompat;
    
    if (axiosCompat?.baseURL) {
      // Apply baseURL if the URL is relative
      const urlString = typeof url === 'string' ? url : url.toString();
      if (!urlString.startsWith('http://') && !urlString.startsWith('https://')) {
        finalUrl = new URL(urlString, axiosCompat.baseURL).toString();
      }
    }

    // Handle socket path
    if (moduleOpts?.__socketPath) {
      // Transform URL to use unix socket
      const urlString = typeof finalUrl === 'string' ? finalUrl : finalUrl.toString();
      const urlObj = new URL(urlString);
      finalUrl = `unix:${moduleOpts.__socketPath}:${urlObj.pathname}${urlObj.search}`;
    }

    // Create the request object for interceptors
    const interceptorRequest: HttpInterceptorRequest = {
      url: finalUrl,
      options: mergedOptions,
    };

    // Create the interceptor chain (always includes axios adapter)
    return this.executeInterceptorChain(interceptorRequest);
  }

  private executeRequest<T = any>(
    interceptorRequest: HttpInterceptorRequest,
  ): Observable<Dispatcher.ResponseData> {
    return defer(() => {
      return new Observable<Dispatcher.ResponseData>(subscriber => {
        // Ensure we use the configured dispatcher (for cookies, proxy, etc.)
        const options = {
          ...interceptorRequest.options,
          dispatcher: this.customDispatcher || interceptorRequest.options.dispatcher || this.instanceOptions.dispatcher
        };
        
        const response = request(
          interceptorRequest.url,
          options,
        );
        response
          .then(res => {
            subscriber.next(res);
            subscriber.complete();
          })
          .catch(error => {
            subscriber.error(error);
          });
      });
    });
  }

  private executeInterceptorChain<T = any>(
    request: HttpInterceptorRequest,
  ): Observable<any> {
    // Always include axios response adapter as the last interceptor
    const allInterceptors = [...this.interceptors, axiosResponseAdapter];
    const handler = this.createInterceptorHandler<T>(0, allInterceptors);
    return handler.handle(request);
  }

  private createInterceptorHandler<T = any>(
    index: number, 
    interceptors: Array<HttpInterceptor | HttpInterceptorFunction>
  ): HttpInterceptorHandler {
    if (index >= interceptors.length) {
      // End of chain - execute the actual request
      return {
        handle: (request: HttpInterceptorRequest) =>
          this.executeRequest<T>(request),
      };
    }

    const interceptor = interceptors[index];
    const nextHandler = this.createInterceptorHandler<T>(index + 1, interceptors);

    return {
      handle: (request: HttpInterceptorRequest) => {
        if (typeof interceptor === 'function') {
          return interceptor(request, nextHandler);
        } else {
          return interceptor.intercept(request, nextHandler);
        }
      },
    };
  }

  public get undiciRef(): UndiciRequestOptionsType {
    return this.instanceOptions;
  }

  /**
   * Axios-compatible reference for interceptor management
   * Provides axios-style API: httpService.axiosRef.interceptors.request.use()
   */
  public get axiosRef(): AxiosRef {
    return this._axiosRef;
  }

  public addInterceptor(
    interceptor: HttpInterceptor | HttpInterceptorFunction,
  ): void {
    this.interceptors.push(interceptor);
  }

  public setInterceptors(
    interceptors: Array<HttpInterceptor | HttpInterceptorFunction>,
  ): void {
    this.interceptors = interceptors;
  }


  public get interceptorCount(): number {
    // Include the axios response adapter which is always added
    return this.interceptors.length + 1;
  }

  /**
   * Convenience method for GET requests
   * @param url The URL to request
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public get<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>> {
    return this.request(url, { ...config, method: 'GET' });
  }

  /**
   * Convenience method for POST requests
   * @param url The URL to request
   * @param data The data to send in the body
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public post<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>> {
    const body = data
      ? typeof data === 'string'
        ? data
        : JSON.stringify(data)
      : undefined;
    return this.request(url, {
      ...config,
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        ...config?.headers,
      },
    });
  }

  /**
   * Convenience method for PUT requests
   * @param url The URL to request
   * @param data The data to send in the body
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public put<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>> {
    const body = data
      ? typeof data === 'string'
        ? data
        : JSON.stringify(data)
      : undefined;
    return this.request(url, {
      ...config,
      method: 'PUT',
      body,
      headers: {
        'Content-Type': 'application/json',
        ...config?.headers,
      },
    });
  }

  /**
   * Convenience method for DELETE requests
   * @param url The URL to request
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public delete<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>> {
    return this.request(url, { ...config, method: 'DELETE' });
  }

  /**
   * Convenience method for PATCH requests
   * @param url The URL to request
   * @param data The data to send in the body
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public patch<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>> {
    const body = data
      ? typeof data === 'string'
        ? data
        : JSON.stringify(data)
      : undefined;
    return this.request(url, {
      ...config,
      method: 'PATCH',
      body,
      headers: {
        'Content-Type': 'application/json',
        ...config?.headers,
      },
    });
  }

  /**
   * Convenience method for HEAD requests
   * @param url The URL to request
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public head<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>> {
    return this.request(url, { ...config, method: 'HEAD' });
  }

  /**
   * Convenience method for OPTIONS requests
   * @param url The URL to request
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public options<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>> {
    return this.request(url, { ...config, method: 'OPTIONS' });
  }

  /**
   * Convenience method for POST requests with form data
   * @param url The URL to request
   * @param data The form data to send
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public postForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>> {
    const body = this.createFormData(data);
    return this.request(url, {
      ...config,
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...config?.headers,
      },
    });
  }

  /**
   * Convenience method for PUT requests with form data
   * @param url The URL to request
   * @param data The form data to send
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public putForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>> {
    const body = this.createFormData(data);
    return this.request(url, {
      ...config,
      method: 'PUT',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...config?.headers,
      },
    });
  }

  /**
   * Convenience method for PATCH requests with form data
   * @param url The URL to request
   * @param data The form data to send
   * @param config Optional configuration
   * @returns Observable that emits AxiosLikeResponse<T>
   */
  public patchForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>> {
    const body = this.createFormData(data);
    return this.request(url, {
      ...config,
      method: 'PATCH',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...config?.headers,
      },
    });
  }

  /**
   * Helper method to create form data string from object
   */
  private createFormData(data: any): string {
    if (!data) return '';
    if (typeof data === 'string') return data;

    return Object.entries(data)
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
      )
      .join('&');
  }
}
