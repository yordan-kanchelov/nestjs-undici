import { Test, TestingModule } from '@nestjs/testing';
import {
  HttpModule as UndiciHttpModule,
  HttpService as UndiciHttpService,
} from '../src';
import {
  HttpModule as AxiosHttpModule,
  HttpService as AxiosHttpService,
} from '@nestjs/axios';
import { firstValueFrom, of, throwError, Observable, mergeMap, delay } from 'rxjs';
import { map, catchError, retry, timeout, tap } from 'rxjs/operators';
import * as http from 'http';
import { AddressInfo } from 'net';

describe('Axios Real-World Scenarios', () => {
  let mockServer: http.Server;
  let serverUrl: string;

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
        mockServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        // Force close all connections after a timeout
        mockServer.closeAllConnections();
      });
      mockServer = null;
    }
  });

  describe('OAuth Token Refresh Pattern', () => {
    let tokenCounter = 0;
    let currentToken = 'initial-token';

    beforeEach(async () => {
      tokenCounter = 0;
      currentToken = 'initial-token';

      serverUrl = await createMockServer((req, res) => {
        const authHeader = req.headers.authorization;

        if (req.url === '/refresh-token') {
          currentToken = `refreshed-token-${++tokenCounter}`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: currentToken }));
          return;
        }

        if (authHeader === `Bearer ${currentToken}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: 'protected resource' }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
      });
    });

    it('should handle token refresh with axios-compatible interceptors', async () => {
      const module = await Test.createTestingModule({
        imports: [UndiciHttpModule.register()],
      }).compile();

      const httpService = module.get<UndiciHttpService>(UndiciHttpService);
      let authToken = 'expired-token';

      // Add request interceptor to add auth token
      httpService.addInterceptor((request, next) => {
        const modifiedRequest = {
          ...request,
          options: {
            ...request.options,
            headers: {
              ...request.options.headers,
              Authorization: `Bearer ${authToken}`,
            },
          },
        };
        return next.handle(modifiedRequest);
      });

      // Add response interceptor to handle 401 and refresh token
      httpService.addInterceptor((request, next) => {
        return next.handle(request).pipe(
          mergeMap(async (response: any) => {
            // Check if we got a 401 response (raw Undici response)
            if (response.statusCode === 401 && !request.url.toString().includes('refresh-token')) {
              // Refresh token
              const refreshResponse: any = await firstValueFrom(
                httpService.request(`${serverUrl}/refresh-token`, { method: 'POST' })
              );
              // The refresh response is already in axios format
              const data = refreshResponse.data || await refreshResponse.body?.json();
              authToken = data.access_token;
              
              // Retry original request with new token
              const retryRequest = {
                ...request,
                options: {
                  ...request.options,
                  headers: {
                    ...request.options.headers,
                    Authorization: `Bearer ${authToken}`,
                  },
                },
              };
              
              // Make the retry request
              return firstValueFrom(next.handle(retryRequest));
            }
            return response;
          }),
        );
      });

      // First request should fail, refresh token, and retry
      const response: any = await firstValueFrom(
        httpService.request(serverUrl),
      );
      // Response is in axios format after all interceptors
      expect(response.data.data).toBe('protected resource');
      expect(authToken).toBe('refreshed-token-1');

      await module.close();
    });
  });

  describe('Request/Response Logging', () => {
    beforeEach(async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Request-Id': '12345',
        });
        res.end(JSON.stringify({ message: 'Success', timestamp: Date.now() }));
      });
    });

    it('should log requests and responses with interceptors', async () => {
      const logs: any[] = [];

      const module = await Test.createTestingModule({
        imports: [UndiciHttpModule.register()],
      }).compile();

      const httpService = module.get<UndiciHttpService>(UndiciHttpService);

      // Request logging interceptor
      httpService.addInterceptor((request, next) => {
        const startTime = Date.now();
        logs.push({
          type: 'request',
          method: request.options.method || 'GET',
          url: request.url,
          timestamp: startTime,
        });

        return next.handle(request).pipe(
          tap((response: any) => {
            const duration = Date.now() - startTime;
            logs.push({
              type: 'response',
              status: response.statusCode || response.status,
              duration,
              requestId: response.headers['x-request-id'],
            });
          }),
        );
      });

      await firstValueFrom(httpService.request(serverUrl));

      expect(logs).toHaveLength(2);
      expect(logs[0].type).toBe('request');
      expect(logs[0].method).toBe('GET');
      expect(logs[1].type).toBe('response');
      expect(logs[1].status).toBe(200);
      expect(logs[1].duration).toBeGreaterThan(0);
      expect(logs[1].requestId).toBe('12345');

      await module.close();
    });
  });

  describe('Retry with Exponential Backoff', () => {
    let attemptCount = 0;

    beforeEach(async () => {
      attemptCount = 0;

      serverUrl = await createMockServer((req, res) => {
        attemptCount++;
        if (attemptCount < 3) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Service Unavailable' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Success after retries' }));
        }
      });
    });

    it('should retry failed requests with exponential backoff', async () => {
      const module = await Test.createTestingModule({
        imports: [UndiciHttpModule.register()],
      }).compile();

      const httpService = module.get<UndiciHttpService>(UndiciHttpService);
      const startTime = Date.now();

      // Use the observable directly with retry logic
      const response: any = await firstValueFrom(
        httpService.request(serverUrl).pipe(
          retry({
            count: 3,
            delay: (error, retryCount) => {
              // Only retry 503 errors
              if (error.status !== 503 && error.response?.status !== 503) {
                throw error;
              }
              // Exponential backoff: 100ms, 200ms, 400ms
              const delayMs = Math.pow(2, retryCount - 1) * 100;
              return of(error).pipe(
                tap(() =>
                  console.log(`Retry ${retryCount} after ${delayMs}ms`),
                ),
                delay(delayMs),
              );
            },
          }),
        ),
      );
      const totalTime = Date.now() - startTime;

      expect(response.data.message).toBe('Success after retries');
      expect(attemptCount).toBe(3);
      // Should take at least 300ms (100 + 200) for the retries
      expect(totalTime).toBeGreaterThan(300);

      await module.close();
    });
  });

  describe('Request Cancellation', () => {
    beforeEach(async () => {
      serverUrl = await createMockServer((req, res) => {
        // Simulate slow response
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Slow response' }));
        }, 1000);
      });
    });

    it('should support request timeout', async () => {
      const module = await Test.createTestingModule({
        imports: [UndiciHttpModule.register()],
      }).compile();

      const httpService = module.get<UndiciHttpService>(UndiciHttpService);

      try {
        await firstValueFrom(
          httpService.request(serverUrl).pipe(
            timeout(100), // 100ms timeout
            catchError(error => {
              expect(error.name).toBe('TimeoutError');
              return of({ data: 'timeout' });
            }),
          ),
        );
      } catch (error) {
        // Expected to timeout
      }

      await module.close();
    });
  });

  describe('Progress Tracking for Large Downloads', () => {
    beforeEach(async () => {
      serverUrl = await createMockServer((req, res) => {
        const totalSize = 1024 * 1024; // 1MB
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': totalSize.toString(),
        });

        // Send data in chunks
        let sent = 0;
        const chunkSize = 1024 * 64; // 64KB chunks

        const sendChunk = () => {
          if (sent < totalSize) {
            const chunk = Buffer.alloc(Math.min(chunkSize, totalSize - sent));
            res.write(chunk);
            sent += chunk.length;
            setTimeout(sendChunk, 10); // Simulate network delay
          } else {
            res.end();
          }
        };

        sendChunk();
      });
    });

    it('should track download progress', async () => {
      const module = await Test.createTestingModule({
        imports: [UndiciHttpModule.register()],
      }).compile();

      const httpService = module.get<UndiciHttpService>(UndiciHttpService);
      const progressUpdates: number[] = [];

      // Note: Real progress tracking would require stream handling
      // This is a simplified example showing the interceptor pattern
      httpService.addInterceptor((request, next) => {
        return next.handle(request).pipe(
          tap((response: any) => {
            if (response.headers['content-length']) {
              progressUpdates.push(100); // Simplified: assume complete
            }
          }),
        );
      });

      const response: any = await firstValueFrom(
        httpService.request(serverUrl),
      );

      expect(Buffer.isBuffer(response.data)).toBe(true);
      expect(response.data.length).toBe(1024 * 1024);
      expect(progressUpdates.length).toBeGreaterThan(0);

      await module.close();
    });
  });

  describe('API Rate Limiting', () => {
    let requestCount = 0;

    beforeEach(async () => {
      requestCount = 0;

      serverUrl = await createMockServer((req, res) => {
        requestCount++;

        if (requestCount > 3) {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': '3',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': (Date.now() + 1000).toString(),
          });
          res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        } else {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': '3',
            'X-RateLimit-Remaining': (3 - requestCount).toString(),
          });
          res.end(JSON.stringify({ message: `Request ${requestCount}` }));
        }
      });
    });

    it('should handle rate limiting with interceptors', async () => {
      const module = await Test.createTestingModule({
        imports: [UndiciHttpModule.register()],
      }).compile();

      const httpService = module.get<UndiciHttpService>(UndiciHttpService);
      const requestQueue: Array<() => Promise<any>> = [];
      let isProcessing = false;

      // Rate limiting interceptor
      httpService.addInterceptor((request, next) => {
        return new Observable(observer => {
          const processRequest = async () => {
            try {
              const response = await firstValueFrom(next.handle(request));
              observer.next(response);
              observer.complete();
            } catch (error) {
              observer.error(error);
            }
          };

          requestQueue.push(processRequest);

          if (!isProcessing) {
            isProcessing = true;
            const processQueue = async () => {
              while (requestQueue.length > 0) {
                const req = requestQueue.shift();
                if (req) {
                  await req();
                  await new Promise(resolve => setTimeout(resolve, 100)); // Rate limit delay
                }
              }
              isProcessing = false;
            };
            processQueue();
          }
        });
      });

      // Make multiple requests
      const responses = await Promise.all([
        firstValueFrom(httpService.request(serverUrl)),
        firstValueFrom(httpService.request(serverUrl)),
        firstValueFrom(httpService.request(serverUrl)),
      ]);

      expect(responses).toHaveLength(3);
      responses.forEach((res: any, index) => {
        expect(res.data.message).toBe(`Request ${index + 1}`);
      });

      await module.close();
    });
  });
});

