/**
 * OpenTelemetry Integration Example
 *
 * This example demonstrates how to integrate OpenTelemetry trace propagation
 * with nestjs-undici-interceptors using both axios-style and native interceptor APIs.
 */

import { HttpModule, HttpService, AxiosHeaders, HttpInterceptorRequest, HttpInterceptorHandler } from "../lib";
import { DynamicModule, Global, Module as NestModule, OnModuleInit, Injectable } from "@nestjs/common";
import { context, propagation } from "@opentelemetry/api";
import { firstValueFrom } from 'rxjs';
import { Observable } from 'rxjs';

export type HttpConfig = {
  timeout?: number;
  maxRedirects?: number;
  keepAlive?: boolean;
  keepAliveMilliseconds?: number;
  maxSockets?: number;
  maxFreeSockets?: number;
};

// ===== Option 1: Using Axios-style Interceptors (Easiest Migration) =====

@Global()
@NestModule({})
export class HttpConfigModuleAxiosStyle implements OnModuleInit {
  public static forRoot(config?: HttpConfig): DynamicModule {
    const httpModule = HttpModule.register({
      timeout: config?.timeout ?? 5000,
      maxRedirects: config?.maxRedirects ?? 5,
      // Note: httpAgent/httpsAgent options are automatically detected and mapped
      // The library handles connection pooling internally
    });

    return {
      module: HttpConfigModuleAxiosStyle,
      imports: [httpModule],
      exports: [httpModule],
    };
  }

  constructor(private readonly httpService: HttpService) {}

  public onModuleInit() {
    // Add Axios-compatible interceptor to inject OpenTelemetry trace context
    this.httpService.axiosRef.interceptors.request.use((config) => {
      // Inject OpenTelemetry trace context into headers
      const traceHeaders: Record<string, string> = {};
      propagation.inject(context.active(), traceHeaders);

      // Ensure headers is an AxiosHeaders instance
      if (!config.headers) {
        config.headers = new AxiosHeaders();
      } else if (!(config.headers instanceof AxiosHeaders)) {
        config.headers = AxiosHeaders.from(config.headers);
      }

      // Now we can safely use the set method
      Object.entries(traceHeaders).forEach(([key, value]) => {
        (config.headers as AxiosHeaders).set(key, value);
      });

      return config;
    });

    // Add response interceptor for logging
    this.httpService.axiosRef.interceptors.response.use(
      (response) => {
        console.log(`Response from ${response.config.url}: ${response.status}`);
        return response;
      },
      (error) => {
        console.error(`Error from ${error.config?.url}:`, error.message);
        return Promise.reject(error);
      }
    );
  }
}

// ===== Option 2: Using Native Interceptors (Better Performance) =====

@Global()
@NestModule({})
export class HttpConfigModuleNative implements OnModuleInit {
  public static forRoot(config?: HttpConfig): DynamicModule {
    const httpModule = HttpModule.register({
      timeout: config?.timeout ?? 5000,
      maxRedirections: config?.maxRedirects ?? 5,  // Note: 'maxRedirections' for native undici
      bodyTimeout: config?.timeout ?? 5000,
      headersTimeout: config?.timeout ?? 5000,
    });

    return {
      module: HttpConfigModuleNative,
      imports: [httpModule],
      exports: [httpModule],
    };
  }

  constructor(private readonly httpService: HttpService) {}

  public onModuleInit() {
    // Add native interceptor to inject OpenTelemetry trace context
    this.httpService.addInterceptor(
      (request: HttpInterceptorRequest, next: HttpInterceptorHandler): Observable<any> => {
        // Inject OpenTelemetry trace context into headers
        const traceHeaders: Record<string, string> = {};
        propagation.inject(context.active(), traceHeaders);

        // Merge trace headers with existing headers
        const updatedRequest: HttpInterceptorRequest = {
          ...request,
          options: {
            ...request.options,
            headers: {
              ...(request.options.headers as Record<string, string>),
              ...traceHeaders,
            },
          },
        };

        return next.handle(updatedRequest);
      }
    );
  }
}

// ===== Option 3: Class-based Interceptor (Most Flexible) =====

@Injectable()
export class OpenTelemetryInterceptor {
  intercept(request: HttpInterceptorRequest, next: HttpInterceptorHandler): Observable<any> {
    // Inject OpenTelemetry trace context into headers
    const traceHeaders: Record<string, string> = {};
    propagation.inject(context.active(), traceHeaders);

    // Create updated request with trace headers
    const updatedRequest: HttpInterceptorRequest = {
      ...request,
      options: {
        ...request.options,
        headers: {
          ...(request.options.headers as Record<string, string>),
          ...traceHeaders,
        },
      },
    };

    return next.handle(updatedRequest);
  }
}

// Module using class-based interceptor
@Global()
@NestModule({})
export class HttpConfigModuleClassBased {
  public static forRoot(config?: HttpConfig): DynamicModule {
    const httpModule = HttpModule.register({
      timeout: config?.timeout ?? 5000,
      maxRedirects: config?.maxRedirects ?? 5,
      interceptors: [OpenTelemetryInterceptor], // Register class-based interceptor
    });

    return {
      module: HttpConfigModuleClassBased,
      imports: [httpModule],
      exports: [httpModule],
      providers: [OpenTelemetryInterceptor], // Provide the interceptor class
    };
  }
}

// ===== Example Service Using the HTTP Client =====

@Injectable()
export class ExampleService {
  constructor(private readonly httpService: HttpService) {}

  async makeRequest() {
    // The interceptors will automatically add OpenTelemetry headers
    const response = await firstValueFrom(
      this.httpService.get('https://api.example.com/data')
    );

    return response.data;
  }

  async makePostRequest(data: any) {
    // OpenTelemetry headers are added to all requests
    const response = await firstValueFrom(
      this.httpService.post('https://api.example.com/users', data)
    );

    return response.data;
  }
}

// ===== Usage in App Module =====

import { NestFactory } from '@nestjs/core';

@NestModule({
  imports: [
    // Choose one of the three approaches:

    // Option 1: Axios-style (easiest migration)
    HttpConfigModuleAxiosStyle.forRoot({
      timeout: 10000,
      maxRedirects: 5,
    }),

    // Option 2: Native interceptors (better performance)
    // HttpConfigModuleNative.forRoot({ ... }),

    // Option 3: Class-based interceptor (most flexible)
    // HttpConfigModuleClassBased.forRoot({ ... }),
  ],
  providers: [ExampleService],
})
export class AppModule {}

// Export for testing
export async function demonstrateOpenTelemetry() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const service = app.get(ExampleService);

    console.log('🔍 Testing OpenTelemetry integration...');

    // Note: In a real test, you'd have OpenTelemetry configured
    // and would verify that trace headers are being added

    // For now, we'll just verify the service is created properly
    if (service) {
      console.log('✅ OpenTelemetry HTTP module configured successfully');
      console.log('✅ ExampleService created with HTTP client');

      // In a real scenario, you'd make actual requests here
      // await service.makeRequest();
      // await service.makePostRequest({ test: 'data' });
    }

    return true;
  } catch (error) {
    console.error('❌ Error in OpenTelemetry integration:', error);
    throw error;
  } finally {
    await app.close();
  }
}

// Run if called directly
if (require.main === module) {
  demonstrateOpenTelemetry().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
