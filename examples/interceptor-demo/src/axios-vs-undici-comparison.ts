import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

/**
 * IMPORTANT: While nestjs-undici-interceptors provides axios-compatible responses,
 * there are some API differences to be aware of when migrating:
 * 
 * 1. Configuration options differ (httpAgent/httpsAgent vs custom options)
 * 2. Interceptors API is different (axiosRef.interceptors vs addInterceptor())
 * 3. Some axios-specific features may need adaptation
 * 
 * See the examples below for migration patterns.
 */

// Import both libraries for comparison
import { HttpModule as AxiosHttpModule, HttpService as AxiosHttpService } from '@nestjs/axios';
import { HttpModule as UndiciHttpModule, HttpService as UndiciHttpService } from 'nestjs-undici-interceptors';

import { lastValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';

interface Post {
  userId: number;
  id: number;
  title: string;
  body: string;
}

/**
 * Service using @nestjs/axios (traditional approach)
 */
@Injectable()
export class AxiosApiService {
  constructor(private readonly httpService: AxiosHttpService) {}

  async getPost(id: number): Promise<Post> {
    // With Axios, response.data contains the parsed JSON
    const response = await lastValueFrom(
      this.httpService.get<Post>(`https://jsonplaceholder.typicode.com/posts/${id}`)
    );
    
    console.log('📦 Axios Response Structure:');
    console.log('  - response.data:', typeof response.data); // object (already parsed)
    console.log('  - response.status:', response.status);   // 200
    console.log('  - response.statusText:', response.statusText); // "OK"
    
    return response.data; // Direct access to parsed data
  }

  async createPost(data: Partial<Post>): Promise<Post> {
    const response = await lastValueFrom(
      this.httpService.post<Post>('https://jsonplaceholder.typicode.com/posts', data).pipe(
        map(res => res.data) // Extract data using RxJS
      )
    );
    
    return response;
  }
}

/**
 * Service using nestjs-undici (v0.4.0+ - always axios-compatible)
 */
@Injectable()
export class UndiciApiService {
  constructor(private readonly httpService: UndiciHttpService) {}

  async getPost(id: number): Promise<Post> {
    // In v0.4.0+, responses are always axios-compatible!
    const response = await lastValueFrom(
      this.httpService.get<Post>(`https://jsonplaceholder.typicode.com/posts/${id}`)
    );
    
    console.log('\n📦 Undici v0.4.0+ Response Structure:');
    console.log('  - response.data:', typeof response.data); // object (already parsed!)
    console.log('  - response.status:', response.status); // 200
    console.log('  - response.statusText:', response.statusText); // "OK"
    
    return response.data; // Direct access, just like Axios!
  }

  async createPost(data: Partial<Post>): Promise<Post> {
    const response = await lastValueFrom(
      this.httpService.post<Post>('https://jsonplaceholder.typicode.com/posts', data).pipe(
        map(res => res.data) // Works exactly like Axios!
      )
    );
    
    return response;
  }
}


// Module configurations
@Module({
  imports: [AxiosHttpModule.register({ timeout: 5000 })],
  providers: [AxiosApiService],
})
export class AxiosModule {}

@Module({
  imports: [UndiciHttpModule.register({ timeout: 5000 })],
  providers: [UndiciApiService],
})
export class UndiciModule {}

async function bootstrap() {
  // Create both modules for comparison
  const axiosApp = await NestFactory.create(AxiosModule);
  const undiciApp = await NestFactory.create(UndiciModule);

  const axiosService = axiosApp.get(AxiosApiService);
  const undiciService = undiciApp.get(UndiciApiService);

  console.log('🔄 Comparing HTTP Client Implementations\n');
  console.log('='.repeat(50));

  // Test GET requests
  console.log('\n1️⃣ GET Request Comparison:');
  
  const axiosPost = await axiosService.getPost(1);
  console.log('✅ Axios result:', axiosPost.title.substring(0, 30) + '...');
  
  const undiciPost = await undiciService.getPost(1);
  console.log('✅ Undici (v0.4.0+) result:', undiciPost.title.substring(0, 30) + '...');

  // Test POST requests
  console.log('\n2️⃣ POST Request Comparison:');
  
  const newPost = { title: 'Test Post', body: 'Test Body', userId: 1 };
  
  const axiosCreated = await axiosService.createPost(newPost);
  console.log('✅ Axios created post ID:', axiosCreated.id);
  
  const undiciCreated = await undiciService.createPost(newPost);
  console.log('✅ Undici (v0.4.0+) created post ID:', undiciCreated.id);

  console.log('\n📊 Summary:');
  console.log('- @nestjs/axios: Traditional Axios-based HTTP client');
  console.log('- nestjs-undici v0.4.0+: Drop-in replacement for Axios! 🎉');
  console.log('  • Same response structure as Axios');
  console.log('  • Better performance with Undici');
  console.log('  • Just change the import statement!');

  await axiosApp.close();
  await undiciApp.close();
}

bootstrap().catch(console.error);