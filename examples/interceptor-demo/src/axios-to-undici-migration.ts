import 'reflect-metadata';
import { Module, Injectable, OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as http from 'http';
import * as https from 'https';

/**
 * This example demonstrates ACTUAL migration patterns from @nestjs/axios to nestjs-undici-interceptors
 * showing the real API differences and how to handle them.
 */

// ============================================
// BEFORE: Using @nestjs/axios
// ============================================

import { HttpModule as AxiosHttpModule, HttpService as AxiosHttpService } from '@nestjs/axios';

@Injectable()
export class AxiosBasedService implements OnModuleInit {
  constructor(private readonly httpService: AxiosHttpService) {}

  onModuleInit() {
    // Axios uses axiosRef.interceptors
    this.httpService.axiosRef.interceptors.request.use((config) => {
      config.headers['Authorization'] = 'Bearer token';
      return config;
    });

    this.httpService.axiosRef.interceptors.response.use(
      (response) => {
        console.log('Response:', response.status);
        return response;
      },
      (error) => {
        console.error('Error:', error);
        return Promise.reject(error);
      }
    );
  }

  async getData() {
    // Response handling is the same
    const response = await this.httpService.get('/api/data').toPromise();
    return response.data;
  }
}

@Module({
  imports: [
    AxiosHttpModule.register({
      timeout: 5000,
      maxRedirects: 5,
      // Axios uses httpAgent/httpsAgent
      httpAgent: new http.Agent({
        keepAlive: true,
        maxSockets: 100,
      }),
      httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 100,
      }),
    }),
  ],
  providers: [AxiosBasedService],
})
export class AxiosModule {}

// ============================================
// AFTER: Using nestjs-undici-interceptors
// ============================================

import { 
  HttpModule as UndiciHttpModule, 
  HttpService as UndiciHttpService,
  HttpInterceptorRequest,
  HttpInterceptorHandler
} from 'nestjs-undici-interceptors';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class UndiciBasedService implements OnModuleInit {
  constructor(private readonly httpService: UndiciHttpService) {}

  onModuleInit() {
    // Undici uses addInterceptor with different signature
    this.httpService.addInterceptor(
      (request: HttpInterceptorRequest, next: HttpInterceptorHandler): Observable<any> => {
        // Modify request
        const updatedRequest: HttpInterceptorRequest = {
          ...request,
          options: {
            ...request.options,
            headers: {
              ...(request.options.headers as Record<string, string>),
              'Authorization': 'Bearer token',
            },
          },
        };

        // Handle response
        return next.handle(updatedRequest).pipe(
          tap({
            next: (response) => console.log('Response:', response.status),
            error: (error) => console.error('Error:', error),
          })
        );
      }
    );
  }

  async getData() {
    // Response handling IS the same - axios-compatible!
    const response = await this.httpService.get('/api/data').toPromise();
    return response.data;
  }
}

@Module({
  imports: [
    UndiciHttpModule.register({
      timeout: 5000,
      maxRedirections: 5, // Note: different property name
      // Undici doesn't use httpAgent/httpsAgent
      // Instead, you might need to configure the dispatcher
      // or use pool configuration options
    }),
  ],
  providers: [UndiciBasedService],
})
export class UndiciModule {}

// ============================================
// MIGRATION PATTERNS
// ============================================

/**
 * Key differences when migrating:
 * 
 * 1. INTERCEPTORS:
 *    - Axios: httpService.axiosRef.interceptors.request.use()
 *    - Undici: httpService.addInterceptor()
 * 
 * 2. CONFIGURATION:
 *    - Axios: httpAgent, httpsAgent, maxRedirects
 *    - Undici: Different options, maxRedirections
 * 
 * 3. INTERCEPTOR SIGNATURES:
 *    - Axios: Works with config objects
 *    - Undici: Works with HttpInterceptorRequest/Handler
 * 
 * 4. RESPONSE HANDLING:
 *    - Both return axios-compatible responses!
 *    - response.data, response.status, etc. work the same
 */

// Example: Migrating a complex interceptor
class ComplexMigrationExample {
  // BEFORE (Axios)
  setupAxiosInterceptors(httpService: AxiosHttpService) {
    // Request interceptor
    httpService.axiosRef.interceptors.request.use(
      (config) => {
        // Add auth token
        const token = this.getAuthToken();
        if (token) {
          config.headers['Authorization'] = `Bearer ${token}`;
        }
        
        // Add request ID
        config.headers['X-Request-ID'] = this.generateRequestId();
        
        // Log request
        console.log(`[${config.method?.toUpperCase()}] ${config.url}`);
        
        return config;
      },
      (error) => {
        console.error('Request error:', error);
        return Promise.reject(error);
      }
    );
  }

  // AFTER (Undici)
  setupUndiciInterceptors(httpService: UndiciHttpService) {
    httpService.addInterceptor(
      (request: HttpInterceptorRequest, next: HttpInterceptorHandler): Observable<any> => {
        // Add auth token
        const token = this.getAuthToken();
        const headers: Record<string, string> = {
          ...(request.options.headers as Record<string, string>),
        };
        
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        
        // Add request ID
        headers['X-Request-ID'] = this.generateRequestId();
        
        // Log request
        console.log(`[${request.options.method || 'GET'}] ${request.url}`);
        
        // Create updated request
        const updatedRequest: HttpInterceptorRequest = {
          ...request,
          options: {
            ...request.options,
            headers,
          },
        };
        
        return next.handle(updatedRequest);
      }
    );
  }

  private getAuthToken(): string | null {
    return 'example-token';
  }

  private generateRequestId(): string {
    return Math.random().toString(36).substring(7);
  }
}

// ============================================
// DEMO
// ============================================

async function demonstrateMigration() {
  console.log('🔄 Demonstrating Axios to Undici Migration\n');

  // Both modules can coexist during migration
  const axiosApp = await NestFactory.create(AxiosModule);
  const undiciApp = await NestFactory.create(UndiciModule);

  console.log('✅ Both Axios and Undici modules created successfully');
  console.log('\n📝 Migration checklist:');
  console.log('1. Update imports');
  console.log('2. Modify interceptor implementations');
  console.log('3. Adjust configuration options');
  console.log('4. Test thoroughly - response handling remains the same!');

  await axiosApp.close();
  await undiciApp.close();
}

// Run the demo
demonstrateMigration().catch(console.error);