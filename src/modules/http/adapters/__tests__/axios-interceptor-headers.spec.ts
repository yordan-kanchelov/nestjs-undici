import { createAxiosRequestInterceptorManager } from '../axios-interceptor.adapter';
import { HttpInterceptorFunction } from '../../interfaces/http-interceptor.interface';
import { AxiosHeaders } from '../../interfaces/axios-headers.interface';
import { firstValueFrom } from 'rxjs';
import { of } from 'rxjs';

describe('Axios Interceptor Adapter - Headers Handling', () => {
  let interceptors: HttpInterceptorFunction[] = [];
  const addInterceptor = (interceptor: HttpInterceptorFunction) => {
    interceptors.push(interceptor);
  };

  beforeEach(() => {
    interceptors = [];
  });

  it('should handle plain object headers', async () => {
    const manager = createAxiosRequestInterceptorManager(addInterceptor);
    
    manager.use((config) => {
      // The config here is an AxiosLikeRequestConfig with AxiosHeaders
      if (!config.headers) {
        config.headers = new AxiosHeaders();
      }
      
      // Add custom header
      if (config.headers instanceof AxiosHeaders) {
        config.headers.set('X-Custom-Header', 'test-value');
      } else {
        (config.headers as Record<string, string>)['X-Custom-Header'] = 'test-value';
      }
      return config;
    });

    const mockNext = {
      handle: jest.fn().mockReturnValue(of({ data: 'success' }))
    };

    const request = {
      url: 'https://example.com',
      options: {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    };

    const interceptor = interceptors[0];
    await firstValueFrom(interceptor(request, mockNext));

    // Check what was actually called
    const actualCall = mockNext.handle.mock.calls[0][0];
    expect(actualCall.url).toBe('https://example.com');
    expect(actualCall.options.method).toBe('GET');
    expect(actualCall.options.headers['x-custom-header']).toBe('test-value');
    expect(actualCall.options.headers['content-type']).toBe('application/json');
  });

  it('should handle Headers API-like object with set method', async () => {
    const manager = createAxiosRequestInterceptorManager(addInterceptor);
    
    manager.use((config) => {
      // Initialize headers if not present
      if (!config.headers) {
        config.headers = {};
      }
      
      // If headers has a set method (like Headers API), use it
      if ((config.headers as any).set && typeof (config.headers as any).set === 'function') {
        (config.headers as any).set('X-Custom-Header', 'test-value');
      } else {
        // Otherwise treat as plain object
        config.headers['X-Custom-Header'] = 'test-value';
      }
      
      return config;
    });

    const mockNext = {
      handle: jest.fn().mockReturnValue(of({ data: 'success' }))
    };

    const request = {
      url: 'https://example.com',
      options: {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    };

    const interceptor = interceptors[0];
    await firstValueFrom(interceptor(request, mockNext));

    expect(mockNext.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          headers: expect.objectContaining({
            'content-type': 'application/json',
            'x-custom-header': 'test-value'
          })
        })
      })
    );
  });

  it('should handle OpenTelemetry-style header injection', async () => {
    const manager = createAxiosRequestInterceptorManager(addInterceptor);
    
    manager.use((config) => {
      // Simulate OpenTelemetry propagation.inject pattern
      const headers: Record<string, string> = {
        'traceparent': '00-123456789abcdef-fedcba987654321-01',
        'tracestate': 'vendor=value'
      };

      Object.entries(headers).forEach(([key, value]) => {
        if (config.headers) {
          if (typeof (config.headers as any).set === 'function') {
            (config.headers as any).set(key, value);
          } else if (typeof config.headers === 'object') {
            (config.headers as Record<string, string>)[key] = value;
          }
        }
      });

      return config;
    });

    const mockNext = {
      handle: jest.fn().mockReturnValue(of({ data: 'success' }))
    };

    const request = {
      url: 'https://example.com',
      options: {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    };

    const interceptor = interceptors[0];
    await firstValueFrom(interceptor(request, mockNext));

    expect(mockNext.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          headers: expect.objectContaining({
            'content-type': 'application/json',
            'traceparent': '00-123456789abcdef-fedcba987654321-01',
            'tracestate': 'vendor=value'
          })
        })
      })
    );
  });
});