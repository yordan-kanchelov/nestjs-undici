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
    console.log('🔵 Request Interceptor: Adding auth header');
    
    // Modify the request by adding headers
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
    
    // Pass the modified request to the next handler
    return next.handle(modifiedRequest);
  }
}

// Response interceptor that transforms the response
@Injectable()
export class ResponseTransformInterceptor implements HttpInterceptor {
  intercept(
    request: HttpInterceptorRequest,
    next: HttpInterceptorHandler
  ): Observable<Dispatcher.ResponseData> {
    console.log('🟡 Response Transform Interceptor: Processing...');
    
    return next.handle(request).pipe(
      map(response => {
        console.log('🟢 Response Interceptor: Status', response.statusCode);
        
        // Note: In undici, we can't modify the response body directly
        // But we can log, handle errors, or trigger side effects
        return response;
      })
    );
  }
}

// Function-based interceptor
const loggingInterceptor = (
  request: HttpInterceptorRequest,
  next: HttpInterceptorHandler
): Observable<Dispatcher.ResponseData> => {
  console.log('📝 Logging Interceptor: Request to', request.url);
  const startTime = Date.now();
  
  return next.handle(request).pipe(
    map(response => {
      const duration = Date.now() - startTime;
      console.log(`📝 Logging Interceptor: Request completed in ${duration}ms`);
      return response;
    })
  );
};

@Injectable()
export class ApiService {
  constructor(
    private readonly httpService: HttpService,
    private readonly authInterceptor: AuthInterceptor,
    private readonly responseInterceptor: ResponseTransformInterceptor,
  ) {
    console.log('✅ HttpService initialized');
    
    // Add class-based interceptors dynamically (properly instantiated)
    this.httpService.addInterceptor(this.authInterceptor);
    this.httpService.addInterceptor(this.responseInterceptor);
    this.httpService.addInterceptor(loggingInterceptor);
    
    console.log(`✅ Number of interceptors: ${this.httpService.interceptorCount}`);
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
      console.log('✅ Timing was tracked by interceptor');
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
  }
}

@Module({
  imports: [
    HttpModule.register({
      // Only register function-based interceptors here
      interceptors: [],
    }),
  ],
  providers: [
    ApiService, 
    AuthInterceptor, 
    ResponseTransformInterceptor
  ],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const apiService = app.get(ApiService);
  
  await apiService.testRequest();
  
  await app.close();
}

bootstrap().catch(console.error);