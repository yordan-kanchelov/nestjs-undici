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
   * Example showing axios-compatible response handling (always default in v0.4.0+)
   */
  async getTodo(id: number): Promise<Todo> {
    const response = await lastValueFrom(
      this.httpService.get<Todo>(`https://jsonplaceholder.typicode.com/todos/${id}`)
    );
    
    // Responses are always axios-compatible!
    console.log('Response status:', response.status);
    console.log('Response statusText:', response.statusText);
    
    return response.data; // 🎉 Direct access to parsed data!
  }

  /**
   * Using convenience methods with type safety
   */
  async createTodo(todo: Omit<Todo, 'id'>): Promise<Todo> {
    const response = await lastValueFrom(
      this.httpService.post<Todo>('https://jsonplaceholder.typicode.com/todos', todo)
    );
    
    console.log('Created todo with ID:', response.data.id);
    return response.data;
  }

  /**
   * Using RxJS operators with axios-style responses
   */
  async getTodoTitle(id: number): Promise<string> {
    return await firstValueFrom(
      this.httpService.get<Todo>(`https://jsonplaceholder.typicode.com/todos/${id}`).pipe(
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
        this.httpService.get<Todo>(`https://jsonplaceholder.typicode.com/todos/${id}`).pipe(
          map(res => res.data)
        )
      )
    );
    
    return Promise.all(requests);
  }
}

// Module configuration (always axios-compatible in v0.4.0+)
@Module({
  imports: [HttpModule.register({ timeout: 5000 })],
  providers: [TodoService],
})
export class AppModule {}

async function demonstrateAxiosCompatibility() {
  console.log('🎯 Demonstrating Axios-Compatible Features (v0.4.0+)\n');
  
  const app = await NestFactory.create(AppModule);
  const todoService = app.get(TodoService);
  
  // Test 1: GET request with typed response
  console.log('1️⃣ GET Request:');
  console.log('----------------------------------------');
  const todo = await todoService.getTodo(1);
  console.log('✅ Retrieved todo:', todo.title);
  
  // Test 2: POST request
  console.log('\n2️⃣ POST Request:');
  console.log('----------------------------------------');
  const newTodo = await todoService.createTodo({
    userId: 1,
    title: 'Test axios compatibility',
    completed: false
  });
  console.log('✅ Created todo with ID:', newTodo.id);
  
  // Test 3: RxJS operators
  console.log('\n3️⃣ Using RxJS Operators:');
  console.log('----------------------------------------');
  const title = await todoService.getTodoTitle(2);
  console.log('✅ Todo title:', title);
  
  // Test 4: Batch operations
  console.log('\n4️⃣ Batch Operations:');
  console.log('----------------------------------------');
  const todos = await todoService.getTodos([1, 2, 3]);
  console.log('✅ Fetched', todos.length, 'todos');
  todos.forEach(todo => {
    console.log(`   - ${todo.id}: ${todo.title.substring(0, 40)}...`);
  });
  
  await app.close();
}

// Main execution
async function bootstrap() {
  try {
    await demonstrateAxiosCompatibility();
    
    console.log('\n✨ Key Features in v0.4.0:');
    console.log('------------------------------------------------');
    console.log('1. Axios-compatible responses are ALWAYS returned');
    console.log('2. Direct access to parsed data via response.data');
    console.log('3. Full TypeScript support with generics');
    console.log('4. Drop-in replacement for @nestjs/axios');
    console.log('5. Maintains Undici\'s performance benefits');
    console.log('\n🚀 Migration from @nestjs/axios:');
    console.log('   - Just change the import statement!');
    console.log('   - All your existing code will work');
    
  } catch (error) {
    console.error('Error:', error);
  }
}

bootstrap().catch(console.error);