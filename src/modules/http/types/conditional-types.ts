import type { Observable } from 'rxjs';
import type { UrlObject } from 'node:url';
import type { AxiosLikeResponse, AxiosCompatibleRequestOptions } from '../interfaces';
import type { HttpService } from '../services/http.service';

/**
 * Type that represents the HTTP response - always axios-compatible in v0.4.0+
 */
export type HttpResponseType<T = any> = AxiosLikeResponse<T>;

/**
 * Type for the entire Observable response
 */
export type HttpObservableResponse<T = any> = Observable<HttpResponseType<T>>;

/**
 * HTTP method signatures - all return axios-compatible responses
 */
export interface AdaptiveHttpMethods {
  get<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): HttpObservableResponse<T>;

  post<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): HttpObservableResponse<T>;

  put<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): HttpObservableResponse<T>;

  delete<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): HttpObservableResponse<T>;

  patch<T = any>(
    url: string | URL | UrlObject,
    data?: any,
    config?: AxiosCompatibleRequestOptions,
  ): HttpObservableResponse<T>;

  head<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): HttpObservableResponse<T>;

  options<T = any>(
    url: string | URL | UrlObject,
    config?: AxiosCompatibleRequestOptions,
  ): HttpObservableResponse<T>;
}

/**
 * Type utility to extract the service type from a module
 */
export type ExtractServiceType<TModule> = HttpService;