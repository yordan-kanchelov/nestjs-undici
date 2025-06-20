import type { IncomingHttpHeaders } from 'http';
import type { Dispatcher } from 'undici';

/**
 * Axios-compatible response structure
 * This interface mimics the AxiosResponse structure to provide compatibility
 */
export interface AxiosLikeResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders | Record<string, string | string[]>;
  config: AxiosLikeRequestConfig;
  request?: any;
}

/**
 * Axios-compatible request configuration
 */
export interface AxiosLikeRequestConfig {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[]>;
  params?: any;
  data?: any;
  timeout?: number;
  responseType?: 'json' | 'text' | 'stream' | 'arraybuffer' | 'blob';
  maxRedirects?: number;
  validateStatus?: (status: number) => boolean;
}

/**
 * Extended Undici ResponseData with parsed body
 */
export interface UndiciResponseWithParsedBody extends Dispatcher.ResponseData {
  parsedBody?: any;
}

/**
 * Axios-compatible request options that can be used with HttpService methods
 * This extends Undici's RequestOptions with axios-specific options like timeout
 */
export interface AxiosCompatibleRequestOptions extends Omit<
  Dispatcher.RequestOptions,
  'origin' | 'path' | 'method' | 'body'
> {
  timeout?: number;
}