import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';

// Example 1: Function-based interceptor for adding auth headers
const authInterceptor = (request, next) => {
  console.log('🔵 Auth Interceptor: Adding authorization header');
  
  const modifiedRequest = {
    ...request,
    options: {
      ...request.options,
      headers: {
        ...request.options.headers,
        'Authorization': 'Bearer my-secret-token',
        'X-API-Key': 'my-api-key',
      },
    },
  };
  
  return next.handle(modifiedRequest);
};

// Example 2: Function-based interceptor for logging
const loggingInterceptor = (request, next) => {
  const startTime = Date.now();
  console.log(`📝 Logging Interceptor: ${request.options.method || 'GET'} ${request.url}`);
  
  const response$ = next.handle(request);
  
  // Create a new observable that logs when complete
  return new (response$.constructor)(subscriber => {
    response$.subscribe({
      next: (value) => {
        const duration = Date.now() - startTime;
        console.log(`📝 Logging Interceptor: Completed in ${duration}ms`);
        subscriber.next(value);
      },
      error: (err) => {
        const duration = Date.now() - startTime;
        console.log(`❌ Logging Interceptor: Failed after ${duration}ms`);
        subscriber.error(err);
      },
      complete: () => subscriber.complete(),
    });
  });
};

// Example 3: Error handling interceptor
const errorHandlingInterceptor = (request, next) => {
  return new (next.handle(request).constructor)(subscriber => {
    next.handle(request).subscribe({
      next: (value) => subscriber.next(value),
      error: (err) => {
        console.log('🚨 Error Interceptor: Caught error:', err.message);
        // You could transform the error or retry here
        subscriber.error(err);
      },
      complete: () => subscriber.complete(),
    });
  });
};

@Injectable()
export class ApiService {
  constructor(private readonly httpService: HttpService) {
    console.log('✅ HttpService initialized');
    console.log(`📊 Number of interceptors from config: ${this.httpService.interceptorCount}`);
  }

  async makeSuccessfulRequest() {
    console.log('\n✅ Testing successful request with interceptors...\n');
    
    try {
      const observable = this.httpService.request('https://jsonplaceholder.typicode.com/users/1');
      
      const response = await new Promise<any>((resolve, reject) => {
        observable.subscribe({
          next: (value) => resolve(value),
          error: (err) => reject(err)
        });
      });
      
      const data = await response.body.json();
      console.log('\n📦 Response data:', JSON.stringify(data, null, 2).substring(0, 200) + '...');
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
  }

  async makeFailingRequest() {
    console.log('\n❌ Testing failing request with interceptors...\n');
    
    try {
      const observable = this.httpService.request('https://httpstat.us/500');
      
      const response = await new Promise<any>((resolve, reject) => {
        observable.subscribe({
          next: (value) => resolve(value),
          error: (err) => reject(err)
        });
      });
      
      console.log('Response status:', response.statusCode);
    } catch (error) {
      console.error('❌ Request failed as expected:', error.message);
    }
  }

  async demonstrateDynamicInterceptor() {
    console.log('\n🔄 Adding a dynamic interceptor...\n');
    
    // Add a new interceptor at runtime
    this.httpService.addInterceptor((request, next) => {
      console.log('🆕 Dynamic Interceptor: This was added at runtime!');
      return next.handle(request);
    });
    
    console.log(`📊 Total interceptors now: ${this.httpService.interceptorCount}`);
    
    // Make a request to see the new interceptor in action
    const observable = this.httpService.request('https://jsonplaceholder.typicode.com/posts/1');
    const response = await new Promise<any>((resolve, reject) => {
      observable.subscribe({
        next: (value) => resolve(value),
        error: (err) => reject(err)
      });
    });
    
    console.log('✅ Dynamic interceptor executed successfully');
  }
}

@Module({
  imports: [
    HttpModule.register({
      // Register function-based interceptors
      interceptors: [
        authInterceptor,
        loggingInterceptor,
        errorHandlingInterceptor,
      ],
    }),
  ],
  providers: [ApiService],
})
class AppModule {}

async function bootstrap() {
  console.log('🚀 NestJS Undici Interceptor Demo\n');
  console.log('This example demonstrates:');
  console.log('1. Function-based interceptors');
  console.log('2. Request modification (adding headers)');
  console.log('3. Response logging');
  console.log('4. Error handling');
  console.log('5. Dynamic interceptor addition\n');
  
  const app = await NestFactory.createApplicationContext(AppModule);
  const apiService = app.get(ApiService);
  
  // Run all demonstrations
  await apiService.makeSuccessfulRequest();
  await apiService.makeFailingRequest();
  await apiService.demonstrateDynamicInterceptor();
  
  console.log('\n✅ All demonstrations completed!');
  
  await app.close();
}

bootstrap().catch(console.error);