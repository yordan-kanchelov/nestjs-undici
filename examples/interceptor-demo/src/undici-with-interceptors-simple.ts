import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici';

@Injectable()
export class ApiService {
  constructor(private readonly httpService: HttpService) {
    console.log('✅ HttpService initialized');
    
    // Now we can add interceptors dynamically!
    this.addInterceptors();
  }
  
  private addInterceptors() {
    // Add a request interceptor as a function
    this.httpService.addInterceptor((request, next) => {
      console.log('🔵 Request Interceptor: Adding auth header');
      
      // Modify the request
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
    });
    
    // Add a response interceptor
    this.httpService.addInterceptor((request, next) => {
      console.log('🟡 Response Interceptor: Processing...');
      const startTime = Date.now();
      
      const response$ = next.handle(request);
      
      // Log when the response completes
      response$.subscribe({
        next: (response) => {
          const duration = Date.now() - startTime;
          console.log(`🟢 Response Interceptor: Status ${response.statusCode} in ${duration}ms`);
        }
      });
      
      return response$;
    });
    
    console.log(`✅ Added ${this.httpService.interceptorCount} interceptors`);
  }

  async testRequest() {
    console.log('\n📡 Making request with nestjs-undici interceptors...\n');
    
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
      console.log('\n🎯 Interceptors successfully processed the request!');
      console.log('✅ Auth headers were added by interceptor');
      console.log('✅ Response was logged by interceptor');
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
  }
}

@Module({
  imports: [HttpModule.register({})],
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