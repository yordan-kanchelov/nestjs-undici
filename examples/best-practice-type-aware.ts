import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService, AxiosCompatibleHttpService } from '../src';
import { lastValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Best Practice #1: Create a type alias for clarity
 */
type AxiosHttpService = AxiosCompatibleHttpService;

/**
 * Best Practice #2: Create a dedicated service interface
 */
interface TodoApiClient {
  getTodo(id: number): Promise<Todo>;
  createTodo(todo: Partial<Todo>): Promise<Todo>;
  updateTodo(id: number, updates: Partial<Todo>): Promise<Todo>;
  deleteTodo(id: number): Promise<void>;
}

interface Todo {
  userId: number;
  id: number;
  title: string;
  completed: boolean;
}

/**
 * Best Practice #3: Use explicit type declaration
 * This is the RECOMMENDED approach for axios compatibility
 */
@Injectable()
export class TodoService implements TodoApiClient {
  constructor(
    // Explicitly declare as AxiosCompatibleHttpService for proper type inference
    private readonly httpService: AxiosHttpService
  ) {}

  async getTodo(id: number): Promise<Todo> {
    // Full type safety - TypeScript knows response.data exists
    const response = await lastValueFrom(
      this.httpService.get<Todo>(`https://jsonplaceholder.typicode.com/todos/${id}`)
    );
    return response.data;
  }

  async createTodo(todo: Partial<Todo>): Promise<Todo> {
    const response = await lastValueFrom(
      this.httpService.post<Todo>('https://jsonplaceholder.typicode.com/todos', todo)
    );
    return response.data;
  }

  async updateTodo(id: number, updates: Partial<Todo>): Promise<Todo> {
    const response = await lastValueFrom(
      this.httpService.patch<Todo>(`https://jsonplaceholder.typicode.com/todos/${id}`, updates)
    );
    return response.data;
  }

  async deleteTodo(id: number): Promise<void> {
    await lastValueFrom(
      this.httpService.delete(`https://jsonplaceholder.typicode.com/todos/${id}`)
    );
  }

  // Example using RxJS operators
  async getTodoTitle(id: number): Promise<string> {
    return await lastValueFrom(
      this.httpService.get<Todo>(`https://jsonplaceholder.typicode.com/todos/${id}`).pipe(
        map(response => response.data.title)
      )
    );
  }

  // Example with error handling
  async getTodoSafe(id: number): Promise<Todo | null> {
    try {
      const response = await lastValueFrom(
        this.httpService.get<Todo>(`https://jsonplaceholder.typicode.com/todos/${id}`)
      );
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }
}

/**
 * Best Practice #4: Document module configuration
 */
@Module({
  imports: [
    HttpModule.registerAxiosCompatible({
      timeout: 5000,
      interceptors: [
        // Your custom interceptors here
      ],
    }),
  ],
  providers: [TodoService],
  exports: [TodoService],
})
export class TodoModule {}

/**
 * Best Practice #5: Create a factory for flexible instantiation
 */
export function createTodoService(httpService: HttpService): TodoApiClient {
  if (!(httpService instanceof AxiosCompatibleHttpService)) {
    throw new Error('TodoService requires AxiosCompatibleHttpService');
  }
  return new TodoService(httpService);
}

/**
 * Best Practice #6: Type guard for runtime checking
 */
export function assertAxiosCompatible(
  service: HttpService
): asserts service is AxiosCompatibleHttpService {
  if (!(service instanceof AxiosCompatibleHttpService)) {
    throw new Error('Expected AxiosCompatibleHttpService but got HttpService');
  }
}

/**
 * Alternative approach for libraries that need to support both modes
 */
@Injectable()
export class FlexibleTodoService {
  constructor(private readonly httpService: HttpService) {}

  async getTodo(id: number): Promise<Todo> {
    // Type guard for runtime safety
    if (this.httpService instanceof AxiosCompatibleHttpService) {
      const response = await lastValueFrom(
        this.httpService.get<Todo>(`https://jsonplaceholder.typicode.com/todos/${id}`)
      );
      return response.data;
    } else {
      // Fallback for standard HttpService
      const response = await lastValueFrom(
        this.httpService.get(`https://jsonplaceholder.typicode.com/todos/${id}`)
      );
      return await response.body.json();
    }
  }
}

/**
 * Example usage
 */
async function main() {
  const app = await NestFactory.create(TodoModule);
  const todoService = app.get(TodoService);

  // Fetch a todo
  const todo = await todoService.getTodo(1);
  console.log('Todo:', todo);

  // Create a new todo
  const newTodo = await todoService.createTodo({
    title: 'Learn NestJS',
    completed: false,
    userId: 1,
  });
  console.log('Created:', newTodo);

  // Update a todo
  const updated = await todoService.updateTodo(1, { completed: true });
  console.log('Updated:', updated);

  // Get just the title
  const title = await todoService.getTodoTitle(1);
  console.log('Title:', title);

  // Safe fetch with error handling
  const safeTodo = await todoService.getTodoSafe(999);
  console.log('Safe fetch:', safeTodo); // null if not found

  await app.close();
}

// Run the example
if (require.main === module) {
  main().catch(console.error);
}

/**
 * Summary of Best Practices:
 * 
 * 1. Use type aliases for clarity (AxiosHttpService)
 * 2. Explicitly declare service type in constructor
 * 3. Create interfaces for your API clients
 * 4. Document which HttpService type your module provides
 * 5. Use type guards for runtime safety when needed
 * 6. Handle errors properly with typed error responses
 * 7. Leverage RxJS operators for data transformation
 * 8. Create factory functions for flexible instantiation
 * 
 * The key insight: Always declare AxiosCompatibleHttpService explicitly
 * in your constructor when using registerAxiosCompatible().
 */