import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
import type { HttpInterceptor, HttpInterceptorHandler, HttpInterceptorRequest } from 'nestjs-undici-interceptors';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Dispatcher } from 'undici';

// Request interceptor that adds auth headers
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  intercept(
    request: HttpInterceptorRequest,
    next: HttpInterceptorHandler
  ): Observable<Dispatcher.ResponseData> {
    console.log('🔵 Auth Interceptor called');
    return next.handle(request);
  }
}

// Function-based interceptor
const loggingInterceptor = (
  request: HttpInterceptorRequest,
  next: HttpInterceptorHandler
): Observable<Dispatcher.ResponseData> => {
  console.log('📝 Function Interceptor called');
  return next.handle(request);
};

@Injectable()
export class ApiService {
  constructor(private readonly httpService: HttpService) {
    console.log('✅ HttpService initialized');
    
    // Debug what interceptors are registered
    console.log('Interceptors:', (this.httpService as any).interceptors);
    console.log('First interceptor type:', typeof (this.httpService as any).interceptors[0]);
    console.log('First interceptor toString:', (this.httpService as any).interceptors[0]?.toString?.());
    console.log('Is AuthInterceptor?', (this.httpService as any).interceptors[0] === AuthInterceptor);
    console.log('Is instance of AuthInterceptor?', (this.httpService as any).interceptors[0] instanceof AuthInterceptor);
  }

  async testRequest() {
    console.log('\n📡 Making request...\n');
    
    try {
      const observable = this.httpService.request('https://jsonplaceholder.typicode.com/posts/1');
      
      const response = await new Promise<any>((resolve, reject) => {
        observable.subscribe({
          next: (value) => resolve(value),
          error: (err) => reject(err)
        });
      });
      
      const data = await response.body.json();
      console.log('\n✅ Response received');
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
  }
}

@Module({
  imports: [
    HttpModule.register({
      interceptors: [
        AuthInterceptor,
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