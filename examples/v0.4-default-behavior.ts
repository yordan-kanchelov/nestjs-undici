import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
import { firstValueFrom } from 'rxjs';

/**
 * Example demonstrating the new default behavior in v0.4.0
 * 
 * Starting from v0.4.0, axios-compatible mode is the DEFAULT behavior.
 * This means you get axios-style responses without any special configuration.
 */

interface Todo {
  userId: number;
  id: number;
  title: string;
  completed: boolean;
}

@Injectable()
export class TodoService {
  constructor(private readonly httpService: HttpService) {}

  // ✅ NEW DEFAULT: Axios-compatible responses
  async getTodo(id: number): Promise<Todo> {
    const response = await firstValueFrom(
      this.httpService.get<Todo>(`https://jsonplaceholder.typicode.com/todos/${id}`)
    );
    
    // response.data is already parsed JSON
    console.log('Status:', response.status);         // 200
    console.log('Status Text:', response.statusText); // "OK"
    console.log('Headers:', response.headers);
    
    return response.data; // Direct access to parsed data!
  }

  // ✅ Error handling works like axios
  async getTodoWithErrorHandling(id: number): Promise<Todo | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<Todo>(`https://jsonplaceholder.typicode.com/todos/${id}`)
      );
      return response.data;
    } catch (error: any) {
      // Errors are axios-compatible
      if (error.isAxiosError) {
        console.log('Request failed with status:', error.response?.status);
        console.log('Error message:', error.message);
      }
      return null;
    }
  }

  // ✅ All convenience methods work as expected
  async createTodo(todo: Partial<Todo>): Promise<Todo> {
    const response = await firstValueFrom(
      this.httpService.post<Todo>(
        'https://jsonplaceholder.typicode.com/todos',
        todo
      )
    );
    return response.data;
  }

  // ✅ Custom validateStatus works
  async checkTodoExists(id: number): Promise<boolean> {
    const response = await firstValueFrom(
      this.httpService.get(`https://jsonplaceholder.typicode.com/todos/${id}`, {
        validateStatus: (status) => status < 500, // Don't throw on 404
      })
    );
    
    return response.status === 200;
  }
}

// Module using the new default behavior
@Module({
  imports: [
    HttpModule.register({
      // No special configuration needed!
      // Axios-compatible mode is now the default
      timeout: 5000,
    }),
  ],
  providers: [TodoService],
})
export class AppModule {}

// Module explicitly using native mode (if you need raw Undici responses)
@Module({
  imports: [
    HttpModule.register({
      nativeMode: true, // Opt into raw Undici responses
      timeout: 5000,
    }),
  ],
  providers: [TodoService],
})
export class NativeModeModule {}

async function demonstrateNewDefaults() {
  console.log('🚀 nestjs-undici-interceptors v0.4.0 - New Default Behavior\n');
  console.log('='.repeat(60));
  
  const app = await NestFactory.create(AppModule);
  const todoService = app.get(TodoService);

  // Test 1: Basic GET request
  console.log('\n1️⃣  Basic GET Request:');
  console.log('-'.repeat(30));
  const todo = await todoService.getTodo(1);
  console.log('✅ Todo retrieved:', todo.title);

  // Test 2: Error handling
  console.log('\n2️⃣  Error Handling (404):');
  console.log('-'.repeat(30));
  const notFound = await todoService.getTodoWithErrorHandling(9999);
  console.log(notFound ? '❌ Unexpected success' : '✅ Handled 404 error gracefully');

  // Test 3: POST request
  console.log('\n3️⃣  POST Request:');
  console.log('-'.repeat(30));
  const newTodo = await todoService.createTodo({
    title: 'Test todo from v0.4.0',
    completed: false,
    userId: 1,
  });
  console.log('✅ Created todo:', newTodo);

  // Test 4: Custom validation
  console.log('\n4️⃣  Custom Validation (check existence):');
  console.log('-'.repeat(30));
  const exists = await todoService.checkTodoExists(1);
  const notExists = await todoService.checkTodoExists(9999);
  console.log('✅ Todo 1 exists:', exists);
  console.log('✅ Todo 9999 exists:', notExists);

  await app.close();

  console.log('\n' + '='.repeat(60));
  console.log('\n📝 Summary of v0.4.0 Changes:');
  console.log('-'.repeat(40));
  console.log('1. Axios-compatible responses are now DEFAULT');
  console.log('2. No need to use registerAxiosCompatible()');
  console.log('3. response.data gives you parsed JSON directly');
  console.log('4. Errors have isAxiosError property');
  console.log('5. All convenience methods return AxiosLikeResponse');
  console.log('\n💡 To use raw Undici responses, add:');
  console.log('   { nativeMode: true } to your config');
  console.log('\n🔗 See migration guide in README.md');
}

// Run the demonstration
demonstrateNewDefaults().catch(console.error);