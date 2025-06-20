import { Module, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HttpModule, HttpService, AxiosCompatibleHttpService } from '../src';
import { lastValueFrom } from 'rxjs';
import type { AxiosLikeResponse } from '../src/modules/http/interfaces';
import type { Dispatcher } from 'undici';

/**
 * Example 1: Explicit Type Casting (Current Workaround)
 */
@Injectable()
class ExplicitTypeService {
  constructor(private readonly httpService: HttpService) {}

  async getWithExplicitType() {
    // Current workaround - manually cast the service
    const axiosCompatibleService = this.httpService as AxiosCompatibleHttpService;
    
    // Now TypeScript knows this returns AxiosLikeResponse
    const response = await lastValueFrom(
      axiosCompatibleService.get<{ id: number }>('https://api.example.com/data')
    );
    
    // Type-safe access to axios-style properties
    console.log(response.data.id); // ✅ TypeScript knows about .data
    console.log(response.status);   // ✅ TypeScript knows about .status
  }
}

/**
 * Example 2: Using Proper Type Declaration in Constructor
 */
@Injectable()
class ProperTypeService {
  // Declare the service with the correct type
  constructor(private readonly httpService: AxiosCompatibleHttpService) {}

  async getWithProperType() {
    // TypeScript automatically infers the correct return type
    const response = await lastValueFrom(
      this.httpService.get<{ id: number }>('https://api.example.com/data')
    );
    
    // Full type safety without casting
    console.log(response.data.id); // ✅ Fully typed
    console.log(response.status);   // ✅ Fully typed
  }
}

/**
 * Example 3: Type Guards for Runtime Checking
 */
@Injectable()
class TypeGuardService {
  constructor(private readonly httpService: HttpService) {}

  async getWithTypeGuard() {
    if (this.httpService instanceof AxiosCompatibleHttpService) {
      // Inside this block, TypeScript knows it's AxiosCompatibleHttpService
      const response = await lastValueFrom(
        this.httpService.get<{ id: number }>('https://api.example.com/data')
      );
      
      console.log(response.data.id); // ✅ Type-safe
    } else {
      // Standard undici response
      const response = await lastValueFrom(
        this.httpService.get('https://api.example.com/data')
      );
      
      const data = await response.body.json();
      console.log(data.id);
    }
  }
}

/**
 * Example 4: Generic Service with Conditional Types
 */
@Injectable()
class GenericHttpConsumer<TService extends HttpService = HttpService> {
  constructor(private readonly httpService: TService) {}

  async fetchData<T>(): Promise<T> {
    if (this.httpService instanceof AxiosCompatibleHttpService) {
      const response = await lastValueFrom(
        (this.httpService as AxiosCompatibleHttpService).get<T>('https://api.example.com/data')
      );
      return response.data;
    } else {
      const response = await lastValueFrom(
        this.httpService.get('https://api.example.com/data')
      );
      return await response.body.json();
    }
  }
}

/**
 * Example 5: Factory Pattern for Type-Safe Services
 */
function createTypedHttpConsumer(httpService: HttpService) {
  if (httpService instanceof AxiosCompatibleHttpService) {
    return {
      async get<T>(url: string): Promise<T> {
        const response = await lastValueFrom(httpService.get<T>(url));
        return response.data;
      }
    };
  } else {
    return {
      async get<T>(url: string): Promise<T> {
        const response = await lastValueFrom(httpService.get(url));
        return await response.body.json();
      }
    };
  }
}

/**
 * Module Examples
 */

// Standard module - returns HttpService
@Module({
  imports: [HttpModule.register({})],
  providers: [ExplicitTypeService, TypeGuardService],
})
class StandardModule {}

// Axios-compatible module - returns AxiosCompatibleHttpService
@Module({
  imports: [HttpModule.registerAxiosCompatible({})],
  providers: [ProperTypeService],
})
class AxiosCompatModule {}

/**
 * Best Practice: Module with explicit provider override
 */
@Module({
  imports: [HttpModule.registerAxiosCompatible({})],
  providers: [
    {
      provide: 'TYPED_HTTP_SERVICE',
      useFactory: (httpService: HttpService) => {
        // This ensures TypeScript knows the exact type
        return httpService as AxiosCompatibleHttpService;
      },
      inject: [HttpService],
    },
    ProperTypeService,
  ],
})
class BestPracticeModule {}

/**
 * Testing the implementations
 */
async function runExamples() {
  console.log('🚀 Type-Aware HttpService Usage Examples\n');

  // Example with standard module
  const standardModule = await Test.createTestingModule({
    imports: [StandardModule],
  }).compile();

  const explicitService = standardModule.get(ExplicitTypeService);
  const typeGuardService = standardModule.get(TypeGuardService);

  // Example with axios-compatible module
  const axiosModule = await Test.createTestingModule({
    imports: [AxiosCompatModule],
  }).compile();

  const properTypeService = axiosModule.get(ProperTypeService);

  console.log('✅ All examples demonstrate type-safe usage patterns');
}

// Type utility for extracting response type
type ExtractResponseType<T> = T extends Observable<infer R> ? R : never;

// Helper type to determine service response type
type ServiceResponseType<TService extends HttpService, T = any> = 
  TService extends AxiosCompatibleHttpService 
    ? AxiosLikeResponse<T>
    : Dispatcher.ResponseData;

// Usage example of type utilities
type StandardResponse = ServiceResponseType<HttpService, { id: number }>;
type AxiosResponse = ServiceResponseType<AxiosCompatibleHttpService, { id: number }>;

export {
  ExplicitTypeService,
  ProperTypeService,
  TypeGuardService,
  GenericHttpConsumer,
  createTypedHttpConsumer,
  StandardModule,
  AxiosCompatModule,
  BestPracticeModule,
  runExamples,
};