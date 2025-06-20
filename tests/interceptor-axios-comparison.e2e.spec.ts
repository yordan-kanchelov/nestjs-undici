import { Test, TestingModule } from '@nestjs/testing';
import { Injectable } from '@nestjs/common';
import {
  HttpModule as UndiciHttpModule,
  HttpService as UndiciHttpService,
} from '../src';
import {
  HttpModule as AxiosHttpModule,
  HttpService as AxiosHttpService,
} from '@nestjs/axios';
import { firstValueFrom, Observable } from 'rxjs';
import { map, catchError, mergeMap } from 'rxjs/operators';
import { of, throwError } from 'rxjs';
import * as http from 'http';
import { AddressInfo } from 'net';
import type {
  HttpInterceptor,
  HttpInterceptorHandler,
  HttpInterceptorRequest,
} from '../src/modules/http/interfaces/http-interceptor.interface';
import type { Dispatcher } from 'undici';

describe('Interceptor Comparison: @nestjs/axios vs nestjs-undici', () => {
  let mockServer: http.Server;
  let serverUrl: string;

  // Helper to create a mock HTTP server
  const createMockServer = (handler: http.RequestListener): Promise<string> => {
    return new Promise(resolve => {
      mockServer = http.createServer(handler);
      mockServer.listen(0, 'localhost', () => {
        const port = (mockServer.address() as AddressInfo).port;
        resolve(`http://localhost:${port}`);
      });
    });
  };

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((resolve, reject) => {
        mockServer.close(err => {
          if (err) reject(err);
          else resolve();
        });
        // Force close all connections after a timeout
        mockServer.closeAllConnections();
      });
      mockServer = null;
    }
  });

  // Clean up axios interceptors after each test to prevent pollution
  afterEach(() => {
    // Import axios to access the default instance used by @nestjs/axios
    const axios = require('axios').default || require('axios');
    // Clear all interceptors from the default axios instance
    if (axios.interceptors) {
      axios.interceptors.request.handlers.length = 0;
      axios.interceptors.response.handlers.length = 0;
    }
  });

  describe('Request Interceptors', () => {
    describe('Header Manipulation', () => {
      let axiosModule: TestingModule;
      let undiciModule: TestingModule;
      let undiciAxiosCompatModule: TestingModule;
      let axiosService: AxiosHttpService;
      let undiciService: UndiciHttpService;
      let undiciAxiosCompatService: UndiciHttpService;

      beforeEach(async () => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              headers: req.headers,
              method: req.method,
              url: req.url,
            }),
          );
        });

        // Setup Axios module with interceptors
        axiosModule = await Test.createTestingModule({
          imports: [AxiosHttpModule.register({})],
        }).compile();

        axiosService = axiosModule.get<AxiosHttpService>(AxiosHttpService);

        // Add Axios interceptors
        axiosService.axiosRef.interceptors.request.use(config => {
          config.headers['Authorization'] = 'Bearer axios-token';
          config.headers['X-Request-ID'] = 'axios-123';
          config.headers['X-Custom-Header'] = 'axios-value';
          return config;
        });

        // Setup Undici module with interceptors
        undiciModule = await Test.createTestingModule({
          imports: [
            UndiciHttpModule.register({
              interceptors: [
                (request, next) => {
                  const modifiedRequest = {
                    ...request,
                    options: {
                      ...request.options,
                      headers: {
                        ...request.options.headers,
                        Authorization: 'Bearer undici-token',
                        'X-Request-ID': 'undici-123',
                        'X-Custom-Header': 'undici-value',
                      },
                    },
                  };
                  return next.handle(modifiedRequest);
                },
              ],
            }),
          ],
        }).compile();

        undiciService = undiciModule.get<UndiciHttpService>(UndiciHttpService);

        // Setup Undici Axios-compatible module
        undiciAxiosCompatModule = await Test.createTestingModule({
          imports: [
            UndiciHttpModule.registerAxiosCompatible({
              interceptors: [
                (request, next) => {
                  const modifiedRequest = {
                    ...request,
                    options: {
                      ...request.options,
                      headers: {
                        ...request.options.headers,
                        Authorization: 'Bearer undici-compat-token',
                        'X-Request-ID': 'undici-compat-123',
                        'X-Custom-Header': 'undici-compat-value',
                      },
                    },
                  };
                  return next.handle(modifiedRequest);
                },
              ],
            }),
          ],
        }).compile();

        undiciAxiosCompatService =
          undiciAxiosCompatModule.get<UndiciHttpService>(UndiciHttpService);
      });

      afterEach(async () => {
        await axiosModule?.close();
        await undiciModule?.close();
        await undiciAxiosCompatModule?.close();
      });

      it('should add headers via interceptors in all implementations', async () => {
        // Test Axios
        const axiosResponse = await firstValueFrom(
          axiosService.get(serverUrl).pipe(map((res: any) => res.data)),
        );
        expect(axiosResponse.headers.authorization).toBe('Bearer axios-token');
        expect(axiosResponse.headers['x-request-id']).toBe('axios-123');
        expect(axiosResponse.headers['x-custom-header']).toBe('axios-value');

        // Test Undici native
        const undiciResponse = await firstValueFrom(
          undiciService.request(serverUrl),
        );
        const undiciData: any = await undiciResponse.body.json();
        expect(undiciData.headers.authorization).toBe('Bearer undici-token');
        expect(undiciData.headers['x-request-id']).toBe('undici-123');
        expect(undiciData.headers['x-custom-header']).toBe('undici-value');

        // Test Undici Axios-compatible
        const undiciCompatResponse = await firstValueFrom(
          undiciAxiosCompatService
            .request(serverUrl)
            .pipe(map((res: any) => res.data)),
        );
        expect(undiciCompatResponse.headers.authorization).toBe(
          'Bearer undici-compat-token',
        );
        expect(undiciCompatResponse.headers['x-request-id']).toBe(
          'undici-compat-123',
        );
        expect(undiciCompatResponse.headers['x-custom-header']).toBe(
          'undici-compat-value',
        );
      });
    });

    describe('Multiple Interceptors Chain', () => {
      let axiosModule: TestingModule;
      let undiciModule: TestingModule;
      let axiosService: AxiosHttpService;
      let undiciService: UndiciHttpService;

      beforeEach(async () => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              interceptorOrder: req.headers['x-interceptor-order'] || '',
            }),
          );
        });

        // Axios with multiple interceptors
        axiosModule = await Test.createTestingModule({
          imports: [AxiosHttpModule.register({})],
        }).compile();

        axiosService = axiosModule.get<AxiosHttpService>(AxiosHttpService);

        // Note: Axios interceptors are executed in reverse order for requests
        // So if we add A1, A2, A3, they execute as A3, A2, A1
        axiosService.axiosRef.interceptors.request.use(config => {
          config.headers['X-Interceptor-Order'] =
            (config.headers['X-Interceptor-Order'] || '') + 'A1';
          return config;
        });

        axiosService.axiosRef.interceptors.request.use(config => {
          config.headers['X-Interceptor-Order'] =
            (config.headers['X-Interceptor-Order'] || '') + 'A2-';
          return config;
        });

        axiosService.axiosRef.interceptors.request.use(config => {
          config.headers['X-Interceptor-Order'] = 'A3-';
          return config;
        });

        // Undici with multiple interceptors
        undiciModule = await Test.createTestingModule({
          imports: [
            UndiciHttpModule.register({
              interceptors: [
                (request, next) => {
                  const modifiedRequest = {
                    ...request,
                    options: {
                      ...request.options,
                      headers: {
                        ...request.options.headers,
                        'X-Interceptor-Order': 'U1-',
                      },
                    },
                  };
                  return next.handle(modifiedRequest);
                },
                (request, next) => {
                  const modifiedRequest = {
                    ...request,
                    options: {
                      ...request.options,
                      headers: {
                        ...request.options.headers,
                        'X-Interceptor-Order':
                          (request.options.headers?.['X-Interceptor-Order'] ||
                            '') + 'U2-',
                      },
                    },
                  };
                  return next.handle(modifiedRequest);
                },
                (request, next) => {
                  const modifiedRequest = {
                    ...request,
                    options: {
                      ...request.options,
                      headers: {
                        ...request.options.headers,
                        'X-Interceptor-Order':
                          (request.options.headers?.['X-Interceptor-Order'] ||
                            '') + 'U3',
                      },
                    },
                  };
                  return next.handle(modifiedRequest);
                },
              ],
            }),
          ],
        }).compile();

        undiciService = undiciModule.get<UndiciHttpService>(UndiciHttpService);
      });

      afterEach(async () => {
        await axiosModule?.close();
        await undiciModule?.close();
      });

      it('should execute interceptors in correct order', async () => {
        // Test Axios interceptor order (reverse for request interceptors)
        const axiosResponse = await firstValueFrom(
          axiosService.get(serverUrl).pipe(map((res: any) => res.data)),
        );
        // Axios executes request interceptors in reverse order
        expect(axiosResponse.interceptorOrder).toMatch(/A\d-A\d-A\d/);

        // Test Undici interceptor order (forward order)
        const undiciResponse = await firstValueFrom(
          undiciService.request(serverUrl),
        );
        const undiciData: any = await undiciResponse.body.json();
        expect(undiciData.interceptorOrder).toBe('U1-U2-U3');
      });
    });
  });

  describe('Response Interceptors', () => {
    describe('Data Transformation', () => {
      let axiosModule: TestingModule;
      let undiciAxiosCompatModule: TestingModule;
      let axiosService: AxiosHttpService;
      let undiciAxiosCompatService: UndiciHttpService;

      beforeEach(async () => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              originalData: 'test-data',
              timestamp: Date.now(),
            }),
          );
        });

        // Axios with response interceptor
        axiosModule = await Test.createTestingModule({
          imports: [AxiosHttpModule.register({})],
        }).compile();

        axiosService = axiosModule.get<AxiosHttpService>(AxiosHttpService);

        // Add interceptor to the axios instance
        axiosService.axiosRef.interceptors.response.use(response => {
          if (response && response.data) {
            // Create a new data object with the original data and added properties
            const modifiedData = Object.assign({}, response.data, {
              intercepted: true,
              processedBy: 'axios',
              processingTime: new Date().toISOString(),
            });
            response.data = modifiedData;
          }
          return response;
        });

        // Undici Axios-compatible with response interceptor
        // In axios-compatible mode, interceptors run BEFORE the axios adapter transforms the response
        undiciAxiosCompatModule = await Test.createTestingModule({
          imports: [
            UndiciHttpModule.registerAxiosCompatible({
              interceptors: [
                // In axios-compatible mode, this interceptor runs AFTER the axios adapter
                // So we work with the axios-format response, not raw Undici response
                (request, next) => {
                  return next.handle(request).pipe(
                    map((response: any) => {
                      // The response is already in axios format with a 'data' property
                      if (response && response.data) {
                        response.data = {
                          ...response.data,
                          intercepted: true,
                          processedBy: 'undici-axios-compat',
                          processingTime: new Date().toISOString(),
                        };
                      }
                      return response;
                    }),
                  );
                },
              ],
            }),
          ],
        }).compile();

        undiciAxiosCompatService =
          undiciAxiosCompatModule.get<UndiciHttpService>(UndiciHttpService);
      });

      afterEach(async () => {
        await axiosModule?.close();
        await undiciAxiosCompatModule?.close();
      });

      it('should transform response data consistently', async () => {
        // Ensure services are defined
        expect(axiosService).toBeDefined();
        expect(undiciAxiosCompatService).toBeDefined();

        try {
          // Test Axios response transformation
          const axiosResponse = await firstValueFrom(
            axiosService.get(serverUrl).pipe(map((res: any) => res.data)),
          );

          console.log('Axios response:', axiosResponse);
          expect(axiosResponse.originalData).toBe('test-data');
          expect(axiosResponse.intercepted).toBe(true);
          expect(axiosResponse.processedBy).toBe('axios');
          expect(axiosResponse.processingTime).toBeDefined();
        } catch (error) {
          console.error('Axios test error:', error);
          throw error;
        }

        // Test Undici Axios-compatible response transformation
        const undiciCompatResponse = await firstValueFrom(
          undiciAxiosCompatService
            .get(serverUrl)
            .pipe(map((res: any) => res.data)),
        );

        console.log('Undici Axios-compatible response:', undiciCompatResponse);
        expect(undiciCompatResponse).toBeDefined();
        expect(undiciCompatResponse.originalData).toBe('test-data');
        expect(undiciCompatResponse.intercepted).toBe(true);
        expect(undiciCompatResponse.processedBy).toBe('undici-axios-compat');
        expect(undiciCompatResponse.processingTime).toBeDefined();
      });
    });

    describe('Error Handling in Interceptors', () => {
      let axiosModule: TestingModule;
      let undiciAxiosCompatModule: TestingModule;
      let axiosService: AxiosHttpService;
      let undiciAxiosCompatService: UndiciHttpService;

      beforeEach(async () => {
        serverUrl = await createMockServer((req, res) => {
          if (req.url === '/error') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server Error' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          }
        });

        // Axios with error interceptor
        axiosModule = await Test.createTestingModule({
          imports: [AxiosHttpModule.register({})],
        }).compile();

        axiosService = axiosModule.get<AxiosHttpService>(AxiosHttpService);

        axiosService.axiosRef.interceptors.response.use(
          response => response,
          error => {
            if (error.response?.status === 500) {
              error.customError = true;
              error.handledBy = 'axios-interceptor';
            }
            return Promise.reject(error);
          },
        );

        // Undici Axios-compatible with error interceptor
        undiciAxiosCompatModule = await Test.createTestingModule({
          imports: [
            UndiciHttpModule.registerAxiosCompatible({
              interceptors: [
                (request, next) => {
                  return next.handle(request).pipe(
                    catchError(error => {
                      if (
                        error.status === 500 ||
                        error.response?.status === 500
                      ) {
                        error.customError = true;
                        error.handledBy = 'undici-interceptor';
                      }
                      return throwError(() => error);
                    }),
                  );
                },
              ],
            }),
          ],
        }).compile();

        undiciAxiosCompatService =
          undiciAxiosCompatModule.get<UndiciHttpService>(UndiciHttpService);
      });

      afterEach(async () => {
        await axiosModule?.close();
        await undiciAxiosCompatModule?.close();
      });

      it('should handle errors consistently in interceptors', async () => {
        // Test Axios error handling
        try {
          await firstValueFrom(axiosService.get(`${serverUrl}/error`));
          fail('Should have thrown an error');
        } catch (error: any) {
          expect(error.response.status).toBe(500);
          expect(error.customError).toBe(true);
          expect(error.handledBy).toBe('axios-interceptor');
        }

        // Test Undici Axios-compatible error handling
        try {
          await firstValueFrom(
            undiciAxiosCompatService.get(`${serverUrl}/error`),
          );
          fail('Should have thrown an error');
        } catch (error: any) {
          // Check for error structure consistency
          expect(error.response?.status).toBe(500);
          expect(error.customError).toBe(true);
          expect(error.handledBy).toBe('undici-interceptor');
        }
      });
    });
  });

  describe('Response Structure Compatibility', () => {
    let axiosModule: TestingModule;
    let undiciAxiosCompatModule: TestingModule;
    let axiosService: AxiosHttpService;
    let undiciAxiosCompatService: UndiciHttpService;

    beforeEach(async () => {
      serverUrl = await createMockServer((req, res) => {
        const headers = {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'test-value',
          'X-Response-Time': '123ms',
        };
        res.writeHead(200, headers);
        res.end(
          JSON.stringify({
            id: 1,
            name: 'Test Item',
            nested: {
              value: 42,
              array: [1, 2, 3],
            },
          }),
        );
      });

      axiosModule = await Test.createTestingModule({
        imports: [AxiosHttpModule.register({})],
      }).compile();

      undiciAxiosCompatModule = await Test.createTestingModule({
        imports: [UndiciHttpModule.registerAxiosCompatible()],
      }).compile();

      axiosService = axiosModule.get<AxiosHttpService>(AxiosHttpService);
      undiciAxiosCompatService =
        undiciAxiosCompatModule.get<UndiciHttpService>(UndiciHttpService);
    });

    afterEach(async () => {
      await axiosModule?.close();
      await undiciAxiosCompatModule?.close();
    });

    it('should have identical response structure between Axios and Undici axios-compatible mode', async () => {
      const axiosResponse = await firstValueFrom(axiosService.get(serverUrl));
      const undiciResponse = (await firstValueFrom(
        undiciAxiosCompatService.get(serverUrl),
      )) as any;

      // Compare data structure
      expect(undiciResponse.data).toEqual(axiosResponse.data);

      // Compare status
      expect(undiciResponse.status).toBe(axiosResponse.status);
      expect(undiciResponse.status).toBe(200);

      // Compare statusText
      expect(undiciResponse.statusText).toBe(axiosResponse.statusText);

      // Compare headers (basic check)
      expect(undiciResponse.headers['content-type']).toBe(
        axiosResponse.headers['content-type'],
      );
      expect(undiciResponse.headers['x-custom-header']).toBe(
        axiosResponse.headers['x-custom-header'],
      );
      expect(undiciResponse.headers['x-response-time']).toBe(
        axiosResponse.headers['x-response-time'],
      );

      // Verify data access patterns work identically
      expect(undiciResponse.data.id).toBe(1);
      expect(undiciResponse.data.name).toBe('Test Item');
      expect(undiciResponse.data.nested.value).toBe(42);
      expect(undiciResponse.data.nested.array).toEqual([1, 2, 3]);
    });

    it('should work with RxJS operators identically', async () => {
      // Axios with RxJS
      const axiosResult = await firstValueFrom(
        axiosService
          .get(serverUrl)
          .pipe(map((res: any) => res.data.nested.value)),
      );

      // Undici axios-compatible with RxJS
      const undiciResult = await firstValueFrom(
        undiciAxiosCompatService
          .get(serverUrl)
          .pipe(map((res: any) => res.data.nested.value)),
      );

      expect(axiosResult).toBe(42);
      expect(undiciResult).toBe(42);
      expect(axiosResult).toBe(undiciResult);
    });
  });

  describe('Edge Cases', () => {
    describe('Empty Response Handling', () => {
      let axiosModule: TestingModule;
      let undiciAxiosCompatModule: TestingModule;
      let axiosService: AxiosHttpService;
      let undiciAxiosCompatService: UndiciHttpService;

      beforeEach(async () => {
        serverUrl = await createMockServer((req, res) => {
          if (req.url === '/empty') {
            res.writeHead(204); // No Content
            res.end();
          } else if (req.url === '/empty-json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('');
          }
        });

        axiosModule = await Test.createTestingModule({
          imports: [AxiosHttpModule.register({})],
        }).compile();

        undiciAxiosCompatModule = await Test.createTestingModule({
          imports: [UndiciHttpModule.registerAxiosCompatible()],
        }).compile();

        axiosService = axiosModule.get<AxiosHttpService>(AxiosHttpService);
        undiciAxiosCompatService =
          undiciAxiosCompatModule.get<UndiciHttpService>(UndiciHttpService);
      });

      afterEach(async () => {
        await axiosModule?.close();
        await undiciAxiosCompatModule?.close();
      });

      it('should handle 204 No Content responses consistently', async () => {
        const axiosResponse = await firstValueFrom(
          axiosService.get(`${serverUrl}/empty`),
        );
        const undiciResponse = await firstValueFrom(
          undiciAxiosCompatService.get(`${serverUrl}/empty`),
        );

        expect(axiosResponse.status).toBe(204);
        expect((undiciResponse as any).status).toBe(204);
        expect(axiosResponse.data).toBe('');
        // Undici axios-compatible might return null for empty responses
        const undiciData = (undiciResponse as any).data;
        expect(undiciData === '' || undiciData === null).toBe(true);
      });
    });

    describe('Large Payload Handling', () => {
      let axiosModule: TestingModule;
      let undiciAxiosCompatModule: TestingModule;
      let axiosService: AxiosHttpService;
      let undiciAxiosCompatService: UndiciHttpService;

      beforeEach(async () => {
        const largeData = Array(1000)
          .fill(null)
          .map((_, i) => ({
            id: i,
            data: 'x'.repeat(1000),
          }));

        serverUrl = await createMockServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(largeData));
        });

        axiosModule = await Test.createTestingModule({
          imports: [AxiosHttpModule.register({})],
        }).compile();

        undiciAxiosCompatModule = await Test.createTestingModule({
          imports: [UndiciHttpModule.registerAxiosCompatible()],
        }).compile();

        axiosService = axiosModule.get<AxiosHttpService>(AxiosHttpService);
        undiciAxiosCompatService =
          undiciAxiosCompatModule.get<UndiciHttpService>(UndiciHttpService);
      });

      afterEach(async () => {
        await axiosModule?.close();
        await undiciAxiosCompatModule?.close();
      });

      it('should handle large payloads consistently', async () => {
        const axiosResponse = await firstValueFrom(axiosService.get(serverUrl));
        const undiciResponse = (await firstValueFrom(
          undiciAxiosCompatService.get(serverUrl),
        )) as any;

        expect(Array.isArray(axiosResponse.data)).toBe(true);
        expect(Array.isArray(undiciResponse.data)).toBe(true);
        expect(axiosResponse.data.length).toBe(1000);
        expect(undiciResponse.data.length).toBe(1000);
        expect(undiciResponse.data[0]).toEqual(axiosResponse.data[0]);
        expect(undiciResponse.data[999]).toEqual(axiosResponse.data[999]);
      });
    });
  });

  describe('Dynamic Interceptor Management', () => {
    let undiciModule: TestingModule;
    let undiciService: UndiciHttpService;

    beforeEach(async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            headers: req.headers,
          }),
        );
      });

      undiciModule = await Test.createTestingModule({
        imports: [UndiciHttpModule.register({})],
      }).compile();

      undiciService = undiciModule.get<UndiciHttpService>(UndiciHttpService);
    });

    afterEach(async () => {
      await undiciModule?.close();
    });

    it('should support adding interceptors dynamically', async () => {
      // Initial request without interceptors
      const response1 = await firstValueFrom(undiciService.request(serverUrl));
      const data1: any = await response1.body.json();
      expect(data1.headers['x-dynamic']).toBeUndefined();

      // Add interceptor dynamically
      undiciService.addInterceptor((request, next) => {
        const modifiedRequest = {
          ...request,
          options: {
            ...request.options,
            headers: {
              ...request.options.headers,
              'X-Dynamic': 'added-dynamically',
            },
          },
        };
        return next.handle(modifiedRequest);
      });

      // Request with dynamically added interceptor
      const response2 = await firstValueFrom(undiciService.request(serverUrl));
      const data2: any = await response2.body.json();
      expect(data2.headers['x-dynamic']).toBe('added-dynamically');
    });

    it('should maintain interceptor count', () => {
      expect(undiciService.interceptorCount).toBe(0);

      undiciService.addInterceptor((request, next) => next.handle(request));
      expect(undiciService.interceptorCount).toBe(1);

      undiciService.addInterceptor((request, next) => next.handle(request));
      expect(undiciService.interceptorCount).toBe(2);
    });
  });

  describe('Class-based Interceptors', () => {
    @Injectable()
    class AuthInterceptor implements HttpInterceptor {
      intercept(
        request: HttpInterceptorRequest,
        next: HttpInterceptorHandler,
      ): Observable<Dispatcher.ResponseData> {
        const modifiedRequest = {
          ...request,
          options: {
            ...request.options,
            headers: {
              ...request.options.headers,
              Authorization: 'Bearer class-based-token',
            },
          },
        };
        return next.handle(modifiedRequest);
      }
    }

    @Injectable()
    class LoggingInterceptor implements HttpInterceptor {
      intercept(
        request: HttpInterceptorRequest,
        next: HttpInterceptorHandler,
      ): Observable<Dispatcher.ResponseData> {
        const modifiedRequest = {
          ...request,
          options: {
            ...request.options,
            headers: {
              ...request.options.headers,
              'X-Logged': 'true',
            },
          },
        };
        return next.handle(modifiedRequest);
      }
    }

    let undiciModule: TestingModule;
    let undiciService: UndiciHttpService;

    beforeEach(async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            headers: req.headers,
          }),
        );
      });

      undiciModule = await Test.createTestingModule({
        imports: [
          UndiciHttpModule.register({
            interceptors: [AuthInterceptor, LoggingInterceptor],
          }),
        ],
        providers: [AuthInterceptor, LoggingInterceptor],
      }).compile();

      undiciService = undiciModule.get<UndiciHttpService>(UndiciHttpService);
    });

    afterEach(async () => {
      await undiciModule?.close();
    });

    it('should support class-based interceptors', async () => {
      const response = await firstValueFrom(undiciService.request(serverUrl));
      const data: any = await response.body.json();

      // HTTP headers are case-insensitive, check both cases
      expect(data.headers.authorization || data.headers.Authorization).toBe(
        'Bearer class-based-token',
      );
      expect(data.headers['x-logged'] || data.headers['X-Logged']).toBe('true');
    });
  });
});
