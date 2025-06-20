# Type-Aware HttpService Patterns

This guide explains how to properly use TypeScript types with `nestjs-undici-interceptors` to get the correct type inference based on your module configuration.

## The Problem

When using `HttpModule.registerAxiosCompatible()`, the service instance is actually `AxiosCompatibleHttpService`, but the dependency injection token is still `HttpService`. This causes TypeScript to infer the wrong return types.

```typescript
// ❌ Problem: TypeScript thinks response is Dispatcher.ResponseData
@Injectable()
class MyService {
  constructor(private httpService: HttpService) {}
  
  async getData() {
    const response = await lastValueFrom(
      this.httpService.get('https://api.example.com/data')
    );
    
    // TypeScript error: Property 'data' does not exist
    return response.data; // ❌ Type error!
  }
}
```

## Solutions

### Solution 1: Explicit Type Declaration (Recommended)

Declare the service with the correct type in your constructor:

```typescript
// ✅ Solution: Declare the correct type
@Injectable()
class MyService {
  constructor(private httpService: AxiosCompatibleHttpService) {}
  
  async getData() {
    const response = await lastValueFrom(
      this.httpService.get<MyData>('https://api.example.com/data')
    );
    
    return response.data; // ✅ TypeScript knows about .data
  }
}
```

### Solution 2: Type Casting

Cast the service to the correct type:

```typescript
@Injectable()
class MyService {
  constructor(private httpService: HttpService) {}
  
  async getData() {
    const axiosService = this.httpService as AxiosCompatibleHttpService;
    const response = await lastValueFrom(
      axiosService.get<MyData>('https://api.example.com/data')
    );
    
    return response.data; // ✅ Works!
  }
}
```

### Solution 3: Type Guards

Use runtime type checking for flexible code:

```typescript
@Injectable()
class MyService {
  constructor(private httpService: HttpService) {}
  
  async getData() {
    if (this.httpService instanceof AxiosCompatibleHttpService) {
      // TypeScript narrows the type here
      const response = await lastValueFrom(
        this.httpService.get<MyData>('https://api.example.com/data')
      );
      return response.data; // ✅ Type-safe
    } else {
      // Handle standard undici response
      const response = await lastValueFrom(
        this.httpService.get('https://api.example.com/data')
      );
      return await response.body.json();
    }
  }
}
```

### Solution 4: Custom Provider

Create a custom provider with the correct type:

```typescript
@Module({
  imports: [HttpModule.registerAxiosCompatible()],
  providers: [
    {
      provide: 'TYPED_HTTP_SERVICE',
      useFactory: (httpService: HttpService) => {
        return httpService as AxiosCompatibleHttpService;
      },
      inject: [HttpService],
    },
    MyService,
  ],
})
export class AppModule {}

@Injectable()
class MyService {
  constructor(@Inject('TYPED_HTTP_SERVICE') private httpService: AxiosCompatibleHttpService) {}
  
  // Full type safety!
}
```

## Best Practices

1. **Be Explicit**: Always declare the correct service type in your constructor when using axios compatibility mode.

2. **Create Type Aliases**: Define type aliases for common patterns:

```typescript
// In your types file
export type AxiosHttpService = AxiosCompatibleHttpService;

// In your service
constructor(private httpService: AxiosHttpService) {}
```

3. **Use Type Guards**: For libraries or shared code that needs to work with both modes:

```typescript
function isAxiosCompatible(service: HttpService): service is AxiosCompatibleHttpService {
  return service instanceof AxiosCompatibleHttpService;
}
```

4. **Document Your Module Configuration**: Make it clear which type of HttpService your module provides:

```typescript
/**
 * This module uses axios-compatible HTTP service.
 * Inject AxiosCompatibleHttpService in your providers.
 */
@Module({
  imports: [HttpModule.registerAxiosCompatible()],
})
export class ApiModule {}
```

## Common Patterns

### Pattern 1: Service with Both Response Types

```typescript
@Injectable()
export class FlexibleHttpService {
  constructor(private httpService: HttpService) {}

  async fetchData<T>(url: string): Promise<T> {
    if (this.httpService instanceof AxiosCompatibleHttpService) {
      const response = await lastValueFrom(
        (this.httpService as AxiosCompatibleHttpService).get<T>(url)
      );
      return response.data;
    } else {
      const response = await lastValueFrom(this.httpService.get(url));
      return await response.body.json();
    }
  }
}
```

### Pattern 2: Generic Service Class

```typescript
@Injectable()
export class ApiClient<TService extends HttpService = HttpService> {
  constructor(private httpService: TService) {}

  async get<T>(url: string): Promise<T> {
    const response = await lastValueFrom(this.httpService.get(url));
    
    if (this.httpService instanceof AxiosCompatibleHttpService) {
      return (response as AxiosLikeResponse<T>).data;
    } else {
      return await (response as Dispatcher.ResponseData).body.json();
    }
  }
}
```

### Pattern 3: Factory Functions

```typescript
export function createApiClient(httpService: HttpService) {
  if (httpService instanceof AxiosCompatibleHttpService) {
    return new AxiosApiClient(httpService);
  }
  return new UndiciApiClient(httpService);
}
```

## Migration Guide

When migrating from `@nestjs/axios`:

1. Change your import:
```typescript
// Before
import { HttpService } from '@nestjs/axios';

// After
import { AxiosCompatibleHttpService } from 'nestjs-undici-interceptors';
```

2. Update your module:
```typescript
// Before
HttpModule.register({ /* config */ })

// After
HttpModule.registerAxiosCompatible({ /* config */ })
```

3. Update your service injection:
```typescript
// Before
constructor(private httpService: HttpService) {}

// After
constructor(private httpService: AxiosCompatibleHttpService) {}
```

## Type Reference

### Response Types

```typescript
// Standard Undici Response
interface UndiciResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: BodyReadable;
  // ... other properties
}

// Axios-Compatible Response
interface AxiosLikeResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  config: AxiosLikeRequestConfig;
}
```

### Service Types

```typescript
// Base service (returns UndiciResponse)
class HttpService {
  get<T>(...): Observable<Dispatcher.ResponseData>;
}

// Axios-compatible service (returns AxiosLikeResponse)
class AxiosCompatibleHttpService extends HttpService {
  get<T>(...): Observable<AxiosLikeResponse<T>>;
}
```

## Troubleshooting

### Type Error: Property 'data' does not exist

**Cause**: Using `HttpService` type with axios-compatible module.

**Solution**: Change to `AxiosCompatibleHttpService` in your constructor.

### Runtime Error: Cannot read property 'data' of undefined

**Cause**: Trying to access `.data` on a standard undici response.

**Solution**: Use type guards or ensure you're using the axios-compatible module.

### Type Inference Not Working

**Cause**: TypeScript cannot infer the service type from the module configuration.

**Solution**: Explicitly declare the service type or use type casting.

## Future Improvements

We're working on enhanced type inference that will automatically provide the correct types based on your module configuration. Stay tuned for updates!