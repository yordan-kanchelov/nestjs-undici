import { Test, TestingModule } from '@nestjs/testing';
import { Injectable, Module } from '@nestjs/common';
import { HttpModule, HttpService } from '../src';
import { UNDICI_INSTANCE_TOKEN, HTTP_MODULE_OPTIONS } from '../src/modules/http/constants/http.constants';
import { HttpModuleOptionsFactory } from '../src/modules/http/interfaces';
import { HttpModuleOptions } from '../src/modules/http/types';

describe('NestJS Module Integration Tests', () => {
  describe('HttpModule.register()', () => {
    it('should create module with default configuration', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register()],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      expect(httpService).toBeInstanceOf(HttpService);
    });

    it('should provide UNDICI_INSTANCE_TOKEN', async () => {
      const config = { timeout: 5000 };
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register(config)],
      }).compile();

      const undiciInstance = module.get(UNDICI_INSTANCE_TOKEN);
      expect(undiciInstance).toBeDefined();
      expect(undiciInstance.timeout).toBe(5000);
    });

    it('should provide HTTP_MODULE_OPTIONS', async () => {
      const config = { timeout: 5000, interceptors: [] };
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register(config)],
      }).compile();

      const moduleOptions = module.get(HTTP_MODULE_OPTIONS);
      expect(moduleOptions).toBeDefined();
      expect(moduleOptions.timeout).toBe(5000);
    });

    it('should handle axios-compatible configuration', async () => {
      const axiosConfig = {
        baseURL: 'https://api.example.com',
        timeout: 3000,
        headers: {
          'X-Custom-Header': 'test',
        },
        maxRedirects: 5,
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register(axiosConfig)],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      
      const moduleOptions = module.get(HTTP_MODULE_OPTIONS);
      expect(moduleOptions.baseURL).toBe('https://api.example.com');
    });

    it('should register interceptors correctly', async () => {
      const testInterceptor = jest.fn((request, next) => next.handle(request));
      
      const config = {
        interceptors: [testInterceptor],
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register(config)],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      
      // Verify interceptor is registered
      const interceptors = (httpService as any).interceptors;
      expect(interceptors).toContain(testInterceptor);
    });

    it('should work when imported into another module', async () => {
      @Injectable()
      class TestService {
        constructor(private readonly httpService: HttpService) {}
        
        getHttpService() {
          return this.httpService;
        }
      }

      @Module({
        imports: [HttpModule.register({ timeout: 3000 })],
        providers: [TestService],
      })
      class TestModule {}

      const module: TestingModule = await Test.createTestingModule({
        imports: [TestModule],
      }).compile();

      const testService = module.get<TestService>(TestService);
      expect(testService).toBeDefined();
      expect(testService.getHttpService()).toBeInstanceOf(HttpService);
    });
  });

  describe('HttpModule.registerAsync()', () => {
    it('should create module with factory', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.registerAsync({
            useFactory: () => ({
              timeout: 3000,
            }),
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      expect(httpService).toBeInstanceOf(HttpService);
    });

    it('should handle async factory with dependencies', async () => {
      @Injectable()
      class ConfigService {
        getTimeout() {
          return 5000;
        }
      }

      @Module({
        providers: [ConfigService],
        exports: [ConfigService],
      })
      class ConfigModule {}

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          ConfigModule,
          HttpModule.registerAsync({
            imports: [ConfigModule],
            useFactory: (configService: ConfigService) => ({
              timeout: configService.getTimeout(),
            }),
            inject: [ConfigService],
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      
      const moduleOptions = module.get(HTTP_MODULE_OPTIONS);
      expect(moduleOptions.timeout).toBe(5000);
    });

    it('should work with useClass', async () => {
      @Injectable()
      class HttpConfigService implements HttpModuleOptionsFactory {
        createHttpOptions(): HttpModuleOptions {
          return {
            timeout: 4000,
          };
        }
      }

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.registerAsync({
            useClass: HttpConfigService,
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      
      const moduleOptions = module.get(HTTP_MODULE_OPTIONS);
      expect(moduleOptions.timeout).toBe(4000);
    });

    it('should work with useExisting', async () => {
      @Injectable()
      class HttpConfigService implements HttpModuleOptionsFactory {
        createHttpOptions(): HttpModuleOptions {
          return {
            timeout: 6000,
          };
        }
      }

      @Module({
        providers: [HttpConfigService],
        exports: [HttpConfigService],
      })
      class ConfigModule {}

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          ConfigModule,
          HttpModule.registerAsync({
            imports: [ConfigModule],
            useExisting: HttpConfigService,
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      
      const moduleOptions = module.get(HTTP_MODULE_OPTIONS);
      expect(moduleOptions.timeout).toBe(6000);
    });

    it('should handle extra providers', async () => {
      @Injectable()
      class ExtraService {
        getValue() {
          return 'extra';
        }
      }

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.registerAsync({
            useFactory: () => ({ timeout: 3000 }),
            extraProviders: [ExtraService],
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      const extraService = module.get<ExtraService>(ExtraService);
      
      expect(httpService).toBeDefined();
      expect(extraService).toBeDefined();
      expect(extraService.getValue()).toBe('extra');
    });
  });

  describe('Module reusability', () => {
    it('should allow multiple imports with different configurations', async () => {
      @Module({
        imports: [HttpModule.register({ timeout: 1000 })],
        exports: [HttpModule],
      })
      class Feature1Module {}

      @Module({
        imports: [HttpModule.register({ timeout: 2000 })],
        exports: [HttpModule],
      })
      class Feature2Module {}

      @Module({
        imports: [Feature1Module, Feature2Module],
      })
      class AppModule {}

      const module: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      expect(module).toBeDefined();
    });
  });

  describe('Dependency injection', () => {
    it('should properly inject HttpService into controllers', async () => {
      @Injectable()
      class TestController {
        constructor(private readonly httpService: HttpService) {}
        
        getService() {
          return this.httpService;
        }
      }

      @Module({
        imports: [HttpModule.register()],
        controllers: [TestController],
      })
      class TestModule {}

      const module: TestingModule = await Test.createTestingModule({
        imports: [TestModule],
      }).compile();

      const controller = module.get<TestController>(TestController);
      expect(controller).toBeDefined();
      expect(controller.getService()).toBeInstanceOf(HttpService);
    });

    it('should handle circular dependencies gracefully', async () => {
      @Injectable()
      class ServiceA {
        constructor(private readonly httpService: HttpService) {}
      }

      @Injectable()
      class ServiceB {
        constructor(
          private readonly httpService: HttpService,
          private readonly serviceA: ServiceA,
        ) {}
      }

      @Module({
        imports: [HttpModule.register()],
        providers: [ServiceA, ServiceB],
      })
      class TestModule {}

      const module: TestingModule = await Test.createTestingModule({
        imports: [TestModule],
      }).compile();

      const serviceA = module.get<ServiceA>(ServiceA);
      const serviceB = module.get<ServiceB>(ServiceB);
      
      expect(serviceA).toBeDefined();
      expect(serviceB).toBeDefined();
    });
  });

  describe('Error scenarios', () => {
    it('should handle missing configuration gracefully', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register()],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
    });

    it('should handle invalid interceptors', async () => {
      const config = {
        interceptors: [null, undefined, 123] as any,
      };

      // This should not throw during module creation
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register(config)],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
    });
  });
});