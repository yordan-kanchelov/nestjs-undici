import { HttpModule, HttpService, AxiosHeaders } from 'nestjs-undici-interceptors';
import { Module, Injectable, OnModuleInit } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

/**
 * Example demonstrating the axios-compatible AxiosHeaders class
 */
@Injectable()
export class ApiService implements OnModuleInit {
  constructor(private readonly httpService: HttpService) {}

  onModuleInit() {
    // Add interceptor that uses AxiosHeaders
    this.httpService.axiosRef.interceptors.request.use((config) => {
      // Ensure we have an AxiosHeaders instance
      if (!config.headers) {
        config.headers = new AxiosHeaders();
      } else if (!(config.headers instanceof AxiosHeaders)) {
        // Convert plain object to AxiosHeaders
        config.headers = AxiosHeaders.from(config.headers);
      }

      // Now we can use all AxiosHeaders methods
      config.headers
        .set('Authorization', 'Bearer token')
        .set('X-Request-ID', Math.random().toString(36))
        .set('User-Agent', 'nestjs-undici/1.0');

      // Headers are automatically normalized to lowercase
      console.log('Has auth:', config.headers.has('authorization')); // true
      
      return config;
    });
  }

  async makeRequest() {
    // Method 1: Headers will be converted to AxiosHeaders in interceptor
    const response1 = await firstValueFrom(
      this.httpService.get('https://api.example.com/data', {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      })
    );

    // Method 2: Use AxiosHeaders directly
    const headers = new AxiosHeaders();
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');
    headers.set('X-Custom', 'value');

    const response2 = await firstValueFrom(
      this.httpService.get('https://api.example.com/data', { headers })
    );

    // Method 3: Use AxiosHeaders.from() to create from various sources
    const rawHeaders = 'Content-Type: application/json\nAccept: application/json';
    const headersFromString = AxiosHeaders.from(rawHeaders);

    const response3 = await firstValueFrom(
      this.httpService.get('https://api.example.com/data', { 
        headers: headersFromString 
      })
    );

    return { response1, response2, response3 };
  }
}

@Module({
  imports: [HttpModule.register()],
  providers: [ApiService],
  exports: [ApiService],
})
export class ApiModule {}

// Example usage for OpenTelemetry (your original use case)
import { context, propagation } from '@opentelemetry/api';

@Injectable()
export class OpenTelemetryService implements OnModuleInit {
  constructor(private readonly httpService: HttpService) {}

  onModuleInit() {
    this.httpService.axiosRef.interceptors.request.use((config) => {
      // Extract trace headers
      const traceHeaders: Record<string, string> = {};
      propagation.inject(context.active(), traceHeaders);

      // Ensure headers is AxiosHeaders
      if (!config.headers) {
        config.headers = new AxiosHeaders();
      } else if (!(config.headers instanceof AxiosHeaders)) {
        config.headers = AxiosHeaders.from(config.headers);
      }

      // Now you can use set() without TypeScript errors!
      Object.entries(traceHeaders).forEach(([key, value]) => {
        config.headers.set(key, value);
      });

      return config;
    });
  }
}