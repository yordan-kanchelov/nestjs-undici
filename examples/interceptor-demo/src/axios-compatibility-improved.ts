import 'reflect-metadata';
import { Module, Injectable, OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

/**
 * This example demonstrates the IMPROVED axios compatibility in nestjs-undici-interceptors
 * showing how the new features make migration from @nestjs/axios almost seamless.
 */

import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
import { lastValueFrom } from 'rxjs';

interface User {
  id: number;
  name: string;
  email: string;
}

@Injectable()
export class ApiService implements OnModuleInit {
  constructor(private readonly httpService: HttpService) {}

  onModuleInit() {
    // NEW: Use axios-style interceptor API!
    // Request interceptor
    this.httpService.axiosRef.interceptors.request.use(
      (config) => {
        console.log(`📤 Request: ${config.method} ${config.url}`);
        config.headers = config.headers || {};
        config.headers['Authorization'] = 'Bearer my-token';
        config.headers['X-Request-ID'] = Date.now().toString();
        return config;
      },
      (error) => {
        console.error('❌ Request error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.httpService.axiosRef.interceptors.response.use(
      (response) => {
        console.log(`📥 Response: ${response.status} ${response.statusText}`);
        return response;
      },
      (error) => {
        console.error('❌ Response error:', error.response?.status);
        // Can modify error or retry here
        return Promise.reject(error);
      }
    );

    // Can add multiple interceptors
    const loggingId = this.httpService.axiosRef.interceptors.request.use(
      (config) => {
        console.log(`⏱️  Timestamp: ${new Date().toISOString()}`);
        return config;
      }
    );

    // Can remove interceptors by ID (with warning)
    // this.httpService.axiosRef.interceptors.request.eject(loggingId);
  }

  async getUsers(): Promise<User[]> {
    try {
      // Works exactly like axios!
      const response = await lastValueFrom(
        this.httpService.get<User[]>('https://jsonplaceholder.typicode.com/users')
      );
      return response.data;
    } catch (error: any) {
      // Axios-compatible error structure
      if (error.response) {
        console.error('Server error:', error.response.status, error.response.data);
      } else if (error.request) {
        console.error('Network error:', error.message);
      } else {
        console.error('Unknown error:', error.message);
      }
      throw error;
    }
  }

  async createUser(user: Partial<User>): Promise<User> {
    const response = await lastValueFrom(
      this.httpService.post<User>('https://jsonplaceholder.typicode.com/users', user)
    );
    return response.data;
  }
}

@Module({
  imports: [
    // NEW: Use register for maximum compatibility!
    HttpModule.register({
      // Axios-style configuration
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
      // These will show warnings but are handled gracefully:
      // httpAgent: new http.Agent({ keepAlive: true }),
      // proxy: { host: 'proxy.example.com', port: 8080 },
    }),
  ],
  providers: [ApiService],
})
export class AppModule {}

// Demonstrate migration patterns
async function demonstrateImprovedCompatibility() {
  console.log('🚀 Demonstrating Improved Axios Compatibility\n');

  const app = await NestFactory.create(AppModule);
  const apiService = app.get(ApiService);

  console.log('📋 Key improvements:');
  console.log('1. ✅ httpService.axiosRef.interceptors API - works like axios!');
  console.log('2. ✅ Axios-style error handling with response/request/config');
  console.log('3. ✅ register() with config mapping');
  console.log('4. ✅ Support for validateStatus and other axios options');
  console.log('5. ✅ Warnings for unsupported features with migration hints\n');

  console.log('Making API calls...\n');

  // Test GET request
  const users = await apiService.getUsers();
  console.log(`\n✅ Fetched ${users.length} users`);

  // Test POST request
  const newUser = await apiService.createUser({
    name: 'Test User',
    email: 'test@example.com',
  });
  console.log(`✅ Created user with ID: ${newUser.id}`);

  console.log('\n🎉 Migration from @nestjs/axios is now much easier!');
  console.log('   Just change the import and use register()');

  await app.close();
}

// Show before/after comparison
console.log('📝 Migration Example:\n');
console.log('BEFORE (with @nestjs/axios):');
console.log('```typescript');
console.log("import { HttpModule, HttpService } from '@nestjs/axios';");
console.log('');
console.log('HttpModule.register({');
console.log('  timeout: 10000,');
console.log('  maxRedirects: 5,');
console.log('})');
console.log('');
console.log('httpService.axiosRef.interceptors.request.use(...)');
console.log('```\n');

console.log('AFTER (with nestjs-undici-interceptors):');
console.log('```typescript');
console.log("import { HttpModule, HttpService } from 'nestjs-undici-interceptors';");
console.log('');
console.log('HttpModule.register({  // Just add "AxiosCompatible"!');
console.log('  timeout: 10000,');
console.log('  maxRedirects: 5,');
console.log('})');
console.log('');
console.log('httpService.axiosRef.interceptors.request.use(...)  // Works the same!');
console.log('```\n');

// Run the demo
demonstrateImprovedCompatibility().catch(console.error);