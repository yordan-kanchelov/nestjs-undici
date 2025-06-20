import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { HttpModule, HttpService } from '../src';
import { map } from 'rxjs/operators';

// Define a typed response
interface User {
  id: number;
  name: string;
  email: string;
}

@Module({
  imports: [HttpModule.register({})],
})
class AppModule {
  constructor(private httpService: HttpService) {}

  async demonstrateTypeInference() {
    console.log('=== Before Fix ===');
    console.log('The response type was: Dispatcher.ResponseData<null> | AxiosLikeResponse<User>');
    console.log('This caused TypeScript to not properly infer the type.\n');

    console.log('=== After Fix ===');
    console.log('The response type is now: Dispatcher.ResponseData<any> | AxiosLikeResponse<User>');
    console.log('TypeScript can now properly work with the response.\n');

    // Example 1: Using type guards
    console.log('Example 1: Using type guards');
    this.httpService.get<User>('https://api.example.com/user/1')
      .pipe(
        map(response => {
          // Check if it's an AxiosLikeResponse
          if ('data' in response) {
            // TypeScript knows response.data is of type User
            console.log('User data:', response.data);
            return response.data;
          }
          
          // Handle Dispatcher.ResponseData
          if ('body' in response) {
            console.log('Raw response body available');
            // Would need to parse response.body
          }
          
          return null;
        })
      )
      .subscribe();

    // Example 2: Using axios compatible mode
    console.log('\nExample 2: Using axios compatible mode');
    // When using HttpModule.registerAxiosCompatible(), 
    // the response is always AxiosLikeResponse<T>
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const appModule = app.get(AppModule);
  
  console.log('nestjs-undici Type Inference Fix Demo');
  console.log('=====================================\n');
  
  await appModule.demonstrateTypeInference();
  
  await app.close();
}

bootstrap();