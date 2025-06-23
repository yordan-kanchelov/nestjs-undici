import * as http from "http";
import * as https from "https";
import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule, HttpService } from "../src";
import { DynamicModule, Global, Module, OnModuleInit, Injectable } from "@nestjs/common";

describe('Exact @nestjs/axios Compatibility', () => {
  it('should work with the exact pattern that works with @nestjs/axios', async () => {
    @Global()
    @Module({})
    class HttpConfigModule implements OnModuleInit {
      public static forRoot(): DynamicModule {
        const httpModule = HttpModule.register({
          timeout: 5000,
          maxRedirects: 5,
          httpAgent: new http.Agent({
            keepAlive: true,
          }),
          httpsAgent: new https.Agent({
            keepAlive: true,
          }),
        });

        return {
          module: HttpConfigModule,
          imports: [httpModule],
          exports: [httpModule],
        };
      }

      private readonly httpService: HttpService;

      constructor(httpService: HttpService) {
        this.httpService = httpService;
      }

      public onModuleInit() {
        // Add Axios interceptor
        this.httpService.axiosRef.interceptors.request.use((config) => {
          // Mock OpenTelemetry headers
          const headers: Record<string, string> = {
            'X-Trace-Id': '12345',
            'X-Span-Id': '67890',
          };

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

    // Create an app module that uses HttpConfigModule
    @Module({
      imports: [HttpConfigModule.forRoot()],
    })
    class AppModule {}

    // This should not throw any errors
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    await module.init();

    const httpService = module.get<HttpService>(HttpService);
    expect(httpService).toBeDefined();
    expect(httpService.axiosRef).toBeDefined();
    expect(httpService.axiosRef.interceptors).toBeDefined();

    await module.close();
  });

  it('should allow HttpService injection in modules that import HttpConfigModule', async () => {
    @Global()
    @Module({})
    class HttpConfigModule {
      public static forRoot(): DynamicModule {
        const httpModule = HttpModule.register({
          timeout: 5000,
        });

        return {
          module: HttpConfigModule,
          imports: [httpModule],
          exports: [httpModule],
        };
      }
    }

    // A service that depends on HttpService
    @Injectable()
    class ApiService {
      constructor(private readonly httpService: HttpService) {}

      async fetchData() {
        return this.httpService.get('https://api.example.com/data');
      }
    }

    // A module that uses the ApiService
    @Module({
      imports: [HttpConfigModule.forRoot()],
      providers: [ApiService],
    })
    class FeatureModule {}

    const module: TestingModule = await Test.createTestingModule({
      imports: [FeatureModule],
    }).compile();

    const apiService = module.get<ApiService>(ApiService);
    expect(apiService).toBeDefined();
    expect(apiService['httpService']).toBeInstanceOf(HttpService);

    await module.close();
  });

  it('should work even when HttpModule is imported without register() somewhere', async () => {
    // This simulates the case where somewhere in a large app,
    // someone imports HttpModule without calling register()
    @Module({
      imports: [HttpModule], // No register() call
      exports: [HttpModule],
    })
    class BareHttpModule {}

    @Global()
    @Module({})
    class HttpConfigModule {
      public static forRoot(): DynamicModule {
        const httpModule = HttpModule.register({
          timeout: 5000,
        });

        return {
          module: HttpConfigModule,
          imports: [httpModule],
          exports: [httpModule],
        };
      }
    }

    @Module({
      imports: [
        BareHttpModule, // This would have caused the error before
        HttpConfigModule.forRoot(),
      ],
    })
    class AppModule {}

    // This should work now with default providers
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const httpService = module.get<HttpService>(HttpService);
    expect(httpService).toBeDefined();

    await module.close();
  });
});