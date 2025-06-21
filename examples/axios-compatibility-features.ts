/**
 * Axios Compatibility Features
 *
 * This example demonstrates all the axios compatibility features available in nestjs-undici-interceptors,
 * including configuration mapping, interceptor APIs, and response compatibility.
 */

import { Module, Injectable, OnModuleInit } from '@nestjs/common';
import { HttpModule, HttpService, AxiosHeaders } from '../lib';
import { firstValueFrom } from 'rxjs';

// ===== 2. Using Axios-Style Interceptors =====

@Injectable()
export class AxiosCompatibilityService implements OnModuleInit {
  constructor(private readonly httpService: HttpService) {}

  onModuleInit() {
    // Request interceptors - exact same API as axios!
    const requestInterceptorId = this.httpService.axiosRef.interceptors.request.use(
      (config) => {
        // Modify request config
        config.headers = config.headers || new AxiosHeaders();
        (config.headers as AxiosHeaders).set('X-Request-Time', new Date().toISOString());
        (config.headers as AxiosHeaders).set('Authorization', 'Bearer my-token');

        // Add query parameters
        if (!config.params) {
          config.params = {};
        }
        config.params.timestamp = Date.now();

        console.log('Request:', config.method?.toUpperCase(), config.url);
        return config;
      },
      (error) => {
        console.error('Request error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptors - also identical to axios!
    const responseInterceptorId = this.httpService.axiosRef.interceptors.response.use(
      (response) => {
        console.log('Response:', response.status, response.statusText);

        // Transform response data
        if (response.data && typeof response.data === 'object') {
          response.data._processed = true;
          response.data._timestamp = Date.now();
        }

        return response;
      },
      (error) => {
        // Handle specific error cases
        if (error.response) {
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          console.error('Response error:', error.response.status, error.response.data);

          if (error.response.status === 401) {
            // Handle unauthorized - maybe refresh token
            console.log('Unauthorized! Need to refresh token...');
          } else if (error.response.status === 429) {
            // Handle rate limiting
            const retryAfter = error.response.headers['retry-after'];
            console.log(`Rate limited. Retry after ${retryAfter} seconds`);
          }
        } else if (error.request) {
          // The request was made but no response was received
          console.error('No response received:', error.message);
        } else {
          // Something happened in setting up the request
          console.error('Request setup error:', error.message);
        }

        return Promise.reject(error);
      }
    );

    // You can also eject interceptors (remove them)
    // this.httpService.axiosRef.interceptors.request.eject(requestInterceptorId);
    // this.httpService.axiosRef.interceptors.response.eject(responseInterceptorId);
  }

  // ===== 3. Axios-Compatible Response Structure =====

  async demonstrateResponseCompatibility() {
    try {
      // All responses have the axios structure
      const response = await firstValueFrom(
        this.httpService.get('https://jsonplaceholder.typicode.com/posts/1')
      );

      console.log('Axios-compatible response properties:');
      console.log('- data:', response.data);           // Parsed response body
      console.log('- status:', response.status);       // HTTP status code
      console.log('- statusText:', response.statusText); // Status text
      console.log('- headers:', response.headers);     // Response headers
      console.log('- config:', response.config);       // Request configuration

      // The response.config includes all the axios-style options
      console.log('Config properties:');
      console.log('- url:', response.config.url);
      console.log('- method:', response.config.method);
      console.log('- headers:', response.config.headers);
      console.log('- params:', response.config.params);
      console.log('- timeout:', response.config.timeout);

      return response.data;
    } catch (error: any) {
      // Errors are also axios-compatible
      if (error.isAxiosError) {
        console.log('Axios error properties:');
        console.log('- message:', error.message);
        console.log('- code:', error.code);
        console.log('- config:', error.config);
        console.log('- request:', error.request);
        console.log('- response:', error.response);
        console.log('- toJSON:', error.toJSON());
      }
      throw error;
    }
  }

  // ===== 4. Using AxiosHeaders Class =====

  async demonstrateAxiosHeaders() {
    // Create headers using AxiosHeaders class
    const headers = new AxiosHeaders();
    headers.set('Content-Type', 'application/json');
    headers.set('X-Custom-Header', 'value');
    headers.set('Authorization', 'Bearer token123');
    headers.set('Content-Type', 'application/json; charset=utf-8');

    // AxiosHeaders methods
    console.log('Has Content-Type?', headers.has('content-type')); // Case-insensitive
    console.log('Get Content-Type:', headers.get('Content-Type'));  // Case-insensitive

    // Convert to plain object
    const plainHeaders = headers.toJSON();
    console.log('Plain headers:', plainHeaders);

    // Create from various sources
    const fromObject = AxiosHeaders.from({ 'X-Test': 'value' });
    const fromString = AxiosHeaders.from('Content-Type: text/html\nX-Test: value');
    const concatenated = AxiosHeaders.concat(headers, fromObject, fromString);

    // Use in request
    const response = await firstValueFrom(
      this.httpService.post('https://httpbin.org/post',
        { test: 'data' },
        { headers: headers.toJSON() as any }
      )
    );

    return response.data;
  }

  // ===== 5. Transform Functions (Axios Compatibility) =====

  async demonstrateTransforms() {
    // Note: transformRequest/transformResponse are handled via interceptors
    // This example shows how to achieve the same result
    const response = await firstValueFrom(
      this.httpService.post('https://httpbin.org/post',
        { name: 'John', age: 30, transformed: true },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    );

    // Transform response data in the interceptor or after receiving
    const transformedData = {
      ...response.data,
      processedAt: new Date().toISOString()
    };

    console.log('Transformed response:', transformedData);
    return transformedData;
  }

  // ===== 6. All HTTP Methods with Axios Signature =====

  async demonstrateHttpMethods() {
    const baseURL = 'https://jsonplaceholder.typicode.com';

    // GET request
    const getResponse = await firstValueFrom(
      this.httpService.get(`${baseURL}/posts/1`)
    );

    // POST request
    const postResponse = await firstValueFrom(
      this.httpService.post(`${baseURL}/posts`, {
        title: 'Test Post',
        body: 'This is a test',
        userId: 1
      })
    );

    // PUT request
    const putResponse = await firstValueFrom(
      this.httpService.put(`${baseURL}/posts/1`, {
        id: 1,
        title: 'Updated Post',
        body: 'This is updated',
        userId: 1
      })
    );

    // PATCH request
    const patchResponse = await firstValueFrom(
      this.httpService.patch(`${baseURL}/posts/1`, {
        title: 'Patched Title'
      })
    );

    // DELETE request
    const deleteResponse = await firstValueFrom(
      this.httpService.delete(`${baseURL}/posts/1`)
    );

    // HEAD request
    const headResponse = await firstValueFrom(
      this.httpService.head(`${baseURL}/posts/1`)
    );

    // Form data methods
    const formData = new URLSearchParams();
    formData.append('field1', 'value1');
    formData.append('field2', 'value2');

    const postFormResponse = await firstValueFrom(
      this.httpService.postForm('https://httpbin.org/post', formData)
    );

    return {
      get: getResponse.data,
      post: postResponse.data,
      put: putResponse.data,
      patch: patchResponse.data,
      delete: deleteResponse.data,
      head: headResponse.status,
      postForm: postFormResponse.data
    };
  }
}

// ===== 1. Axios-Compatible Module Configuration =====

@Module({
  imports: [
    HttpModule.register({
      // All these axios options are automatically detected and mapped!
      timeout: 5000,              // Mapped to headersTimeout & bodyTimeout
      maxRedirects: 5,           // Mapped to maxRedirections
      validateStatus: (status) => status < 500,  // Works exactly like axios

      // Request/response size limits (enforced via interceptors)
      maxBodyLength: 10 * 1024 * 1024,    // 10MB request body limit
      maxContentLength: 50 * 1024 * 1024,  // 50MB response body limit

      // Cookie support
      withCredentials: true,     // Enables automatic cookie handling

      // Basic authentication
      auth: {
        username: 'user',
        password: 'pass'
      },

      // Proxy configuration (automatically creates ProxyAgent)
      // Commented out to avoid connection errors in demo
      // proxy: {
      //   host: 'proxy.example.com',
      //   port: 8080,
      //   protocol: 'http'
      // },

      // Custom headers
      headers: {
        'User-Agent': 'My-App/1.0',
        'X-Custom-Header': 'value'
      }
    })
  ],
  providers: [AxiosCompatibilityService],
  exports: [AxiosCompatibilityService]
})
export class AxiosCompatibleModule {}

// ===== 7. Usage Example =====

@Module({
  imports: [AxiosCompatibleModule],
})
export class AppModule {}

// Export for testing
export async function demonstrateFeatures() {
  const { NestFactory } = require('@nestjs/core');
  const app = await NestFactory.createApplicationContext(AppModule);

  const service = app.get(AxiosCompatibilityService);

  try {
    console.log('\n=== Demonstrating Response Compatibility ===');
    await service.demonstrateResponseCompatibility();

    console.log('\n=== Demonstrating AxiosHeaders ===');
    await service.demonstrateAxiosHeaders();

    console.log('\n=== Demonstrating Transforms ===');
    await service.demonstrateTransforms();

    console.log('\n=== Demonstrating HTTP Methods ===');
    await service.demonstrateHttpMethods();

    console.log('\n✅ All axios compatibility features demonstrated successfully!');
  } catch (error) {
    console.error('❌ Error demonstrating features:', error);
    throw error;
  } finally {
    await app.close();
  }
}

// Run if called directly
if (require.main === module) {
  demonstrateFeatures().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
