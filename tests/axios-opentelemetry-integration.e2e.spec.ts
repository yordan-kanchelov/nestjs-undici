import { Test, TestingModule } from '@nestjs/testing';
import { AxiosHeaders, HttpModule, HttpService } from '../src';
import { DynamicModule, Global, Module, OnModuleInit } from '@nestjs/common';
import { context, propagation } from '@opentelemetry/api';
import * as http from 'http';
import * as https from 'https';
import { firstValueFrom } from 'rxjs';

// Mock OpenTelemetry APIs
jest.mock('@opentelemetry/api', () => ({
  context: {
    active: jest.fn(),
  },
  propagation: {
    inject: jest.fn(),
  },
}));

type HttpConfig = {
  timeout?: number;
  maxRedirects?: number;
  keepAlive?: boolean;
  keepAliveMilliseconds?: number;
  maxSockets?: number;
  maxFreeSockets?: number;
};

@Global()
@Module({})
class HttpConfigModule implements OnModuleInit {
  private static httpAgent: http.Agent;
  private static httpsAgent: https.Agent;

  public static forRoot(config?: HttpConfig): DynamicModule {
    // Create agents and store references for cleanup
    this.httpAgent = new http.Agent({
      keepAlive: config?.keepAlive ?? true,
      // keepAliveMsecs: config?.keepAliveMilliseconds ?? 5000,
      // maxSockets: config?.maxSockets ?? 2000,
      // maxFreeSockets: config?.maxFreeSockets ?? 200,
    });

    this.httpsAgent = new https.Agent({
      keepAlive: config?.keepAlive ?? true,
      // keepAliveMsecs: config?.keepAliveMilliseconds ?? 5000,
      // maxSockets: config?.maxSockets ?? 2000,
      // maxFreeSockets: config?.maxFreeSockets ?? 200,
    });

    const httpModule = HttpModule.register({
      timeout: config?.timeout ?? 5000,
      maxRedirects: config?.maxRedirects ?? 5,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
    });

    return {
      module: HttpConfigModule,
      imports: [httpModule],
      exports: [httpModule],
    };
  }

  public static cleanup() {
    // Destroy agents to close keepAlive connections
    if (this.httpAgent) {
      this.httpAgent.destroy();
    }
    if (this.httpsAgent) {
      this.httpsAgent.destroy();
    }
  }

  private readonly httpService: HttpService;

  constructor(httpService: HttpService) {
    this.httpService = httpService;
  }

  public onModuleInit() {
    // Add Axios interceptor to inject OpenTelemetry trace context
    this.httpService.axiosRef.interceptors.request.use(config => {
      // Inject OpenTelemetry trace context into headers
      const headers: Record<string, string> = {};

      propagation.inject(context.active(), headers);

      Object.entries(headers).forEach(([key, value]) => {
        if (config.headers && typeof config.headers.set === 'function') {
          config.headers.set(key, value);
        } else if (config.headers) {
          // Fallback for different header types
          (config.headers as Record<string, string>)[key] = value;
        }
      });

      return config;
    });
  }
}

