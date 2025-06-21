import { Injectable } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import type {
  HttpInterceptor,
  HttpInterceptorHandler,
  HttpInterceptorRequest,
  HttpInterceptorFunction,
} from '../interfaces/http-interceptor.interface';

export interface SizeLimitOptions {
  maxBodyLength?: number;
  maxContentLength?: number;
}

/**
 * Interceptor that enforces size limits on request bodies and response content
 */
@Injectable()
export class SizeLimitInterceptor implements HttpInterceptor {
  constructor(private readonly options: SizeLimitOptions) {}

  intercept(
    request: HttpInterceptorRequest,
    next: HttpInterceptorHandler,
  ): Observable<any> {
    // Check request body size
    if (this.options.maxBodyLength && request.options.body) {
      const bodySize = this.getBodySize(request.options.body);
      if (bodySize > this.options.maxBodyLength) {
        return throwError(() => {
          const error: any = new Error(
            `maxBodyLength size of ${this.options.maxBodyLength} exceeded`
          );
          error.code = 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED';
          return error;
        });
      }
    }

    // Execute request and check response size
    return next.handle(request).pipe(
      map(async (response) => {
        if (this.options.maxContentLength && response.body) {
          // For axios compatibility, we need to check the response size
          // This is tricky because the body might be a stream
          let contentLength = 0;
          
          // Check Content-Length header first
          const contentLengthHeader = response.headers['content-length'];
          if (contentLengthHeader) {
            contentLength = parseInt(contentLengthHeader as string, 10);
            if (contentLength > this.options.maxContentLength) {
              const error: any = new Error(
                `Response content size (${contentLength} bytes) exceeds maxContentLength (${this.options.maxContentLength} bytes)`
              );
              error.code = 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED';
              throw error;
            }
          }
          
          // If we're processing the body (like in axios adapter), we need to track size
          // This will be handled by the axios response adapter
        }
        
        return response;
      }),
      catchError((error) => {
        // Re-throw the error
        return throwError(() => error);
      })
    );
  }

  private getBodySize(body: any): number {
    if (typeof body === 'string') {
      return Buffer.byteLength(body);
    } else if (Buffer.isBuffer(body)) {
      return body.length;
    } else if (body && typeof body === 'object') {
      // For objects, convert to JSON string to get size
      return Buffer.byteLength(JSON.stringify(body));
    }
    return 0;
  }
}

/**
 * Function-based size limit interceptor factory
 */
export const createSizeLimitInterceptor = (
  options: SizeLimitOptions
): HttpInterceptorFunction => {
  const interceptor = new SizeLimitInterceptor(options);
  return (request, next) => interceptor.intercept(request, next);
};