import { Inject, Injectable, Optional } from '@nestjs/common';
import { request } from 'undici';

import { Observable, defer, of } from 'rxjs';
import { mergeMap } from 'rxjs/operators';

import { UNDICI_INSTANCE_TOKEN, HTTP_MODULE_OPTIONS } from '../constants/http.constants';

import type { UrlObject } from 'node:url';
import type { Dispatcher } from 'undici';
import type { HttpModuleOptions, UndiciRequestOptionsType } from '../types';
import type { HttpInterceptor, HttpInterceptorFunction, HttpInterceptorHandler, HttpInterceptorRequest } from '../interfaces';

@Injectable()
export class HttpService {
  private interceptors: Array<HttpInterceptor | HttpInterceptorFunction> = [];
  private axiosCompatible = false;

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
  }
  
  public setGlobalDispatcher(dispatcher: Dispatcher): void {
    this.instanceOptions.dispatcher = dispatcher;
  }

  public request(
    url: string | URL | UrlObject,
    options?: { dispatcher?: Dispatcher } & Omit<
      Dispatcher.RequestOptions,
      'origin' | 'path' | 'method'
    > &
      Partial<Pick<Dispatcher.RequestOptions, 'method'>>,
  ): Observable<Dispatcher.ResponseData> {
    const mergedOptions = {
      ...this.instanceOptions,
      ...options,
    };

    // Create the request object for interceptors
    const interceptorRequest: HttpInterceptorRequest = {
      url,
      options: mergedOptions,
    };

    // If no interceptors, execute the request directly
    if (this.interceptors.length === 0) {
      return this.executeRequest(interceptorRequest);
    }

    // Create the interceptor chain
    return this.executeInterceptorChain(interceptorRequest);
  }

  private executeRequest(interceptorRequest: HttpInterceptorRequest): Observable<Dispatcher.ResponseData> {
    return defer(() => {
      return new Observable<Dispatcher.ResponseData>(subscriber => {
        const response = request(interceptorRequest.url, interceptorRequest.options);
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

  private executeInterceptorChain(request: HttpInterceptorRequest): Observable<Dispatcher.ResponseData> {
    const handler = this.createInterceptorHandler(0);
    return handler.handle(request);
  }

  private createInterceptorHandler(index: number): HttpInterceptorHandler {
    if (index >= this.interceptors.length) {
      // End of chain - execute the actual request
      return {
        handle: (request: HttpInterceptorRequest) => this.executeRequest(request),
      };
    }

    const interceptor = this.interceptors[index];
    const nextHandler = this.createInterceptorHandler(index + 1);

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

  public addInterceptor(interceptor: HttpInterceptor | HttpInterceptorFunction): void {
    this.interceptors.push(interceptor);
  }

  public setInterceptors(interceptors: Array<HttpInterceptor | HttpInterceptorFunction>): void {
    this.interceptors = interceptors;
  }
  
  public setAxiosCompatible(value: boolean): void {
    this.axiosCompatible = value;
  }

  public get interceptorCount(): number {
    return this.interceptors.length;
  }

  /**
   * Convenience method for GET requests
   * @param url The URL to request
   * @param config Optional configuration
   */
  public get<T = any>(
    url: string | URL | UrlObject, 
    config?: Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method' | 'body'>
  ): Observable<Dispatcher.ResponseData> {
    return this.request(url, { ...config, method: 'GET' });
  }

  /**
   * Convenience method for POST requests
   * @param url The URL to request
   * @param data The data to send in the body
   * @param config Optional configuration
   */
  public post<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method' | 'body'>
  ): Observable<Dispatcher.ResponseData> {
    const body = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : undefined;
    return this.request(url, { 
      ...config, 
      method: 'POST', 
      body,
      headers: {
        'Content-Type': 'application/json',
        ...config?.headers
      }
    });
  }

  /**
   * Convenience method for PUT requests
   * @param url The URL to request
   * @param data The data to send in the body
   * @param config Optional configuration
   */
  public put<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method' | 'body'>
  ): Observable<Dispatcher.ResponseData> {
    const body = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : undefined;
    return this.request(url, { 
      ...config, 
      method: 'PUT', 
      body,
      headers: {
        'Content-Type': 'application/json',
        ...config?.headers
      }
    });
  }

  /**
   * Convenience method for DELETE requests
   * @param url The URL to request
   * @param config Optional configuration
   */
  public delete<T = any>(
    url: string | URL | UrlObject,
    config?: Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method' | 'body'>
  ): Observable<Dispatcher.ResponseData> {
    return this.request(url, { ...config, method: 'DELETE' });
  }

  /**
   * Convenience method for PATCH requests
   * @param url The URL to request
   * @param data The data to send in the body
   * @param config Optional configuration
   */
  public patch<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method' | 'body'>
  ): Observable<Dispatcher.ResponseData> {
    const body = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : undefined;
    return this.request(url, { 
      ...config, 
      method: 'PATCH', 
      body,
      headers: {
        'Content-Type': 'application/json',
        ...config?.headers
      }
    });
  }

  /**
   * Convenience method for HEAD requests
   * @param url The URL to request
   * @param config Optional configuration
   */
  public head<T = any>(
    url: string | URL | UrlObject,
    config?: Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method' | 'body'>
  ): Observable<Dispatcher.ResponseData> {
    return this.request(url, { ...config, method: 'HEAD' });
  }

  /**
   * Convenience method for OPTIONS requests
   * @param url The URL to request
   * @param config Optional configuration
   */
  public options<T = any>(
    url: string | URL | UrlObject,
    config?: Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method' | 'body'>
  ): Observable<Dispatcher.ResponseData> {
    return this.request(url, { ...config, method: 'OPTIONS' });
  }

  /**
   * Convenience method for POST requests with form data
   * @param url The URL to request
   * @param data The form data to send
   * @param config Optional configuration
   */
  public postForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method' | 'body'>
  ): Observable<Dispatcher.ResponseData> {
    const body = this.createFormData(data);
    return this.request(url, { 
      ...config, 
      method: 'POST', 
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...config?.headers
      }
    });
  }

  /**
   * Convenience method for PUT requests with form data
   * @param url The URL to request
   * @param data The form data to send
   * @param config Optional configuration
   */
  public putForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method' | 'body'>
  ): Observable<Dispatcher.ResponseData> {
    const body = this.createFormData(data);
    return this.request(url, { 
      ...config, 
      method: 'PUT', 
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...config?.headers
      }
    });
  }

  /**
   * Convenience method for PATCH requests with form data
   * @param url The URL to request
   * @param data The form data to send
   * @param config Optional configuration
   */
  public patchForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method' | 'body'>
  ): Observable<Dispatcher.ResponseData> {
    const body = this.createFormData(data);
    return this.request(url, { 
      ...config, 
      method: 'PATCH', 
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...config?.headers
      }
    });
  }

  /**
   * Helper method to create form data string from object
   */
  private createFormData(data: any): string {
    if (!data) return '';
    if (typeof data === 'string') return data;
    
    return Object.entries(data)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
  }
}