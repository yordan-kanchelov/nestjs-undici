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

  public constructor(
    @Inject(UNDICI_INSTANCE_TOKEN)
    protected readonly options: UndiciRequestOptionsType,
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
    this.options.dispatcher = dispatcher;
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
      ...this.options,
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
    return this.options;
  }

  public addInterceptor(interceptor: HttpInterceptor | HttpInterceptorFunction): void {
    this.interceptors.push(interceptor);
  }

  public setInterceptors(interceptors: Array<HttpInterceptor | HttpInterceptorFunction>): void {
    this.interceptors = interceptors;
  }

  public get interceptorCount(): number {
    return this.interceptors.length;
  }
}