import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici';

@Injectable()
export class ApiService {
  constructor(private readonly httpService: HttpService) {
    // This will fail because nestjs-undici doesn't support interceptors
    console.log('❌ Trying to add interceptors to nestjs-undici...');
    
    // These properties don't exist on the current implementation
    // this.httpService.axiosRef.interceptors.request.use(...) // ❌ No axiosRef
    // this.httpService.interceptors.request.use(...) // ❌ No interceptors property
    
    console.log('❌ Cannot add interceptors - property does not exist!');
    console.log('Available properties:', Object.keys(this.httpService));
    console.log('Available methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(this.httpService)));
  }

  async testRequest() {
    console.log('\n📡 Making request with nestjs-undici (no interceptor support)...\n');
    
    try {
      // Make a simple request - works fine
      const observable = this.httpService.request('https://jsonplaceholder.typicode.com/posts/1');
      
      // Convert to promise manually
      const response = await new Promise((resolve, reject) => {
        observable.subscribe({
          next: (value) => resolve(value),
          error: (err) => reject(err)
        });
      });
      
      const data = await (response as any).body.json();
      console.log('✅ Response received:', JSON.stringify(data, null, 2));
      console.log('\n❌ No way to intercept/modify requests or responses!\n');
      console.log('⚠️  Cannot add auth headers globally');
      console.log('⚠️  Cannot transform responses globally');
      console.log('⚠️  Cannot implement retry logic globally');
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