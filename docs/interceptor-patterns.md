# Interceptor Patterns and Best Practices

This document describes common patterns and best practices for using interceptors with nestjs-undici-interceptors.

## Function-based vs Class-based Interceptors

### Function-based Interceptors

Function-based interceptors are simple and don't require dependency injection:

```typescript
const loggingInterceptor = (request, next) => {
  console.log(`Request to ${request.url}`);
  return next.handle(request);
};

@Module({
  imports: [
    HttpModule.register({
      interceptors: [loggingInterceptor],
    }),
  ],
})
export class AppModule {}
```

### Class-based Interceptors

Class-based interceptors can use dependency injection, but have limitations:

```typescript
@Injectable()
class LoggingInterceptor implements HttpInterceptor {
  constructor(private readonly logger: LoggerService) {}
  
  intercept(request: HttpInterceptorRequest, next: HttpInterceptorHandler) {
    this.logger.log(`Request to ${request.url}`);
    return next.handle(request);
  }
}
```

## Important: Class-based Interceptor Limitations

Due to NestJS module scoping, class-based interceptors with dependencies **cannot** be automatically instantiated within the HttpModule scope. Their dependencies must be available in the application module where HttpModule is imported.

### ❌ This will NOT work:

```typescript
@Module({
  imports: [
    HttpModule.register({
      interceptors: [LoggingInterceptor], // LoggingInterceptor has LoggerService dependency
    }),
  ],
})
export class AppModule {}
// Error: Nest can't resolve dependencies of LoggingInterceptor
```

### ✅ Correct approach:

```typescript
@Module({
  imports: [
    HttpModule.register({
      interceptors: [LoggingInterceptor],
    }),
  ],
  providers: [
    LoggerService, // Required dependency
    LoggingInterceptor, // Must be provided here
  ],
})
export class AppModule {}
```

## Recommended Patterns

### 1. Use Function-based Interceptors for Simple Logic

If your interceptor doesn't need dependency injection, use a function:

```typescript
const authInterceptor = (request, next) => {
  request.headers['Authorization'] = 'Bearer token';
  return next.handle(request);
};
```

### 2. Create a Shared Module for Complex Interceptors

For interceptors that need dependencies, create a shared module:

```typescript
@Module({
  providers: [LoggerService, MetricsService, LoggingInterceptor],
  exports: [LoggingInterceptor],
})
export class InterceptorsModule {}

@Module({
  imports: [
    InterceptorsModule,
    HttpModule.register({
      interceptors: [LoggingInterceptor],
    }),
  ],
})
export class AppModule {}
```

### 3. Use Factory Pattern for Dynamic Interceptors

For interceptors that need configuration:

```typescript
export function createAuthInterceptor(token: string): HttpInterceptorFunction {
  return (request, next) => {
    request.headers['Authorization'] = `Bearer ${token}`;
    return next.handle(request);
  };
}

@Module({
  imports: [
    HttpModule.register({
      interceptors: [createAuthInterceptor('my-token')],
    }),
  ],
})
export class AppModule {}
```

### 4. Use axiosRef for Axios-style Interceptors

For easier migration from @nestjs/axios:

```typescript
@Injectable()
export class ApiService {
  constructor(private readonly httpService: HttpService) {
    // Add request interceptor
    this.httpService.axiosRef.interceptors.request.use(
      (config) => {
        config.headers.set('X-Custom-Header', 'value');
        return config;
      },
      (error) => Promise.reject(error)
    );
    
    // Add response interceptor
    this.httpService.axiosRef.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error('Request failed:', error);
        return Promise.reject(error);
      }
    );
  }
}
```

## Testing Interceptors

### Testing Function-based Interceptors

```typescript
describe('AuthInterceptor', () => {
  it('should add authorization header', (done) => {
    const mockNext = {
      handle: jest.fn().mockReturnValue(of({ data: 'test' })),
    };
    
    const request = {
      url: 'https://api.example.com',
      options: { headers: {} },
    };
    
    authInterceptor(request, mockNext).subscribe(() => {
      expect(request.options.headers['Authorization']).toBe('Bearer token');
      expect(mockNext.handle).toHaveBeenCalledWith(request);
      done();
    });
  });
});
```

### Testing Class-based Interceptors

```typescript
describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let logger: LoggerService;
  
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [LoggingInterceptor, LoggerService],
    }).compile();
    
    interceptor = module.get<LoggingInterceptor>(LoggingInterceptor);
    logger = module.get<LoggerService>(LoggerService);
  });
  
  it('should log requests', (done) => {
    const spy = jest.spyOn(logger, 'log');
    const mockNext = {
      handle: jest.fn().mockReturnValue(of({ data: 'test' })),
    };
    
    interceptor.intercept({ url: '/test' }, mockNext).subscribe(() => {
      expect(spy).toHaveBeenCalledWith('Request to /test');
      done();
    });
  });
});
```