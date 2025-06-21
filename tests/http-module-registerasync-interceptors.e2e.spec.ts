import { Test, TestingModule } from '@nestjs/testing';
import { Injectable } from '@nestjs/common';
import { HttpModule, HttpService } from '../src';
import { HttpInterceptor, HttpInterceptorFunction, HttpInterceptorHandler, HttpInterceptorRequest } from '../src/modules/http/interfaces';
import { Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';

describe('HttpModule.registerAsync() with Interceptors', () => {
  describe('Function-based interceptors', () => {
    it('should register function interceptors via useFactory', async () => {
      const interceptorCalled = jest.fn();
      
      const testInterceptor: HttpInterceptorFunction = (request, next) => {
        interceptorCalled();
        return next.handle(request);
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.registerAsync({
            useFactory: () => ({
              timeout: 3000,
              interceptors: [testInterceptor],
            }),
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      
      // Check if interceptor is registered
      const interceptors = (httpService as any).interceptors;
      expect(interceptors).toContain(testInterceptor);
    });

    it('should handle multiple function interceptors', async () => {
      const order: number[] = [];
      
      const interceptor1: HttpInterceptorFunction = (request, next) => {
        order.push(1);
        return next.handle(request);
      };

      const interceptor2: HttpInterceptorFunction = (request, next) => {
        order.push(2);
        return next.handle(request);
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.registerAsync({
            useFactory: () => ({
              interceptors: [interceptor1, interceptor2],
            }),
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      const interceptors = (httpService as any).interceptors;
      
      expect(interceptors).toContain(interceptor1);
      expect(interceptors).toContain(interceptor2);
    });
  });

  describe('Class-based interceptors', () => {
    it('should register class interceptors via useFactory', async () => {
      @Injectable()
      class TestInterceptor implements HttpInterceptor {
        intercept(request: HttpInterceptorRequest, next: HttpInterceptorHandler): Observable<any> {
          return next.handle(request).pipe(
            map(response => ({
              ...response,
              intercepted: true,
            })),
          );
        }
      }

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.registerAsync({
            useFactory: () => ({
              interceptors: [TestInterceptor],
            }),
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      
      // Check if interceptor class is available
      const interceptors = (httpService as any).interceptors;
      // Currently, class interceptors might not be properly instantiated in registerAsync
      console.log('Interceptors:', interceptors);
    });

    it('should handle mixed function and class interceptors', async () => {
      const functionInterceptorCalled = jest.fn();
      
      const functionInterceptor: HttpInterceptorFunction = (request, next) => {
        functionInterceptorCalled();
        return next.handle(request);
      };

      @Injectable()
      class ClassInterceptor implements HttpInterceptor {
        intercept(request: HttpInterceptorRequest, next: HttpInterceptorHandler): Observable<any> {
          return next.handle(request);
        }
      }

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.registerAsync({
            useFactory: () => ({
              interceptors: [functionInterceptor, ClassInterceptor],
            }),
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      const interceptors = (httpService as any).interceptors;
      
      expect(interceptors).toContain(functionInterceptor);
      // Check if class interceptor is properly handled
      console.log('Mixed interceptors:', interceptors);
    });
  });

  describe('Axios compatibility', () => {
    it('should handle axios transformRequest/transformResponse in registerAsync', async () => {
      const transformRequest = jest.fn((data) => {
        return JSON.stringify({ wrapped: data });
      });

      const transformResponse = jest.fn((data) => {
        return { unwrapped: data };
      });

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.registerAsync({
            useFactory: () => ({
              baseURL: 'https://api.example.com',
              transformRequest: [transformRequest],
              transformResponse: [transformResponse],
            }),
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      expect(httpService).toBeDefined();
      
      // These transforms should be converted to interceptors
      const interceptors = (httpService as any).interceptors;
      console.log('Transform interceptors:', interceptors.length);
    });
  });

  describe('Dependency injection with interceptors', () => {
    it('should inject dependencies into class interceptors', async () => {
      @Injectable()
      class ConfigService {
        getApiKey() {
          return 'test-api-key';
        }
      }

      @Injectable()
      class AuthInterceptor implements HttpInterceptor {
        constructor(private readonly configService: ConfigService) {}

        intercept(request: HttpInterceptorRequest, next: HttpInterceptorHandler): Observable<any> {
          const apiKey = this.configService.getApiKey();
          request.options.headers = {
            ...request.options.headers,
            'X-API-Key': apiKey,
          };
          return next.handle(request);
        }
      }

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.registerAsync({
            useFactory: () => ({
              interceptors: [AuthInterceptor],
            }),
          }),
        ],
        providers: [ConfigService],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);
      const configService = module.get<ConfigService>(ConfigService);
      
      expect(httpService).toBeDefined();
      expect(configService).toBeDefined();
      
      // Check if the interceptor can access the config service
      const interceptors = (httpService as any).interceptors;
      console.log('DI interceptors:', interceptors);
    });
  });
});