import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule, HttpService } from '../../src';
import { firstValueFrom } from 'rxjs';
import {
  closedPortUrl,
  JsonServer,
  startJsonServer,
} from '../test-helpers/json-server';

describe('HttpService with Interceptors (e2e)', () => {
  let service: HttpService;
  let interceptorCalls: string[] = [];
  let server: JsonServer;
  let postUrl: string;
  let unreachableUrl: string;

  beforeAll(async () => {
    server = await startJsonServer();
    postUrl = `${server.baseUrl}/posts/1`;
    unreachableUrl = await closedPortUrl();
  });

  afterAll(() => server.close());

  beforeEach(() => {
    interceptorCalls = [];
  });

  describe('Function-based interceptors', () => {
    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            interceptors: [
              // First interceptor
              (request, next) => {
                interceptorCalls.push('interceptor1');
                const modifiedRequest = {
                  ...request,
                  options: {
                    ...request.options,
                    headers: {
                      ...request.options.headers,
                      'X-Interceptor-1': 'true',
                    },
                  },
                };
                return next.handle(modifiedRequest);
              },
              // Second interceptor
              (request, next) => {
                interceptorCalls.push('interceptor2');
                expect(request.options.headers['X-Interceptor-1']).toBe('true');
                return next.handle(request);
              },
            ],
          }),
        ],
      }).compile();

      service = module.get<HttpService>(HttpService);
    });

    it('should execute interceptors in order', async () => {
      const result = service.request(postUrl, {
        method: 'GET',
      });

      const response = await firstValueFrom(result);
      expect(response.status).toBe(200);
      expect(interceptorCalls).toEqual(['interceptor1', 'interceptor2']);
    });

    it('should have correct number of interceptors', () => {
      // The 2 module-registered (function) interceptors above -
      // `interceptorCount` is the real count now (plan.md phase 3
      // "HttpService members"), no phantom "+1" for a response adapter that
      // hasn't existed since the axiosRef pipeline refactor.
      expect(service.interceptorCount).toBe(2);
    });
  });

  describe('Dynamic interceptors', () => {
    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
      }).compile();

      service = module.get<HttpService>(HttpService);
    });

    it('should allow adding interceptors dynamically', async () => {
      // No module-registered interceptors yet.
      expect(service.interceptorCount).toBe(0);

      // Add first interceptor
      service.addInterceptor((request, next) => {
        interceptorCalls.push('dynamic1');
        return next.handle(request);
      });

      expect(service.interceptorCount).toBe(1);

      // Add second interceptor
      service.addInterceptor((request, next) => {
        interceptorCalls.push('dynamic2');
        return next.handle(request);
      });

      expect(service.interceptorCount).toBe(2);

      // Make request
      const result = service.request(postUrl);
      const response = await firstValueFrom(result);

      expect(response.status).toBe(200);
      expect(interceptorCalls).toEqual(['dynamic1', 'dynamic2']);
    });
  });

  describe('Error handling in interceptors', () => {
    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            interceptors: [
              (request, next) => {
                interceptorCalls.push('error-interceptor');
                // Modify URL to cause an error
                const errorRequest = {
                  ...request,
                  url: unreachableUrl,
                };
                return next.handle(errorRequest);
              },
            ],
          }),
        ],
      }).compile();

      service = module.get<HttpService>(HttpService);
    });

    it('should handle errors in interceptor chain', async () => {
      const result = service.request(postUrl);

      await expect(firstValueFrom(result)).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });
      expect(interceptorCalls).toContain('error-interceptor');
    });
  });
});
