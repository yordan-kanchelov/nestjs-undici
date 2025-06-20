import type { Observable } from 'rxjs';
import type { UrlObject } from 'node:url';
import type { Dispatcher } from 'undici';
import type { AxiosLikeResponse, AxiosCompatibleRequestOptions } from './axios-compatible.interface';

/**
 * Type-safe HttpService interface that provides correct return types
 * based on whether axios compatibility mode is enabled
 */
export interface HttpServiceOverloads {
  // GET method overloads
  get<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>>;

  // POST method overloads
  post<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>>;

  // PUT method overloads
  put<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>>;

  // DELETE method overloads
  delete<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>>;

  // PATCH method overloads
  patch<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>>;

  // HEAD method overloads
  head<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>>;

  // OPTIONS method overloads
  options<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>>;

  // Form methods overloads
  postForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>>;

  putForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>>;

  patchForm<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): Observable<AxiosLikeResponse<T>>;
}