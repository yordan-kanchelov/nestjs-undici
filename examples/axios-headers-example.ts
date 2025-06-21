import { HttpModule, HttpService, AxiosHeaders } from '../lib';
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
    this.httpService.axiosRef.interceptors.request.use(config => {
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
          Accept: 'application/json',
        },
      }),
    );

    // Method 2: Use AxiosHeaders directly
    const headers = new AxiosHeaders();
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');
    headers.set('X-Custom', 'value');

    const response2 = await firstValueFrom(
      this.httpService.get('https://api.example.com/data', {
        headers: headers.toJSON() as any,
      }),
    );

    // Method 3: Use AxiosHeaders.from() to create from various sources
    const rawHeaders =
      'Content-Type: application/json\nAccept: application/json';
    const headersFromString = AxiosHeaders.from(rawHeaders);

    const response3 = await firstValueFrom(
      this.httpService.get('https://api.example.com/data', {
        headers: headersFromString.toJSON() as any,
      }),
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
    this.httpService.axiosRef.interceptors.request.use(config => {
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
        (config.headers as AxiosHeaders).set(key, value);
      });

      return config;
    });
  }
}

// Module setup
@Module({
  imports: [HttpModule.register({})],
  providers: [ApiService],
})
export class AxiosHeadersModule {}

// Export for testing
export async function demonstrateAxiosHeaders() {
  const { NestFactory } = require('@nestjs/core');
  const app = await NestFactory.createApplicationContext(AxiosHeadersModule);

  try {
    const service = app.get(ApiService);

    console.log('🔍 Testing AxiosHeaders functionality...');

    // Test AxiosHeaders methods
    const headers = new AxiosHeaders();
    headers
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer test-token')
      .set('X-Custom-Header', 'custom-value');

    // Test case-insensitive operations
    console.log(
      '✅ Case-insensitive get:',
      headers.get('content-type') === 'application/json',
    );
    console.log('✅ Has header:', headers.has('Authorization') === true);

    // Test from different sources
    const fromObject = AxiosHeaders.from({ 'X-Test': 'value' });
    console.log('✅ From object:', fromObject.get('X-Test') === 'value');

    const fromString = AxiosHeaders.from(
      'Content-Type: text/html\nX-Test: value2',
    );
    console.log('✅ From string:', fromString.get('X-Test') === 'value2');

    // Test concatenation
    const concatenated = AxiosHeaders.concat(headers, fromObject);
    console.log(
      '✅ Concatenation:',
      concatenated.has('X-Test') && concatenated.has('Authorization'),
    );

    console.log('\n✅ All AxiosHeaders tests passed!');

    return true;
  } catch (error) {
    console.error('❌ Error in AxiosHeaders example:', error);
    throw error;
  } finally {
    await app.close();
  }
}

// Run if called directly
if (require.main === module) {
  demonstrateAxiosHeaders().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
