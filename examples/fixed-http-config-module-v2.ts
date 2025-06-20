import * as http from "http";
import * as https from "https";

import { AxiosCompatibleHttpService, HttpModule, HttpService as UndiciHttpService } from "nestjs-undici-interceptors";
import { DynamicModule, Global, Module, OnModuleInit, Inject, Injectable } from "@nestjs/common";
import { context, propagation } from "@opentelemetry/api";
import { HttpService } from "@nestjs/axios";

export type HttpConfig = {
  timeout?: number;
  maxRedirects?: number;
  keepAlive?: boolean;
  keepAliveMilliseconds?: number;
  maxSockets?: number;
  maxFreeSockets?: number;
};

// ==============================================
// SOLUTION 1: Remove OnModuleInit from Module
// ==============================================

@Global()
@Module({})
export class HttpConfigModuleSolution1 {
  public static forRoot(config?: HttpConfig): DynamicModule {
    // Create the OpenTelemetry interceptor
    const openTelemetryInterceptor = (request: any, next: any) => {
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
    };

    // Add the interceptor directly in the configuration
    const httpModule = HttpModule.registerAxiosCompatible({
      timeout: config?.timeout ?? 5000,
      maxRedirects: config?.maxRedirects ?? 5,
      httpAgent: new http.Agent({
        keepAlive: config?.keepAlive ?? true,
      }),
      httpsAgent: new https.Agent({
        keepAlive: config?.keepAlive ?? true,
      }),
      // ✅ Add interceptors here
      interceptors: [openTelemetryInterceptor],
    });

    return {
      module: HttpConfigModuleSolution1,
      imports: [httpModule],
      providers: [
        {
          provide: HttpService,
          useExisting: AxiosCompatibleHttpService,
        },
      ],
      exports: [HttpService, httpModule],
    };
  }
}

// ==============================================
// SOLUTION 2: Use a Separate Service
// ==============================================

@Injectable()
export class OpenTelemetryInterceptorService implements OnModuleInit {
  constructor(
    @Inject(AxiosCompatibleHttpService)
    private readonly httpService: AxiosCompatibleHttpService
  ) {}

  onModuleInit() {
    this.httpService.addInterceptor((request, next) => {
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
  }
}

@Global()
@Module({})
export class HttpConfigModuleSolution2 {
  public static forRoot(config?: HttpConfig): DynamicModule {
    const httpModule = HttpModule.registerAxiosCompatible({
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
      module: HttpConfigModuleSolution2,
      imports: [httpModule],
      providers: [
        OpenTelemetryInterceptorService, // ✅ Service handles the interceptor
        {
          provide: HttpService,
          useExisting: AxiosCompatibleHttpService,
        },
      ],
      exports: [HttpService, httpModule],
    };
  }
}

// ==============================================
// SOLUTION 3: Use Factory Provider
// ==============================================

@Global()
@Module({})
export class HttpConfigModuleSolution3 {
  public static forRoot(config?: HttpConfig): DynamicModule {
    const httpModule = HttpModule.registerAxiosCompatible({
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
      module: HttpConfigModuleSolution3,
      imports: [httpModule],
      providers: [
        {
          provide: 'OPENTELEMETRY_INTERCEPTOR',
          useFactory: (httpService: AxiosCompatibleHttpService) => {
            // Add interceptor here
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
            return httpService;
          },
          inject: [AxiosCompatibleHttpService],
        },
        {
          provide: HttpService,
          useExisting: AxiosCompatibleHttpService,
        },
      ],
      exports: [HttpService, httpModule],
    };
  }
}

// ==============================================
// YOUR FIXED CODE (Simplest Solution)
// ==============================================

@Global()
@Module({})
export class HttpConfigModule {
  public static forRoot(config?: HttpConfig): DynamicModule {
    const httpModule = HttpModule.registerAxiosCompatible({
      timeout: config?.timeout ?? 5000,
      maxRedirects: config?.maxRedirects ?? 5,
      httpAgent: new http.Agent({
        keepAlive: config?.keepAlive ?? true,
      }),
      httpsAgent: new https.Agent({
        keepAlive: config?.keepAlive ?? true,
      }),
      // ✅ Add interceptor directly in config
      interceptors: [
        (request, next) => {
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
        },
      ],
    });

    return {
      module: HttpConfigModule,
      imports: [httpModule],
      providers: [
        {
          provide: HttpService,
          useExisting: AxiosCompatibleHttpService,
        },
      ],
      exports: [HttpService, httpModule],
    };
  }
}

// ==============================================
// ALTERNATIVE: Keep OnModuleInit with Different Approach
// ==============================================

@Global()
@Module({})
export class HttpConfigModuleWithInit {
  private static httpServiceInstance: AxiosCompatibleHttpService;

  public static forRoot(config?: HttpConfig): DynamicModule {
    const httpModule = HttpModule.registerAxiosCompatible({
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
      module: HttpConfigModuleWithInit,
      imports: [httpModule],
      providers: [
        {
          provide: HttpService,
          useExisting: AxiosCompatibleHttpService,
        },
        {
          provide: 'HTTP_CONFIG_INIT',
          useFactory: (httpService: AxiosCompatibleHttpService) => {
            // Store reference and add interceptor
            HttpConfigModuleWithInit.httpServiceInstance = httpService;
            
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
          inject: [AxiosCompatibleHttpService],
        },
      ],
      exports: [HttpService, httpModule],
    };
  }
}