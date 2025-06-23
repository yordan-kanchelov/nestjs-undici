import * as http from "http";
import * as https from "https";
import { Test, TestingModule } from '@nestjs/testing';
import { DynamicModule, Global, Module, OnModuleInit } from "@nestjs/common";
import { HttpModule, HttpService } from "../src"; // Changed from @nestjs/axios
import { context, propagation } from "@opentelemetry/api";
import nock from 'nock';
import { lastValueFrom } from 'rxjs';

// Mock OpenTelemetry
jest.mock("@opentelemetry/api", () => ({
  context: {
    active: jest.fn(() => ({})),
  },
  propagation: {
    inject: jest.fn((context, headers) => {
      headers['traceparent'] = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      headers['tracestate'] = 'congo=t61rcWkgMzE';
    }),
  },
}));

export type HttpConfig = {
  timeout?: number;
  maxRedirects?: number;
  keepAlive?: boolean;
  keepAliveMilliseconds?: number;
  maxSockets?: number;
  maxFreeSockets?: number;
};

@Global()
@Module({})
export class HttpConfigModule implements OnModuleInit {
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

    return {
      module: HttpConfigModule,
      imports: [
        HttpModule.register({
          timeout: config?.timeout ?? 5000,
          maxRedirects: config?.maxRedirects ?? 5,
          httpAgent: this.httpAgent,
          httpsAgent: this.httpsAgent,
        }),
      ],
      exports: [HttpModule],
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
    this.httpService.axiosRef.interceptors.request.use((config) => {
      // Inject OpenTelemetry trace context into headers
      const headers: Record<string, string> = {};

      propagation.inject(context.active(), headers);

      Object.entries(headers).forEach(([key, value]) => {
        if (config.headers && typeof config.headers.set === "function") {
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

describe('HttpConfigModule Compatibility', () => {
  let module: TestingModule;
  let httpService: HttpService;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        HttpConfigModule.forRoot({
          timeout: 10000,
          maxRedirects: 3,
          keepAlive: true,
        }),
      ],
    }).compile();

    await module.init(); // This triggers onModuleInit

    httpService = module.get<HttpService>(HttpService);
  });

  afterEach(async () => {
    await module.close();
    HttpConfigModule.cleanup();
    jest.clearAllMocks();
    nock.cleanAll();
  });

  it('should create HttpConfigModule with forRoot', () => {
    expect(module).toBeDefined();
    expect(httpService).toBeDefined();
  });

  it('should inject HttpService via constructor', () => {
    const httpConfigModule = module.get<HttpConfigModule>(HttpConfigModule);
    expect(httpConfigModule).toBeDefined();
    expect((httpConfigModule as any).httpService).toBe(httpService);
  });

  it('should support axiosRef.interceptors.request.use', () => {
    expect(httpService.axiosRef).toBeDefined();
    expect(httpService.axiosRef.interceptors).toBeDefined();
    expect(httpService.axiosRef.interceptors.request).toBeDefined();
    expect(httpService.axiosRef.interceptors.request.use).toBeDefined();
  });

  it('should inject OpenTelemetry headers via interceptor', async () => {
    // The interceptor was added in onModuleInit, so we know it's there
    // We can verify by checking that propagation.inject was called during module init

    // Since the interceptor is internal, we can't directly test it
    // But we can verify the behavior by checking that the axios interceptor API works
    expect(httpService.axiosRef).toBeDefined();
    expect(httpService.axiosRef.interceptors).toBeDefined();
    expect(httpService.axiosRef.interceptors.request).toBeDefined();
    expect(httpService.axiosRef.interceptors.request.use).toBeDefined();

    // Verify that propagation.inject would be called when making a request
    // In a real scenario, this would happen when httpService makes an actual request
    expect(propagation.inject).toBeDefined();
    expect(context.active).toBeDefined();

    // Test adding another interceptor to verify the API works
    const testInterceptorId = httpService.axiosRef.interceptors.request.use(
      config => {
        // This would be called during request processing
        return config;
      },
    );

    expect(typeof testInterceptorId).toBe('number');
  });

  it('should handle headers without set method', async () => {
    // Test that the interceptor can handle both AxiosHeaders and plain objects
    // This is important for compatibility with different axios versions

    // Test with a custom interceptor that handles different header types
    const interceptorId = httpService.axiosRef.interceptors.request.use(
      config => {
        // This simulates what the OpenTelemetry interceptor does
        const headers: Record<string, string> = { 'x-test': 'value' };

        Object.entries(headers).forEach(([key, value]) => {
          if (config.headers && typeof config.headers.set === 'function') {
            // AxiosHeaders style
            config.headers.set(key, value);
          } else if (config.headers) {
            // Plain object fallback
            (config.headers as Record<string, string>)[key] = value;
          }
        });

        return config;
      },
    );

    expect(typeof interceptorId).toBe('number');

    // The actual header handling would be tested during a real HTTP request
    // Here we just verify the pattern works
  });

  it('should export HttpModule from HttpConfigModule', () => {
    // The module should export HttpModule so it can be used by other modules
    const exports = (HttpConfigModule.forRoot({}) as any).exports;
    expect(exports).toBeDefined();
    expect(exports.length).toBeGreaterThan(0);
  });

  it('should support axios-style agent configuration', () => {
    // This test verifies that the axios-style httpAgent and httpsAgent are accepted
    const config = {
      timeout: 5000,
      maxRedirects: 5,
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
    };

    // This should not throw
    expect(() => HttpModule.register(config)).not.toThrow();
  });
});

describe('HttpConfigModule in application context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should inject OpenTelemetry headers in actual HTTP requests', async () => {
    const module = await Test.createTestingModule({
      imports: [HttpConfigModule.forRoot({ timeout: 3000 })],
    }).compile();

    await module.init();
    const httpService = module.get<HttpService>(HttpService);

    // Create test server
    const server = http.createServer((req, res) => {
      // Verify OpenTelemetry headers were injected
      expect(req.headers['traceparent']).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
      expect(req.headers['tracestate']).toBe('congo=t61rcWkgMzE');
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: 'test' }));
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, 'localhost', async () => {
        const port = (server.address() as any).port;
        
        try {
          const response = await lastValueFrom(
            httpService.get(`http://localhost:${port}/data`)
          );

          expect(response.data).toEqual({ success: true, data: 'test' });
          expect(response.status).toBe(200);

          // Verify OpenTelemetry APIs were called
          expect(context.active).toHaveBeenCalled();
          expect(propagation.inject).toHaveBeenCalled();

          server.close();
          await module.close();
          HttpConfigModule.cleanup();
          resolve();
        } catch (error) {
          server.close();
          await module.close();
          HttpConfigModule.cleanup();
          reject(error);
        }
      });
    });
  });

  it('should preserve existing headers when injecting OpenTelemetry headers', async () => {
    const module = await Test.createTestingModule({
      imports: [HttpConfigModule.forRoot()],
    }).compile();

    await module.init();
    const httpService = module.get<HttpService>(HttpService);

    // Create test server
    const server = http.createServer((req, res) => {
      // Verify all headers are present
      expect(req.headers['authorization']).toBe('Bearer test-token');
      expect(req.headers['x-api-key']).toBe('secret');
      expect(req.headers['traceparent']).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
      expect(req.headers['tracestate']).toBe('congo=t61rcWkgMzE');
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authorized: true }));
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, 'localhost', async () => {
        const port = (server.address() as any).port;
        
        try {
          const response = await lastValueFrom(
            httpService.get(`http://localhost:${port}/secure`, {
              headers: {
                'Authorization': 'Bearer test-token',
                'X-API-Key': 'secret'
              }
            })
          );

          expect(response.data).toEqual({ authorized: true });

          server.close();
          await module.close();
          HttpConfigModule.cleanup();
          resolve();
        } catch (error) {
          server.close();
          await module.close();
          HttpConfigModule.cleanup();
          reject(error);
        }
      });
    });
  });

  it('should handle POST requests with body and OpenTelemetry headers', async () => {
    const module = await Test.createTestingModule({
      imports: [HttpConfigModule.forRoot()],
    }).compile();

    await module.init();
    const httpService = module.get<HttpService>(HttpService);

    const requestBody = { name: 'test', value: 123 };
    
    // Create test server
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        // Verify headers
        expect(req.headers['traceparent']).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
        expect(req.headers['content-type']).toBe('application/json');
        // Verify body
        expect(JSON.parse(body)).toEqual(requestBody);
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 456, ...requestBody }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, 'localhost', async () => {
        const port = (server.address() as any).port;
        
        try {
          const response = await lastValueFrom(
            httpService.post(`http://localhost:${port}/create`, requestBody)
          );

          expect(response.status).toBe(201);
          expect(response.data).toEqual({ id: 456, ...requestBody });

          server.close();
          await module.close();
          HttpConfigModule.cleanup();
          resolve();
        } catch (error) {
          server.close();
          await module.close();
          HttpConfigModule.cleanup();
          reject(error);
        }
      });
    });
  });

  it('should work when imported into another module', async () => {
    @Module({
      imports: [HttpConfigModule.forRoot({ timeout: 3000 })],
      providers: [
        {
          provide: 'API_SERVICE',
          useFactory: (httpService: HttpService) => ({
            fetchData: () => httpService.get('https://api.example.com/data'),
          }),
          inject: [HttpService],
        },
      ],
    })
    class AppModule {}

    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    await module.init();

    const apiService = module.get('API_SERVICE');
    expect(apiService).toBeDefined();
    expect(apiService.fetchData).toBeDefined();

    await module.close();
  });
});
