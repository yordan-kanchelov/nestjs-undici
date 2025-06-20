import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule, HttpService } from '../../src';
import { firstValueFrom } from 'rxjs';

describe('HttpService with Interceptors (e2e)', () => {
    let service: HttpService;
    let interceptorCalls: string[] = [];

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
            const result = service.request('https://jsonplaceholder.typicode.com/posts/1', {
                method: 'GET',
            });

            const response = await firstValueFrom(result);
            expect(response.status).toBe(200);
            expect(interceptorCalls).toEqual(['interceptor1', 'interceptor2']);
        });

        it('should have correct number of interceptors', () => {
            // Includes 2 user interceptors + 1 axios adapter interceptor
            expect(service.interceptorCount).toBe(3);
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
            // Starts with 1 (axios adapter interceptor)
            expect(service.interceptorCount).toBe(1);

            // Add first interceptor
            service.addInterceptor((request, next) => {
                interceptorCalls.push('dynamic1');
                return next.handle(request);
            });

            expect(service.interceptorCount).toBe(2);

            // Add second interceptor
            service.addInterceptor((request, next) => {
                interceptorCalls.push('dynamic2');
                return next.handle(request);
            });

            expect(service.interceptorCount).toBe(3);

            // Make request
            const result = service.request('https://jsonplaceholder.typicode.com/posts/1');
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
                                    url: 'https://invalid-domain-that-does-not-exist.com',
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
            const result = service.request('https://jsonplaceholder.typicode.com/posts/1');

            await expect(firstValueFrom(result)).rejects.toThrow();
            expect(interceptorCalls).toContain('error-interceptor');
        });
    });
});