import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule, HttpService } from '../src';
import { context, propagation, trace, SpanContext, TraceFlags } from '@opentelemetry/api';
import { of } from 'rxjs';
import * as http from 'http';
import * as https from 'https';

// Mock OpenTelemetry APIs
jest.mock('@opentelemetry/api', () => ({
  context: {
    active: jest.fn()
  },
  propagation: {
    inject: jest.fn()
  },
  trace: {
    wrapSpanContext: jest.fn(),
    setSpan: jest.fn()
  },
  TraceFlags: {
    SAMPLED: 1
  }
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
        }
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
    it('should inject trace context headers into the request', (done) => {
      // Setup OpenTelemetry mocks
      const mockContext = { span: 'mock-span' };
      (context.active as jest.Mock).mockReturnValue(mockContext);
      
      (propagation.inject as jest.Mock).mockImplementation((ctx, carrier) => {
        carrier['traceparent'] = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
        carrier['tracestate'] = 'vendor1=value1';
      });

      // Create a mock HTTP server to verify headers
      const server = http.createServer((req, res) => {
        expect(req.headers['traceparent']).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
        expect(req.headers['tracestate']).toBe('vendor1=value1');
        expect(req.headers['x-custom-header']).toBe('custom-value');
        
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('success');
      });

      server.listen(0, 'localhost', () => {
        const port = (server.address() as any).port;
        
        // Make request with custom headers
        httpService.request(`http://localhost:${port}`, {
          method: 'GET',
          headers: {
            'x-custom-header': 'custom-value'
          }
        }).subscribe({
          next: async (response) => {
            expect(response.data).toBe('success');
            
            // Verify OpenTelemetry APIs were called
            expect(context.active).toHaveBeenCalled();
            expect(propagation.inject).toHaveBeenCalledWith(mockContext, expect.any(Object));
            
            server.close();
            done();
          },
          error: (error) => {
            server.close();
            done(error);
          }
        });
      });
    });

    it('should handle requests without existing headers', (done) => {
      // Setup OpenTelemetry mocks
      (context.active as jest.Mock).mockReturnValue({});
      (propagation.inject as jest.Mock).mockImplementation((ctx, carrier) => {
        carrier['traceparent'] = '00-trace-id-span-id-01';
      });

      // Create a mock HTTP server
      const server = http.createServer((req, res) => {
        expect(req.headers['traceparent']).toBe('00-trace-id-span-id-01');
        res.writeHead(200);
        res.end('ok');
      });

      server.listen(0, 'localhost', () => {
        const port = (server.address() as any).port;
        
        // Make request without custom headers
        httpService.request(`http://localhost:${port}`).subscribe({
          next: () => {
            server.close();
            done();
          },
          error: (error) => {
            server.close();
            done(error);
          }
        });
      });
    });

    it('should work when no trace context is available', (done) => {
      // Setup OpenTelemetry mocks - no trace context
      (context.active as jest.Mock).mockReturnValue({});
      (propagation.inject as jest.Mock).mockImplementation(() => {
        // Do nothing - no active trace
      });

      // Create a mock HTTP server
      const server = http.createServer((req, res) => {
        // Should still have original headers
        expect(req.headers['authorization']).toBe('Bearer token');
        // But no trace headers
        expect(req.headers['traceparent']).toBeUndefined();
        
        res.writeHead(200);
        res.end('ok');
      });

      server.listen(0, 'localhost', () => {
        const port = (server.address() as any).port;
        
        httpService.request(`http://localhost:${port}`, {
          headers: {
            'authorization': 'Bearer token'
          }
        }).subscribe({
          next: () => {
            server.close();
            done();
          },
          error: (error) => {
            server.close();
            done(error);
          }
        });
      });
    });
  });

  describe('interceptor count', () => {
    it('should have two interceptors after initialization (OpenTelemetry + axios adapter)', () => {
      expect(httpService.interceptorCount).toBe(2); // OpenTelemetry + axios adapter
    });
  });
});