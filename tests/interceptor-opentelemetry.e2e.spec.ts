import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule, HttpService } from '../src';
import {
  context,
  propagation,
  trace,
  SpanContext,
  TraceFlags,
} from '@opentelemetry/api';
import { firstValueFrom } from 'rxjs';
import { AddressInfo } from 'net';
import * as http from 'http';
import * as https from 'https';

// Mock OpenTelemetry APIs
jest.mock('@opentelemetry/api', () => ({
  context: {
    active: jest.fn(),
  },
  propagation: {
    inject: jest.fn(),
  },
  trace: {
    wrapSpanContext: jest.fn(),
    setSpan: jest.fn(),
  },
  TraceFlags: {
    SAMPLED: 1,
  },
}));

// Example HttpConfigModule that would be used in a real application
class HttpConfigModule {
  public static forRoot(config?: any) {
    const httpModule = HttpModule.register({
      timeout: config?.timeout ?? 5000,
      maxRedirects: config?.maxRedirects ?? 5,
      httpAgent: new http.Agent({
        keepAlive: config?.keepAlive ?? true,
      }),
      httpsAgent: new https.Agent({
        keepAlive: config?.keepAlive ?? true,
      }),
    });

    return {
      module: HttpConfigModule,
      imports: [httpModule],
      exports: [httpModule],
      providers: [
        {
          provide: 'HTTP_CONFIG_INIT',
          useFactory: (httpService: HttpService) => {
            // Add OpenTelemetry interceptor
            httpService.addInterceptor((request, next) => {
              const headers: Record<string, string> = {};
              propagation.inject(context.active(), headers);

              const modifiedRequest = {
                ...request,
                options: {
                  ...request.options,
                  headers: {
                    ...request.options.headers,
                    ...headers,
                  },
                },
              };

              return next.handle(modifiedRequest);
            });
            return true;
          },
          inject: [HttpService],
        },
      ],
    };
  }
}

describe('OpenTelemetry Interceptor Integration', () => {
  let module: TestingModule;
  let httpService: HttpService;

  beforeEach(async () => {
    jest.clearAllMocks();

    module = await Test.createTestingModule({
      imports: [HttpConfigModule.forRoot()],
    }).compile();

    httpService = module.get<HttpService>(HttpService);

    // Ensure the initialization runs
    module.get('HTTP_CONFIG_INIT');
  });

  afterEach(async () => {
    await module.close();
  });

  describe('when making HTTP requests with OpenTelemetry context', () => {
    let server: http.Server;
    let baseUrl: string;
    let receivedHeaders: http.IncomingHttpHeaders | undefined;

    beforeEach(async () => {
      receivedHeaders = undefined;
      // Mock HTTP server that records the headers it receives
      server = http.createServer((req, res) => {
        receivedHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('success');
      });
      await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as AddressInfo).port;
          baseUrl = `http://127.0.0.1:${port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    });

    it('should inject trace context headers into the request', async () => {
      // Setup OpenTelemetry mocks
      const mockContext = { span: 'mock-span' };
      (context.active as jest.Mock).mockReturnValue(mockContext);

      (propagation.inject as jest.Mock).mockImplementation((ctx, carrier) => {
        carrier['traceparent'] =
          '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
        carrier['tracestate'] = 'vendor1=value1';
      });

      // Make request with custom headers
      const response = await firstValueFrom(
        httpService.request(baseUrl, {
          method: 'GET',
          headers: {
            'x-custom-header': 'custom-value',
          },
        }),
      );

      expect(response.data).toBe('success');
      expect(receivedHeaders?.['traceparent']).toBe(
        '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      );
      expect(receivedHeaders?.['tracestate']).toBe('vendor1=value1');
      expect(receivedHeaders?.['x-custom-header']).toBe('custom-value');

      // Verify OpenTelemetry APIs were called
      expect(context.active).toHaveBeenCalled();
      expect(propagation.inject).toHaveBeenCalledWith(
        mockContext,
        expect.any(Object),
      );
    });

    it('should handle requests without existing headers', async () => {
      // Setup OpenTelemetry mocks
      (context.active as jest.Mock).mockReturnValue({});
      (propagation.inject as jest.Mock).mockImplementation((ctx, carrier) => {
        carrier['traceparent'] = '00-trace-id-span-id-01';
      });

      // Make request without custom headers
      await firstValueFrom(httpService.request(baseUrl));

      expect(receivedHeaders?.['traceparent']).toBe('00-trace-id-span-id-01');
    });

    it('should work when no trace context is available', async () => {
      // Setup OpenTelemetry mocks - no trace context
      (context.active as jest.Mock).mockReturnValue({});
      (propagation.inject as jest.Mock).mockImplementation(() => {
        // Do nothing - no active trace
      });

      await firstValueFrom(
        httpService.request(baseUrl, {
          headers: {
            authorization: 'Bearer token',
          },
        }),
      );

      // Should still have original headers
      expect(receivedHeaders?.['authorization']).toBe('Bearer token');
      // But no trace headers
      expect(receivedHeaders?.['traceparent']).toBeUndefined();
    });
  });

  describe('interceptor count', () => {
    it('should have one interceptor after initialization (OpenTelemetry)', () => {
      // `interceptorCount` is the real module-registered count now (plan.md
      // phase 3 "HttpService members") - just the OpenTelemetry interceptor
      // registered from `onModuleInit`, no phantom "axios adapter" entry.
      expect(httpService.interceptorCount).toBe(1);
    });
  });
});
