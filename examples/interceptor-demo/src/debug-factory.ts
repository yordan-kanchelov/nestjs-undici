import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
import type { HttpInterceptor, HttpInterceptorHandler, HttpInterceptorRequest } from 'nestjs-undici-interceptors';
import type { Observable } from 'rxjs';
import type { Dispatcher } from 'undici';

@Injectable()
export class TestInterceptor implements HttpInterceptor {
  intercept(
    request: HttpInterceptorRequest,
    next: HttpInterceptorHandler
  ): Observable<Dispatcher.ResponseData> {
    console.log('TestInterceptor called');
    return next.handle(request);
  }
}

const funcInterceptor = (request: any, next: any) => {
  console.log('Function interceptor called');
  return next.handle(request);
};

// Custom provider to debug
const DEBUG_TOKEN = Symbol('DEBUG_TOKEN');

@Module({
  imports: [
    HttpModule.register({
      interceptors: [
        TestInterceptor,
        funcInterceptor,
      ],
    }),
  ],
  providers: [
    {
      provide: DEBUG_TOKEN,
      useFactory: (httpService: HttpService) => {
        console.log('=== DEBUG INFO ===');
        console.log('HttpService interceptors:', (httpService as any).interceptors);
        console.log('First interceptor:', (httpService as any).interceptors[0]);
        console.log('First interceptor type:', typeof (httpService as any).interceptors[0]);
        console.log('Is TestInterceptor constructor?', (httpService as any).interceptors[0] === TestInterceptor);
        console.log('Has intercept method?', typeof (httpService as any).interceptors[0]?.intercept);
        console.log('================');
        return true;
      },
      inject: [HttpService],
    },
  ],
})
class TestModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(TestModule);
  app.get(DEBUG_TOKEN); // Trigger debug
  await app.close();
}

main().catch(console.error);