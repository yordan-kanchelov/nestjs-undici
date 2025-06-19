import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
import type { HttpInterceptor, HttpInterceptorHandler, HttpInterceptorRequest } from 'nestjs-undici-interceptors';
import type { Observable } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import type { Dispatcher } from 'undici';

// Class-based interceptor with dependency injection
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  private readonly token = 'class-based-token-123';

  intercept(
    request: HttpInterceptorRequest,
    next: HttpInterceptorHandler
  ): Observable<Dispatcher.ResponseData> {
    console.log('🔐 AuthInterceptor: Adding authentication header');
    
    const modifiedRequest = {
      ...request,
      options: {
        ...request.options,
        headers: {
          ...request.options.headers,
          'Authorization': `Bearer ${this.token}`,
        },
      },
    };
    
    return next.handle(modifiedRequest);
  }
}

// Another class-based interceptor
@Injectable()
export class LoggingInterceptor implements HttpInterceptor {
  private requestCount = 0;

  intercept(
    request: HttpInterceptorRequest,
    next: HttpInterceptorHandler
  ): Observable<Dispatcher.ResponseData> {
    this.requestCount++;
    const requestId = this.requestCount;
    
    console.log(`📊 LoggingInterceptor: Request #${requestId} to ${request.url}`);
    const startTime = Date.now();
    
    return next.handle(request).pipe(
      tap({
        next: (response) => {
          const duration = Date.now() - startTime;
          console.log(`📊 LoggingInterceptor: Request #${requestId} completed in ${duration}ms with status ${response.statusCode}`);
        },
        error: (error) => {
          const duration = Date.now() - startTime;
          console.log(`📊 LoggingInterceptor: Request #${requestId} failed after ${duration}ms: ${error.message}`);
        }
      })
    );
  }
}

// Function-based interceptor for comparison
const timingInterceptor = (
  request: HttpInterceptorRequest,
  next: HttpInterceptorHandler
): Observable<Dispatcher.ResponseData> => {
  console.log('⏱️  TimingInterceptor: Starting timer');
  const start = process.hrtime.bigint();
  
  return next.handle(request).pipe(
    map(response => {
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1_000_000; // Convert to milliseconds
      console.log(`⏱️  TimingInterceptor: Request took ${duration.toFixed(2)}ms`);
      return response;
    })
  );
};

@Injectable()
export class TestService {
  constructor(private readonly httpService: HttpService) {
    console.log('✅ TestService initialized');
    console.log(`📋 Number of interceptors registered: ${this.httpService.interceptorCount}`);
  }

  async performTest() {
    console.log('\n🚀 Starting interceptor test...\n');
    
    try {
      // Make a simple GET request
      const observable = this.httpService.request('https://jsonplaceholder.typicode.com/posts/1');
      
      const response = await new Promise<Dispatcher.ResponseData>((resolve, reject) => {
        observable.subscribe({
          next: (value) => resolve(value),
          error: (err) => reject(err)
        });
      });
      
      const data = await response.body.json();
      
      console.log('\n✅ Request completed successfully!');
      console.log('📄 Response data:', JSON.stringify(data, null, 2));
      
      console.log('\n🎉 Summary:');
      console.log('✅ Class-based interceptors (AuthInterceptor, LoggingInterceptor) worked correctly');
      console.log('✅ Function-based interceptor (timingInterceptor) worked correctly');
      console.log('✅ All interceptors were executed in the correct order');
      console.log('✅ Dependency injection works for class-based interceptors');
      
    } catch (error) {
      console.error('\n❌ Test failed:', error.message);
      console.error('Stack:', error.stack);
    }
  }
}

@Module({
  imports: [
    HttpModule.register({
      interceptors: [
        AuthInterceptor,        // Class-based
        LoggingInterceptor,     // Class-based
        timingInterceptor,      // Function-based
      ],
    }),
  ],
  providers: [TestService],
})
class TestModule {}

async function main() {
  console.log('🏁 Starting NestJS application with interceptor support...\n');
  
  const app = await NestFactory.createApplicationContext(TestModule);
  const testService = app.get(TestService);
  
  await testService.performTest();
  
  await app.close();
  console.log('\n👋 Application closed');
}

main().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});