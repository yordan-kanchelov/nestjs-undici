import * as http from "http";
import * as https from "https";

import { HttpModule, HttpService, AxiosHeaders } from "nestjs-undici-interceptors";
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

@Global()
@Module({})
export class HttpConfigModule implements OnModuleInit {
  public static forRoot(config?: HttpConfig): DynamicModule {
    const httpModule = HttpModule.register({
      timeout: config?.timeout ?? 5000,
      maxRedirects: config?.maxRedirects ?? 5,
      // Note: httpAgent and httpsAgent are not directly supported in undici
      // The keep-alive and connection pooling is handled internally by undici
      bodyTimeout: config?.timeout ?? 5000,
      headersTimeout: config?.timeout ?? 5000,
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
        config.headers.set(key, value);
      });

      return config;
    });

    // You can also add response interceptors
    this.httpService.axiosRef.interceptors.response.use(
      (response) => {
        // Log or process successful responses
        console.log(`Response from ${response.config.url}: ${response.status}`);
        return response;
      },
      (error) => {
        // Handle errors
        console.error(`Error from ${error.config?.url}:`, error.message);
        return Promise.reject(error);
      }
    );
  }
}

// Example usage in a service
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

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
}