describe('Axios-style OpenTelemetry Integration (Real Example)', () => {
  let app: TestingModule;
  let httpService: HttpService;
  let server: http.Server;
  let serverPort: number;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Create test server
    server = http.createServer((req, res) => {
      // Capture all headers
      const headers = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          headers: headers,
          url: req.url,
          method: req.method,
        }),
      );
    });

    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = (server.address() as any).port;
        resolve();
      });
    });

    // Create NestJS module with keepAlive disabled for tests
    app = await Test.createTestingModule({
      imports: [HttpConfigModule.forRoot({ keepAlive: false })],
    }).compile();

    httpService = app.get<HttpService>(HttpService);

    // Trigger onModuleInit
    await app.init();
  });

  afterEach(async () => {
    // Close server with proper cleanup
    await new Promise<void>((resolve, reject) => {
      server.close(err => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Close NestJS app
    await app.close();

    // Cleanup HTTP agents to close keepAlive connections
    HttpConfigModule.cleanup();

    // Clear all timers
    jest.clearAllTimers();
  });

  describe('OpenTelemetry header injection via axiosRef', () => {
    it('should inject trace headers using AxiosHeaders.set() method', async () => {
      // Setup OpenTelemetry mocks
      const mockContext = { span: 'test-span' };
      (context.active as jest.Mock).mockReturnValue(mockContext);

      (propagation.inject as jest.Mock).mockImplementation((ctx, carrier) => {
        carrier['traceparent'] =
          '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
        carrier['tracestate'] = 'vendor1=value1,vendor2=value2';
        carrier['baggage'] = 'key1=value1,key2=value2';
      });

      // Make request with existing headers
      const response = await firstValueFrom(
        httpService.get(`http://127.0.0.1:${serverPort}/test`, {
          headers: {
            Authorization: 'Bearer my-token',
            'X-Custom-Header': 'custom-value',
          },
        }),
      );
      const receivedHeaders = response.data.headers;

      // Verify OpenTelemetry headers were injected
      expect(receivedHeaders['traceparent']).toBe(
        '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      );
      expect(receivedHeaders['tracestate']).toBe(
        'vendor1=value1,vendor2=value2',
      );
      expect(receivedHeaders['baggage']).toBe('key1=value1,key2=value2');

      // Verify original headers are preserved
      expect(receivedHeaders['authorization']).toBe('Bearer my-token');
      expect(receivedHeaders['x-custom-header']).toBe('custom-value');

      // Verify OpenTelemetry APIs were called
      expect(context.active).toHaveBeenCalled();
      expect(propagation.inject).toHaveBeenCalledWith(
        mockContext,
        expect.any(Object),
      );
    });

    it('should handle headers when no existing headers are present', async () => {
      // Setup OpenTelemetry mocks
      (context.active as jest.Mock).mockReturnValue({});
      (propagation.inject as jest.Mock).mockImplementation((ctx, carrier) => {
        carrier['traceparent'] = '00-trace-span-01';
      });

      const response = await firstValueFrom(
        httpService.post(`http://127.0.0.1:${serverPort}/api/data`, {
          data: 'test',
        }),
      );
      const receivedHeaders = response.data.headers;

      // Verify trace header was added
      expect(receivedHeaders['traceparent']).toBe('00-trace-span-01');

      // Verify content-type header is present (added by post method)
      expect(receivedHeaders['content-type']).toBe('application/json');
    });

    it('should handle multiple interceptor registrations', async () => {
      let interceptorCallCount = 0;

      // Add another interceptor
      httpService.axiosRef.interceptors.request.use(config => {
        interceptorCallCount++;
        if (config.headers && typeof config.headers.set === 'function') {
          config.headers.set(
            'X-Interceptor-Count',
            String(interceptorCallCount),
          );
        }
        return config;
      });

      // Setup OpenTelemetry mocks
      (context.active as jest.Mock).mockReturnValue({});
      (propagation.inject as jest.Mock).mockImplementation((ctx, carrier) => {
        carrier['traceparent'] = '00-multi-interceptor-01';
      });

      const response = await firstValueFrom(
        httpService.get(`http://127.0.0.1:${serverPort}/multi`),
      );
      const receivedHeaders = response.data.headers;

      // Both interceptors should have run
      expect(receivedHeaders['traceparent']).toBe('00-multi-interceptor-01');
      expect(receivedHeaders['x-interceptor-count']).toBe('1');
      expect(interceptorCallCount).toBe(1);
    });

    it('should properly handle error scenarios in interceptors', async () => {
      // Add an interceptor that throws an error
      httpService.axiosRef.interceptors.request.use(
        () => {
          throw new Error('Interceptor error');
        },
        error => {
          // Error handler
          return Promise.reject(error);
        },
      );

      await expect(
        firstValueFrom(
          httpService.get(`http://127.0.0.1:${serverPort}/error-test`),
        ),
      ).rejects.toThrow('Interceptor error');
    });

    it('should support async interceptors', async () => {
      // Add async interceptor
      httpService.axiosRef.interceptors.request.use(async config => {
        // Simulate async operation with a small delay
        await new Promise(resolve => setTimeout(resolve, 10));

        if (config.headers && typeof config.headers.set === 'function') {
          config.headers.set('X-Async-Header', 'async-value');
        }
        return config;
      });

      // Setup OpenTelemetry mocks
      (context.active as jest.Mock).mockReturnValue({});
      (propagation.inject as jest.Mock).mockImplementation((ctx, carrier) => {
        carrier['traceparent'] = '00-async-test-01';
      });

      const response = await firstValueFrom(
        httpService.get(`http://127.0.0.1:${serverPort}/async`),
      );
      const receivedHeaders = response.data.headers;

      // Both headers should be present
      expect(receivedHeaders['traceparent']).toBe('00-async-test-01');
      expect(receivedHeaders['x-async-header']).toBe('async-value');
    });

    it('should handle AxiosHeaders instance in config', async () => {
      // Create AxiosHeaders instance
      const headers = new AxiosHeaders();
      headers.set('X-Test', 'test-value');
      headers.set('Authorization', 'Bearer token');

      // Setup OpenTelemetry mocks
      (context.active as jest.Mock).mockReturnValue({});
      (propagation.inject as jest.Mock).mockImplementation((ctx, carrier) => {
        carrier['traceparent'] = '00-axios-headers-test-01';
      });

      // Convert AxiosHeaders to plain object for the request (no forEach()
      // on AxiosHeaders - see axios-headers.ts - toJSON() already excludes
      // null/undefined/false values).
      const plainHeaders: Record<string, string> = headers.toJSON();

      const response = await firstValueFrom(
        httpService.get(`http://127.0.0.1:${serverPort}/axios-headers`, {
          headers: plainHeaders,
        }),
      );
      const receivedHeaders = response.data.headers;

      // All headers should be present
      expect(receivedHeaders['x-test']).toBe('test-value');
      expect(receivedHeaders['authorization']).toBe('Bearer token');
      expect(receivedHeaders['traceparent']).toBe('00-axios-headers-test-01');
    });

    it('interceptorCount only counts module-registered interceptors, not axiosRef ones', () => {
      // `onModuleInit` above registers its OpenTelemetry interceptor through
      // `axiosRef.interceptors.request.use()`, a separate chain from the
      // module-registered (`HttpInterceptor`) one `interceptorCount` reports
      // (plan.md phase 3 "HttpService members": `interceptorCount` "returns
      // the real count" - of `this.interceptors`, the same array
      // `addInterceptor()`/module `interceptors` populate; axiosRef has no
      // equivalent "how many interceptors are registered" property either,
      // exactly like real axios).
      expect(httpService.interceptorCount).toBe(0);
    });

    it('should add a custom header via interceptor and verify it', async () => {
      // Add a custom interceptor to prove it's working
      httpService.axiosRef.interceptors.request.use(config => {
        if (config.headers) {
          config.headers['X-Custom-Test-Header'] = 'interceptor-is-active';
        }
        return config;
      });

      // Make a request
      const response = await firstValueFrom(
        httpService.get(
          `http://127.0.0.1:${serverPort}/interceptor-verification`,
        ),
      );
      const receivedHeaders = response.data.headers;

      // Assert that the server received the header from our interceptor
      expect(receivedHeaders['x-custom-test-header']).toBe(
        'interceptor-is-active',
      );
    });
  });

  describe('Real-world usage patterns', () => {
    it('should work with complex OpenTelemetry propagation scenarios', async () => {
      // Simulate complex trace context
      const mockContext = {
        span: 'complex-span',
        baggage: { userId: '12345', sessionId: 'abc-def' },
      };
      (context.active as jest.Mock).mockReturnValue(mockContext);

      (propagation.inject as jest.Mock).mockImplementation((ctx, carrier) => {
        // Simulate W3C Trace Context + Baggage propagation
        carrier['traceparent'] =
          '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
        carrier['tracestate'] = 'rojo=00f067aa0ba902b7,congo=t61rcWkgMzE';
        carrier['baggage'] = 'userId=12345,sessionId=abc-def';
      });

      const response = await firstValueFrom(
        httpService.post(
          `http://127.0.0.1:${serverPort}/api/trace`,
          { action: 'test', timestamp: Date.now() },
          {
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-Request-ID': 'req-123',
            },
          },
        ),
      );
      const receivedHeaders = response.data.headers;

      // Verify all headers are properly set
      expect(receivedHeaders['traceparent']).toBe(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      );
      expect(receivedHeaders['tracestate']).toBe(
        'rojo=00f067aa0ba902b7,congo=t61rcWkgMzE',
      );
      expect(receivedHeaders['baggage']).toBe('userId=12345,sessionId=abc-def');
      expect(receivedHeaders['x-request-id']).toBe('req-123');
      expect(receivedHeaders['content-type']).toBe('application/json');
      expect(receivedHeaders['accept']).toBe('application/json');
    });

    it('should handle no active trace context gracefully', async () => {
      // No active context
      (context.active as jest.Mock).mockReturnValue(null);
      (propagation.inject as jest.Mock).mockImplementation(() => {
        // No-op - no active trace
      });

      const response = await firstValueFrom(
        httpService.get(`http://127.0.0.1:${serverPort}/no-trace`),
      );
      const receivedHeaders = response.data.headers;

      // Should not have trace headers
      expect(receivedHeaders['traceparent']).toBeUndefined();
      expect(receivedHeaders['tracestate']).toBeUndefined();

      // But request should still work
      expect(response.data.success).toBe(true);
    });
  });
});
