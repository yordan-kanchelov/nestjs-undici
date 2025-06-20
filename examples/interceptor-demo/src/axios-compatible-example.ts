import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
import { lastValueFrom, firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';

interface Todo {
  userId: number;
  id: number;
  title: string;
  completed: boolean;
}

@Injectable()
export class TodoService {
  constructor(private readonly httpService: HttpService) {}

  /**
   * Example showing native Undici response handling
   */
  async getTodoNative(id: number): Promise<Todo> {
    const response = await lastValueFrom(
      this.httpService.request(`https://jsonplaceholder.typicode.com/todos/${id}`)
    );
    
    // Native Undici: need to parse body manually
    const data = await response.body.json();
    console.log('Native response statusCode:', response.statusCode);
    
    return data;
  }

  /**
   * Example showing Axios-compatible response handling
   */
  async getTodoAxiosStyle(id: number): Promise<Todo> {
    const response = await lastValueFrom(
      this.httpService.request(`https://jsonplaceholder.typicode.com/todos/${id}`)
    );
    
    // With axios adapter: data is already parsed!
    console.log('Axios-style response status:', response.status);
    console.log('Axios-style response statusText:', response.statusText);
    
    return response.data; // 🎉 Works like Axios!
  }

  /**
   * Using RxJS operators with Axios-style responses
   */
  async getTodoTitle(id: number): Promise<string> {
    return await firstValueFrom(
      this.httpService.request(`https://jsonplaceholder.typicode.com/todos/${id}`).pipe(
        map(response => response.data.title) // Direct access to data!
      )
    );
  }

  /**
   * Batch operations with type safety
   */
  async getTodos(ids: number[]): Promise<Todo[]> {
    const requests = ids.map(id => 
      firstValueFrom(
        this.httpService.request(`https://jsonplaceholder.typicode.com/todos/${id}`).pipe(
          map(res => res.data)
        )
      )
    );
    
    return Promise.all(requests);
  }
}

// Native module (without axios adapter)
@Module({
  imports: [HttpModule.register({ timeout: 5000 })],
  providers: [TodoService],
})
export class NativeModule {}

// Axios-compatible module
@Module({
  imports: [HttpModule.registerAxiosCompatible({ timeout: 5000 })],
  providers: [TodoService],
})
export class AxiosCompatModule {}

async function demonstrateComparison() {
  console.log('🔍 Comparing Native vs Axios-Compatible Responses\n');
  
  // Test with native response handling
  console.log('1️⃣ Native Undici Response Handling:');
  console.log('----------------------------------------');
  const nativeApp = await NestFactory.create(NativeModule);
  const nativeService = nativeApp.get(TodoService);
  
  try {
    const todo = await nativeService.getTodoNative(1);
    console.log('✅ Success:', todo.title);
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
  
  await nativeApp.close();
  
  // Test with axios-compatible response handling
  console.log('\n2️⃣ Axios-Compatible Response Handling:');
  console.log('----------------------------------------');
  const axiosApp = await NestFactory.create(AxiosCompatModule);
  const axiosService = axiosApp.get(TodoService);
  
  const todo = await axiosService.getTodoAxiosStyle(1);
  console.log('✅ Success:', todo.title);
  
  // Test RxJS operators
  console.log('\n3️⃣ Using RxJS Operators:');
  console.log('----------------------------------------');
  const title = await axiosService.getTodoTitle(2);
  console.log('✅ Todo title:', title);
  
  // Test batch operations
  console.log('\n4️⃣ Batch Operations:');
  console.log('----------------------------------------');
  const todos = await axiosService.getTodos([1, 2, 3]);
  console.log('✅ Fetched', todos.length, 'todos');
  todos.forEach(todo => {
    console.log(`   - ${todo.id}: ${todo.title.substring(0, 40)}...`);
  });
  
  await axiosApp.close();
}

// Main execution
async function bootstrap() {
  try {
    await demonstrateComparison();
    
    console.log('\n✨ Key Benefits of Axios Compatibility Mode:');
    console.log('------------------------------------------------');
    console.log('1. No need to manually parse response.body');
    console.log('2. Access data directly via response.data');
    console.log('3. Compatible with existing Axios code patterns');
    console.log('4. Works seamlessly with RxJS operators');
    console.log('5. Maintains Undici\'s performance benefits');
    console.log('\n🚀 Migration is as simple as:');
    console.log('   - Change: HttpModule.register(...)');
    console.log('   - To:     HttpModule.registerAxiosCompatible(...)');
    
  } catch (error) {
    console.error('Error:', error);
  }
}

bootstrap().catch(console.error);