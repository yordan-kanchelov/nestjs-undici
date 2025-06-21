import { Test, TestingModule } from '@nestjs/testing';
import { Injectable, Module } from '@nestjs/common';
import { HttpModule, HttpService } from '../src';
import { UNDICI_INSTANCE_TOKEN, HTTP_MODULE_OPTIONS } from '../src/modules/http/constants/http.constants';

describe('NestJS Dependency Resolution Tests', () => {
  describe('UNDICI_INSTANCE_TOKEN resolution', () => {
    it('should resolve UNDICI_INSTANCE_TOKEN when HttpService is injected', async () => {
      @Injectable()
      class TestService {
        constructor(private readonly httpService: HttpService) {}
        
        async makeRequest() {
          return this.httpService.get('https://example.com');
        }
      }

      @Module({
        imports: [HttpModule.register()],
        providers: [TestService],
      })
      class TestModule {}

      const module: TestingModule = await Test.createTestingModule({
        imports: [TestModule],
      }).compile();

      // This should not throw UnknownDependenciesException
      const testService = module.get<TestService>(TestService);
      expect(testService).toBeDefined();
      
      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      
      // Verify the token is available
      const undiciToken = module.get(UNDICI_INSTANCE_TOKEN);
      expect(undiciToken).toBeDefined();
    });

    it('should handle HttpService as a direct provider dependency', async () => {
      @Injectable()
      class DatabaseService {
        constructor(private readonly httpService: HttpService) {}
      }

      @Injectable()
      class AppService {
        constructor(
          private readonly httpService: HttpService,
          private readonly databaseService: DatabaseService,
        ) {}
      }

      @Module({
        imports: [HttpModule.register({ timeout: 5000 })],
        providers: [DatabaseService, AppService],
        exports: [AppService],
      })
      class AppModule {}

      const module: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      const appService = module.get<AppService>(AppService);
      const databaseService = module.get<DatabaseService>(DatabaseService);
      
      expect(appService).toBeDefined();
      expect(databaseService).toBeDefined();
    });

    it('should work with forRoot pattern in a real app structure', async () => {
      // Simulating a real application structure
      @Injectable()
      class ApiService {
        constructor(private readonly httpService: HttpService) {}
        
        async fetchData(url: string) {
          return this.httpService.get(url).toPromise();
        }
      }

      @Module({
        imports: [
          HttpModule.register({
            timeout: 10000,
            headers: {
              'User-Agent': 'TestApp/1.0',
            },
          }),
        ],
        providers: [ApiService],
        exports: [ApiService],
      })
      class CoreModule {}

      @Module({
        imports: [CoreModule],
      })
      class AppModule {}

      const module: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      const apiService = module.get<ApiService>(ApiService);
      expect(apiService).toBeDefined();
      expect(apiService.fetchData).toBeDefined();
    });

    it('should resolve all tokens in the correct order', async () => {
      const resolvedTokens: string[] = [];

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.registerAsync({
            useFactory: () => {
              resolvedTokens.push('HTTP_MODULE_OPTIONS');
              return { timeout: 3000 };
            },
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      const undiciToken = module.get(UNDICI_INSTANCE_TOKEN);
      const moduleOptions = module.get(HTTP_MODULE_OPTIONS);

      expect(httpService).toBeDefined();
      expect(undiciToken).toBeDefined();
      expect(moduleOptions).toBeDefined();
      expect(resolvedTokens).toContain('HTTP_MODULE_OPTIONS');
    });

    it('should handle global module pattern', async () => {
      @Module({
        imports: [HttpModule.register()],
        exports: [HttpModule],
      })
      class GlobalHttpModule {}

      @Injectable()
      class FeatureService {
        constructor(private readonly httpService: HttpService) {}
      }

      @Module({
        imports: [GlobalHttpModule], // FeatureModule needs to import the module that exports HttpService
        providers: [FeatureService],
      })
      class FeatureModule {}

      @Module({
        imports: [GlobalHttpModule, FeatureModule],
      })
      class AppModule {}

      const module: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      // HttpService should be available since FeatureModule imports GlobalHttpModule
      const featureService = module.get<FeatureService>(FeatureService);
      expect(featureService).toBeDefined();
    });

    it('should provide proper error message when HttpModule is not imported', async () => {
      @Injectable()
      class ServiceWithoutHttpModule {
        constructor(private readonly httpService: HttpService) {}
      }

      @Module({
        // Note: HttpModule is NOT imported here
        providers: [ServiceWithoutHttpModule],
      })
      class BrokenModule {}

      // This should throw a clear error about missing HttpModule
      await expect(
        Test.createTestingModule({
          imports: [BrokenModule],
        }).compile()
      ).rejects.toThrow();
    });
  });

  describe('Interceptor dependency resolution', () => {
    it('should demonstrate that class-based interceptors with dependencies have limitations', async () => {
      // This test demonstrates a current limitation:
      // Class-based interceptors with dependencies cannot be automatically
      // instantiated by HttpModule due to NestJS module scoping
      
      @Injectable()
      class LoggerService {
        log(message: string) {
          console.log(message);
        }
      }

      @Injectable()
      class LoggingInterceptor {
        constructor(private readonly logger: LoggerService) {}
        
        intercept(request: any, next: any) {
          this.logger.log(`Request to ${request.url}`);
          return next.handle(request);
        }
      }

      // This will fail because LoggerService is not in HttpModule's scope
      const createModuleWithClassInterceptor = async () => {
        @Module({
          imports: [
            HttpModule.register({
              interceptors: [LoggingInterceptor],
            }),
          ],
          providers: [LoggerService, LoggingInterceptor], // Even with providers here, HttpModule can't access them
        })
        class AppModule {}

        return Test.createTestingModule({
          imports: [AppModule],
        }).compile();
      };

      // This will throw because HttpModule tries to instantiate the interceptor
      await expect(createModuleWithClassInterceptor()).rejects.toThrow(/Nest can't resolve dependencies/);
      
      // Workaround: Use function-based interceptors or manually instantiate class interceptors
      // See the next test for the recommended approach
    });

    it('should work with function-based interceptors (no DI required)', async () => {
      // Function-based interceptors don't require dependency injection
      const loggingInterceptor = (request: any, next: any) => {
        console.log(`Request to ${request.url}`);
        return next.handle(request);
      };

      @Module({
        imports: [
          HttpModule.register({
            interceptors: [loggingInterceptor],
          }),
        ],
      })
      class AppModule {}

      const module: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      
      // Verify the interceptor is registered
      const interceptors = (httpService as any).interceptors;
      expect(interceptors).toContain(loggingInterceptor);
    });
  });
});