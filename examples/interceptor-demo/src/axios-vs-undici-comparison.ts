import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

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
 * Service using nestjs-undici (native approach without adapter)
 */
@Injectable()
export class UndiciApiService {
  constructor(private readonly httpService: UndiciHttpService) {}

  async getPost(id: number): Promise<Post> {
    // With native Undici, response.body needs to be parsed
    const response = await lastValueFrom(
      this.httpService.request(`https://jsonplaceholder.typicode.com/posts/${id}`)
    );
    
    console.log('\n📦 Native Undici Response Structure:');
    console.log('  - response.body:', typeof response.body); // object (stream)
    console.log('  - response.statusCode:', response.statusCode); // 200
    console.log('  - response.headers:', Object.keys(response.headers).slice(0, 3));
    
    // Need to manually parse the body
    const data = await response.body.json();
    return data;
  }

  async createPost(data: Partial<Post>): Promise<Post> {
    const response = await lastValueFrom(
      this.httpService.request('https://jsonplaceholder.typicode.com/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    );
    
    return await response.body.json();
  }
}

/**
 * Service using nestjs-undici with Axios compatibility mode
 */
@Injectable()
export class UndiciAxiosCompatibleService {
  constructor(private readonly httpService: UndiciHttpService) {}

  async getPost(id: number): Promise<Post> {
    // With axios-compatible mode, works exactly like Axios!
    const response = await lastValueFrom(
      this.httpService.request(`https://jsonplaceholder.typicode.com/posts/${id}`)
    );
    
    console.log('\n📦 Undici with Axios Adapter Response Structure:');
    console.log('  - response.data:', typeof response.data); // object (already parsed!)
    console.log('  - response.status:', response.status);   // 200 (not statusCode)
    console.log('  - response.statusText:', response.statusText); // "OK"
    
    return response.data; // Same as Axios!
  }

  async createPost(data: Partial<Post>): Promise<Post> {
    const response = await lastValueFrom(
      this.httpService.request('https://jsonplaceholder.typicode.com/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).pipe(
        map(res => res.data) // Works with RxJS operators just like Axios!
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

@Module({
  imports: [UndiciHttpModule.registerAxiosCompatible({ timeout: 5000 })],
  providers: [UndiciAxiosCompatibleService],
})
export class UndiciAxiosCompatibleModule {}

async function bootstrap() {
  // Create all three modules for comparison
  const axiosApp = await NestFactory.create(AxiosModule);
  const undiciApp = await NestFactory.create(UndiciModule);
  const undiciCompatApp = await NestFactory.create(UndiciAxiosCompatibleModule);

  const axiosService = axiosApp.get(AxiosApiService);
  const undiciService = undiciApp.get(UndiciApiService);
  const undiciCompatService = undiciCompatApp.get(UndiciAxiosCompatibleService);

  console.log('🔄 Comparing HTTP Client Implementations\n');
  console.log('=' * 50);

  // Test GET requests
  console.log('\n1️⃣ GET Request Comparison:');
  
  const axiosPost = await axiosService.getPost(1);
  console.log('✅ Axios result:', axiosPost.title.substring(0, 30) + '...');
  
  const undiciPost = await undiciService.getPost(1);
  console.log('✅ Undici (native) result:', undiciPost.title.substring(0, 30) + '...');
  
  const undiciCompatPost = await undiciCompatService.getPost(1);
  console.log('✅ Undici (axios-compat) result:', undiciCompatPost.title.substring(0, 30) + '...');

  // Test POST requests
  console.log('\n2️⃣ POST Request Comparison:');
  
  const newPost = { title: 'Test Post', body: 'Test Body', userId: 1 };
  
  const axiosCreated = await axiosService.createPost(newPost);
  console.log('✅ Axios created post ID:', axiosCreated.id);
  
  const undiciCreated = await undiciService.createPost(newPost);
  console.log('✅ Undici (native) created post ID:', undiciCreated.id);
  
  const undiciCompatCreated = await undiciCompatService.createPost(newPost);
  console.log('✅ Undici (axios-compat) created post ID:', undiciCompatCreated.id);

  console.log('\n📊 Summary:');
  console.log('- @nestjs/axios: Traditional Axios-based HTTP client');
  console.log('- nestjs-undici (native): Requires manual body parsing');
  console.log('- nestjs-undici (axios-compat): Drop-in replacement for Axios! 🎉');

  await axiosApp.close();
  await undiciApp.close();
  await undiciCompatApp.close();
}

bootstrap().catch(console.error);