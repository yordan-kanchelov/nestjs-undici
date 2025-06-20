# Type Inference Solution Summary

## Problem Statement

When using `HttpModule.registerAxiosCompatible()`, the actual service instance is `AxiosCompatibleHttpService`, but the dependency injection token remains `HttpService`. This causes TypeScript to infer incorrect return types, making it difficult to access axios-style properties like `response.data`.

## Root Cause

NestJS's dependency injection system uses tokens (typically the class itself) to identify providers. When we register the axios-compatible module, we're actually providing an `AxiosCompatibleHttpService` instance, but it's registered under the `HttpService` token. TypeScript only sees the declared type in the constructor, not the runtime type.

## Solutions Implemented

### 1. **Type Assertion Pattern (Simplest)**

```typescript
@Injectable()
class MyService {
  constructor(private httpService: HttpService) {}
  
  async getData() {
    const axiosService = this.httpService as AxiosCompatibleHttpService;
    const response = await lastValueFrom(axiosService.get<Data>('/api'));
    return response.data; // ✅ Type-safe!
  }
}
```

### 2. **Explicit Type Declaration (Recommended)**

```typescript
@Injectable()
class MyService {
  constructor(private httpService: AxiosCompatibleHttpService) {}
  
  async getData() {
    const response = await lastValueFrom(this.httpService.get<Data>('/api'));
    return response.data; // ✅ Full type inference!
  }
}
```

### 3. **Type Guards for Flexibility**

```typescript
@Injectable()
class MyService {
  constructor(private httpService: HttpService) {}
  
  async getData() {
    if (this.httpService instanceof AxiosCompatibleHttpService) {
      const response = await lastValueFrom(this.httpService.get<Data>('/api'));
      return response.data; // ✅ Type narrowing works!
    }
    // Handle standard HttpService
  }
}
```

### 4. **Custom Provider Pattern**

```typescript
@Module({
  imports: [HttpModule.registerAxiosCompatible()],
  providers: [
    {
      provide: 'TYPED_HTTP_SERVICE',
      useFactory: (httpService: HttpService) => httpService as AxiosCompatibleHttpService,
      inject: [HttpService],
    },
  ],
})
export class AppModule {}
```

## Type Helpers Added

### 1. **Type Guard Function**
```typescript
export function isAxiosCompatibleService(service: HttpService): service is AxiosCompatibleHttpService;
```

### 2. **Conditional Response Types**
```typescript
export type HttpResponseType<TService, T = any> = 
  TService extends AxiosCompatibleHttpService 
    ? AxiosLikeResponse<T>
    : Dispatcher.ResponseData;
```

### 3. **Module Type Extraction**
```typescript
export type ExtractServiceType<TModule> = 
  TModule extends { _serviceType?: infer TService } 
    ? TService 
    : HttpService;
```

## Best Practices

1. **Use Type Aliases**: Create clear type aliases like `type AxiosHttpService = AxiosCompatibleHttpService`

2. **Be Explicit**: Always declare the correct service type in constructors when using axios compatibility

3. **Document Module Configuration**: Make it clear which type of HttpService your module provides

4. **Use Type Guards**: For shared libraries that need to support both modes

5. **Handle Errors Properly**: Axios-compatible mode includes typed error responses

## Migration Guide

From `@nestjs/axios`:
```typescript
// Before
import { HttpService } from '@nestjs/axios';

// After
import { AxiosCompatibleHttpService as HttpService } from 'nestjs-undici-interceptors';
```

## Future Improvements

While the current solutions work well, future versions could potentially:

1. Use branded types or unique symbols to differentiate service types at compile time
2. Implement module-level generics that flow through to providers
3. Create custom decorators that handle type inference automatically

## Conclusion

The recommended approach is to use explicit type declaration (`AxiosCompatibleHttpService`) in your constructors when using `registerAxiosCompatible()`. This provides the best developer experience with full TypeScript support and clear intent.

For libraries or shared code that needs to support both modes, use type guards or the factory pattern to handle both cases gracefully.