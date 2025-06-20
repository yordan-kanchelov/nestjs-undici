import type { Observable } from 'rxjs';
import type { Dispatcher } from 'undici';
import type { UndiciURLType, UndiciRequestOptionsType } from '../types';

export interface HttpInterceptorRequest {
  url: UndiciURLType;
  options: UndiciRequestOptionsType;
}

export interface HttpInterceptor {
  intercept(
    request: HttpInterceptorRequest,
    next: HttpInterceptorHandler
  ): Observable<any>;
}

export interface HttpInterceptorHandler {
  handle(request: HttpInterceptorRequest): Observable<any>;
}

export type HttpInterceptorFunction = (
  request: HttpInterceptorRequest,
  next: HttpInterceptorHandler
) => Observable<any>;