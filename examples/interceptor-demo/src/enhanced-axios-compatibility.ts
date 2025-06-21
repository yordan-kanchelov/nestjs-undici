import 'reflect-metadata';
import { Module, Injectable, OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
import { lastValueFrom } from 'rxjs';
import * as http from 'http';
import * as https from 'https';

/**
 * This example demonstrates the enhanced axios compatibility in nestjs-undici-interceptors
 * showing how the standard register() method now supports axios-style configuration
 * and interceptor APIs without requiring a separate registration method.
 */

interface User {
  id: number;
  name: string;
  email: string;
}

@Injectable()
export class UserService implements OnModuleInit {
  constructor(private readonly httpService: HttpService) {}

  onModuleInit() {
    // Use axios-style interceptors with httpService.axiosRef
    this.httpService.axiosRef.interceptors.request.use(
      (config) => {
        console.log(`[Request] ${config.method?.toUpperCase()} ${config.url}`);
        config.headers = config.headers || {};
        config.headers['X-Request-ID'] = Math.random().toString(36).substring(7);
        return config;
      },
      (error) => {
        console.error('[Request Error]', error);
        return Promise.reject(error);
      }
    );

    this.httpService.axiosRef.interceptors.response.use(
      (response) => {
        console.log(`[Response] ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        console.error(`[Response Error] ${error.response?.status} ${error.config?.url}`);
        return Promise.reject(error);
      }
    );

    // You can also still use the undici-style interceptors
    this.httpService.addInterceptor((request, next) => {
      console.log('[Undici Interceptor] Request:', request.url);
      return next.handle(request);
    });
  }

  async getUser(id: number): Promise<User> {
    // baseURL is automatically applied for relative URLs
    const response = await lastValueFrom(
      this.httpService.get<User>(`/users/${id}`)
    );
    return response.data;
  }

  async createUser(user: Omit<User, 'id'>): Promise<User> {
    const response = await lastValueFrom(
      this.httpService.post<User>('/users', user)
    );
    return response.data;
  }

  async getAllUsers(): Promise<User[]> {
    const response = await lastValueFrom(
      this.httpService.get<User[]>('/users')
    );
    return response.data;
  }
}

@Module({
  imports: [
    HttpModule.register({
      // Axios-compatible configuration options
      baseURL: 'https://jsonplaceholder.typicode.com',
      timeout: 5000,
      maxRedirects: 5,
      
      // Axios agents are automatically detected and handled
      httpAgent: new http.Agent({
        keepAlive: true,
        maxSockets: 100,
      }),
      httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 100,
      }),
      
      // Auth configuration
      auth: {
        username: 'user',
        password: 'pass',
      },
      
      // Transform functions are converted to interceptors
      transformRequest: [(data, headers) => {
        // Add timestamp to all requests
        if (data && typeof data === 'object') {
          return JSON.stringify({
            ...data,
            _timestamp: Date.now(),
          });
        }
        return data;
      }],
      
      transformResponse: [(data) => {
        // Parse and add metadata to responses
        if (typeof data === 'string') {
          try {
            const parsed = JSON.parse(data);
            return {
              ...parsed,
              _received: Date.now(),
            };
          } catch {
            return data;
          }
        }
        return data;
      }],
      
      // Custom validation function
      validateStatus: (status) => status >= 200 && status < 300,
      
      // You can still add undici-style interceptors
      interceptors: [
        (request, next) => {
          console.log('[Custom Interceptor] Processing request');
          return next.handle(request);
        }
      ],
    }),
  ],
  providers: [UserService],
})
export class AppModule {}

async function demonstrateEnhancedCompatibility() {
  console.log('🚀 Enhanced Axios Compatibility Demo\n');
  console.log('The HttpModule.register() method now automatically detects and handles axios-style configuration!\n');

  const app = await NestFactory.create(AppModule);
  const userService = app.get(UserService);

  try {
    // Test 1: GET request with baseURL
    console.log('1️⃣ GET /users/1 (using baseURL)');
    const user = await userService.getUser(1);
    console.log('✅ User retrieved:', user.name);
    console.log('   Timestamp added by transformRequest:', (user as any)._timestamp);
    console.log('   Metadata added by transformResponse:', (user as any)._received);

    // Test 2: POST request
    console.log('\n2️⃣ POST /users');
    const newUser = await userService.createUser({
      name: 'John Doe',
      email: 'john@example.com',
    });
    console.log('✅ User created with ID:', newUser.id);

    // Test 3: GET all users
    console.log('\n3️⃣ GET /users');
    const users = await userService.getAllUsers();
    console.log('✅ Retrieved', users.length, 'users');

    console.log('\n✨ Key Features Demonstrated:');
    console.log('- Axios-style configuration (baseURL, agents, auth, etc.)');
    console.log('- Both axios and undici interceptor APIs work together');
    console.log('- transformRequest/transformResponse converted to interceptors');
    console.log('- Automatic warnings for unsupported features');
    console.log('- No separate registerAxiosCompatible() needed!');

  } catch (error) {
    console.error('❌ Error:', error);
  }

  await app.close();
}

// Run the demo
demonstrateEnhancedCompatibility().catch(console.error);