/**
 * This example shows how to migrate a real-world HttpConfigModule from @nestjs/axios to nestjs-undici-interceptors
 * The module sets up OpenTelemetry trace propagation in HTTP requests
 */

import * as http from "http";
import * as https from "https";
import { DynamicModule, Global, Module, OnModuleInit } from "@nestjs/common";
import { context, propagation } from "@opentelemetry/api";
import { Observable } from "rxjs";

// ===== AFTER: Using nestjs-undici-interceptors =====
import { HttpModule, HttpService, HttpInterceptorRequest, HttpInterceptorHandler } from "nestjs-undici-interceptors";

// ===== BEFORE: Using @nestjs/axios (commented out) =====
// import { HttpModule, HttpService } from "@nestjs/axios";

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
  public static forRoot(config?: HttpConfig): DynamicModule {
    // NOTE: This configuration shows the key differences:
    // - nestjs-undici-interceptors accepts httpAgent/httpsAgent but they may not work as expected
    // - Some options like maxRedirects might need to be maxRedirections
    // - Agent configuration might need to be handled differently with Undici
    
    const httpModule = HttpModule.register({
      timeout: config?.timeout ?? 5000,
      maxRedirects: config?.maxRedirects ?? 5,  // Note: might need to be 'maxRedirections' for Undici
      httpAgent: new http.Agent({
        keepAlive: config?.keepAlive ?? true,
        // keepAliveMsecs: config?.keepAliveMilliseconds ?? 5000,
        // maxSockets: config?.maxSockets ?? 2000,
        // maxFreeSockets: config?.maxFreeSockets ?? 200,
      }),
      httpsAgent: new https.Agent({
        keepAlive: config?.keepAlive ?? true,
        // keepAliveMsecs: config?.keepAliveMilliseconds ?? 5000,
        // maxSockets: config?.maxSockets ?? 2000,
        // maxFreeSockets: config?.maxFreeSockets ?? 200,
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
    // ===== AFTER: Using nestjs-undici-interceptors =====
    // Add interceptor to inject OpenTelemetry trace context
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

    // ===== BEFORE: Using @nestjs/axios (commented out) =====
    /*
    // With Axios, you would use axiosRef.interceptors:
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
    */
  }
}