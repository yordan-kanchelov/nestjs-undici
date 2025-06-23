import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from '@nestjs/axios';
import { map, catchError } from 'rxjs/operators';
import { firstValueFrom, throwError } from 'rxjs';
import { InternalAxiosRequestConfig, AxiosResponse } from 'axios';

@Injectable()
export class ApiService {
  constructor(private readonly httpService: HttpService) {
    // Add request interceptor
    this.httpService.axiosRef.interceptors.request.use(
      (config: InternalAxiosRequestConfig) => {
        console.log('🔵 Request Interceptor: Adding auth header');
        config.headers['Authorization'] = 'Bearer fake-token';
        config.headers['X-Custom-Header'] = 'interceptor-added-this';
        return config;
      },
      (error) => {
        console.log('❌ Request Interceptor Error:', error.message);
        return Promise.reject(error);
      }
    );

    // Add response interceptor
    this.httpService.axiosRef.interceptors.response.use(
      (response: AxiosResponse) => {
        console.log('🟢 Response Interceptor: Status', response.status);
        // Transform response data
        response.data = {
          ...response.data,
          intercepted: true,
          timestamp: new Date().toISOString()
        };
        return response;
      },
      (error) => {
        console.log('❌ Response Interceptor Error:', error.message);
        return Promise.reject(error);
      }
    );
  }

  async testRequest() {
    console.log('\n📡 Making request with @nestjs/axios interceptors...\n');
    
    try {
      const response = await firstValueFrom(
        this.httpService.get('https://jsonplaceholder.typicode.com/posts/1').pipe(
          map(response => response.data),
          catchError(error => {
            console.error('Request failed:', error.message);
            return throwError(() => error);
          })
        )
      );
      
      console.log('✅ Response received:', JSON.stringify(response, null, 2));
      console.log('\n🎯 Notice the "intercepted" and "timestamp" fields added by the response interceptor\n');
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
  }
}

@Module({
  imports: [HttpModule],
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