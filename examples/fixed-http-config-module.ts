import * as http from "http";
import * as https from "https";

import { AxiosCompatibleHttpService, HttpModule, HttpService } from "nestjs-undici-interceptors";
import { DynamicModule, Global, Module, OnModuleInit } from "@nestjs/common";
import { context, propagation } from "@opentelemetry/api";

export type HttpConfig = {
  timeout?: number;
  maxRedirects?: number;
  keepAlive?: boolean;
  keepAliveMilliseconds?: number;
  maxSockets?: number;
  maxFreeSockets?: number;
};

// ==============================================
// THE ISSUE WITH YOUR CURRENT CODE
// ==============================================
/*
The problem is in the imports array:
- You're importing [HttpModule] which is the class itself
- But you should import [httpModule] which is the configured module returned by registerAxiosCompatible()
*/

// ==============================================
// SOLUTION 1: Fix the imports (Minimal Change)
// ==============================================
@Global()
@Module({})
export class FixedHttpConfigModule implements OnModuleInit {
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
      module: FixedHttpConfigModule,
      imports: [httpModule], // ✅ Use the configured module, not HttpModule class
      exports: [httpModule],
    };
  }

  private readonly httpService: AxiosCompatibleHttpService;

  constructor(httpService: AxiosCompatibleHttpService) {
    this.httpService = httpService;
  }

  public onModuleInit() {
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

// ==============================================
// SOLUTION 2: Use HttpService Type (More Flexible)
// ==============================================
@Global()
@Module({})
export class FlexibleHttpConfigModule implements OnModuleInit {
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
      module: FlexibleHttpConfigModule,
      imports: [httpModule],
      exports: [httpModule],
    };
  }

  private readonly httpService: HttpService;

  // ✅ Inject HttpService instead - it's actually AxiosCompatibleHttpService at runtime
  constructor(httpService: HttpService) {
    this.httpService = httpService;
  }

  public onModuleInit() {
    // Cast to AxiosCompatibleHttpService to access addInterceptor
    const axiosService = this.httpService as AxiosCompatibleHttpService;
    
    axiosService.addInterceptor((request, next) => {
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

// ==============================================
// SOLUTION 3: Configure Interceptors Upfront
// ==============================================
@Global()
@Module({})
export class ConfiguredHttpConfigModule {
  public static forRoot(config?: HttpConfig): DynamicModule {
    // Create the interceptor function
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

    // Add interceptor in the configuration
    const httpModule = HttpModule.registerAxiosCompatible({
      timeout: config?.timeout ?? 5000,
      maxRedirects: config?.maxRedirects ?? 5,
      httpAgent: new http.Agent({
        keepAlive: config?.keepAlive ?? true,
      }),
      httpsAgent: new https.Agent({
        keepAlive: config?.keepAlive ?? true,
      }),
      // ✅ Add interceptors in config
      interceptors: [openTelemetryInterceptor],
    });

    return {
      module: ConfiguredHttpConfigModule,
      imports: [httpModule],
      exports: [httpModule],
    };
  }
}

// ==============================================
// YOUR FIXED CODE (Just change one line!)
// ==============================================
@Global()
@Module({})
export class HttpConfigModule implements OnModuleInit {
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
      module: HttpConfigModule,
      imports: [httpModule], // ✅ FIXED: Use httpModule, not HttpModule
      exports: [httpModule],
    };
  }

  private readonly httpService: AxiosCompatibleHttpService;

  constructor(httpService: AxiosCompatibleHttpService) {
    this.httpService = httpService;
  }

  public onModuleInit() {
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

// ==============================================
// USAGE IN OTHER SERVICES
// ==============================================

// Now other services can inject either HttpService or AxiosCompatibleHttpService:
@Injectable()
export class PlayerService {
  constructor(
    // Both of these work when HttpConfigModule is imported:
    private httpService: HttpService,  // Works
    // OR
    private axiosService: AxiosCompatibleHttpService  // Also works
  ) {}

  async getData() {
    const response = await lastValueFrom(
      this.httpService.get<any>('/api/data')
    );
    return response.data; // ✅ Works in axios mode
  }
}

import { Injectable } from '@nestjs/common';
import { lastValueFrom } from 'rxjs';