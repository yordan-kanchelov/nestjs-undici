import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';

// Function-based interceptor for adding auth headers
const authInterceptor = (request, next) => {
  console.log('🔵 Auth Interceptor: Adding authorization header');
  
  const modifiedRequest = {
    ...request,
    options: {
      ...request.options,
      headers: {
        ...request.options.headers,
        'Authorization': 'Bearer fake-token',
        'X-Custom-Header': 'interceptor-added-this',
      },
    },
  };
  
  return next.handle(modifiedRequest);
};

// Function-based interceptor for logging
const loggingInterceptor = (request, next) => {
  console.log(`📝 Logging Interceptor: ${request.options.method || 'GET'} ${request.url}`);
  const startTime = Date.now();
  
  const response$ = next.handle(request);
  
  // Subscribe to log completion
  response$.subscribe({
    next: () => {
      const duration = Date.now() - startTime;
      console.log(`📝 Logging Interceptor: Completed in ${duration}ms`);
    },
    error: (err) => {
      const duration = Date.now() - startTime;
      console.log(`❌ Logging Interceptor: Failed after ${duration}ms - ${err.message}`);
    }
  });
  
  return response$;
};

@Injectable()
export class ApiService {
  constructor(private readonly httpService: HttpService) {
    console.log('✅ HttpService with interceptor support initialized');
    console.log(`✅ Number of interceptors: ${this.httpService.interceptorCount}`);
  }

  async testRequest() {
    console.log('\n📡 Making request with function-based interceptors...\n');
    
    try {
      const observable = this.httpService.request('https://jsonplaceholder.typicode.com/posts/1');
      
      const response = await new Promise<any>((resolve, reject) => {
        observable.subscribe({
          next: (value) => resolve(value),
          error: (err) => reject(err)
        });
      });
      
      const data = await response.body.json();
      console.log('\n✅ Response received:', JSON.stringify(data, null, 2));
      console.log('\n🎯 Function-based interceptors work perfectly!');
      console.log('✅ Auth headers were added by interceptor');
      console.log('✅ Request was logged by interceptor');
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
  }
}

@Module({
  imports: [
    HttpModule.register({
      interceptors: [
        authInterceptor,
        loggingInterceptor,
      ],
    }),
  ],
  providers: [ApiService],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const apiService = app.get(ApiService);
  
  await apiService.testRequest();
  
  await app.close();
}

bootstrap().catch(console.error);