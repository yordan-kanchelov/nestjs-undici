import { Injectable } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { map, mergeMap } from 'rxjs/operators';
import type { Dispatcher } from 'undici';
import type {
  HttpInterceptor,
  HttpInterceptorHandler,
  HttpInterceptorRequest,
  HttpInterceptorFunction,
} from '../interfaces/http-interceptor.interface';
import type {
  AxiosLikeResponse,
  AxiosLikeRequestConfig,
} from '../interfaces/axios-compatible.interface';

/**
 * HTTP status text mapping
 */
export const STATUS_TEXT_MAP: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  510: 'Not Extended',
  511: 'Network Authentication Required',
};

/**
 * Interceptor that transforms Undici responses to Axios-compatible format
 * This allows existing Axios code to work with minimal changes
 */
@Injectable()
export class AxiosResponseAdapterInterceptor implements HttpInterceptor {
  intercept(
    request: HttpInterceptorRequest,
    next: HttpInterceptorHandler,
  ): Observable<any> {
    return next.handle(request).pipe(
      mergeMap(
        async (response: Dispatcher.ResponseData | AxiosLikeResponse) => {
          // Check if it's already an axios-like response (from another interceptor)
          if (
            response &&
            typeof response === 'object' &&
            'data' in response &&
            'status' in response
          ) {
            return response as AxiosLikeResponse;
          }
          // Cast to Dispatcher.ResponseData for processing
          const undiciResponse = response as Dispatcher.ResponseData;

          // Parse the body based on content type
          const contentType =
            (undiciResponse.headers['content-type'] as string) || '';
          let parsedData: any;

          try {
            if (undiciResponse.body) {
              if (contentType.includes('application/json')) {
                const text = await undiciResponse.body.text();
                parsedData = text ? JSON.parse(text) : '';
              } else if (
                contentType.includes('text/') ||
                contentType.includes('application/xml')
              ) {
                parsedData = await undiciResponse.body.text();
              } else if (
                (undiciResponse.statusCode === 204 ||
                  undiciResponse.statusCode === 304) &&
                !contentType
              ) {
                // No Content or Not Modified without content-type should return empty string
                try {
                  const text = await undiciResponse.body.text();
                  parsedData = text || '';
                } catch {
                  parsedData = '';
                }
              } else {
                // For binary data, convert to Buffer
                parsedData = Buffer.from(
                  await undiciResponse.body.arrayBuffer(),
                );
              }
            } else {
              // Axios returns empty string for null body
              parsedData = '';
            }
          } catch (error) {
            // If parsing fails, try to get raw text
            try {
              parsedData = await undiciResponse.body.text();
            } catch {
              parsedData = '';
            }
          }

          // Create Axios-compatible request config from original request
          const config: AxiosLikeRequestConfig = {
            url:
              typeof request.url === 'string'
                ? request.url
                : request.url.toString(),
            method: request.options.method || 'GET',
            headers: request.options.headers as Record<
              string,
              string | string[]
            >,
            timeout:
              request.options.headersTimeout || request.options.bodyTimeout,
            validateStatus: request.options.validateStatus,
          };

          // Transform to Axios-compatible response
          const axiosLikeResponse: AxiosLikeResponse = {
            data: parsedData,
            status: undiciResponse.statusCode,
            statusText: STATUS_TEXT_MAP[undiciResponse.statusCode] || 'Unknown',
            headers: undiciResponse.headers as Record<
              string,
              string | string[]
            >,
            config,
          };

          // Axios throws errors for 4xx and 5xx status codes by default
          // Unless validateStatus says otherwise
          // Note: Axios also treats 3xx codes as errors by default
          const validateStatus =
            config.validateStatus ||
            ((status: number) => {
              // Default axios behavior: only 2xx are valid
              return status >= 200 && status < 300;
            });
          const isValidStatus = validateStatus(undiciResponse.statusCode);

          if (!isValidStatus) {
            const error: any = new Error(
              `Request failed with status code ${undiciResponse.statusCode}`,
            );
            error.response = axiosLikeResponse;
            error.request = config;
            error.config = config;
            error.isAxiosError = true;
            error.status = undiciResponse.statusCode;
            error.toJSON = () => ({
              message: error.message,
              name: error.name,
              stack: error.stack,
              config: error.config,
              code: error.code,
              status: undiciResponse.statusCode,
            });
            throw error;
          }

          return axiosLikeResponse;
        },
      ),
    );
  }
}

/**
 * Function-based axios response adapter interceptor
 * Can be used directly without dependency injection
 */
export const axiosResponseAdapter: HttpInterceptorFunction = (
  request,
  next,
) => {
  const interceptor = new AxiosResponseAdapterInterceptor();
  return interceptor.intercept(request, next);
};
