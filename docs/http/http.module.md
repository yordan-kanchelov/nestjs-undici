# HttpModule

The `HttpModule` is the main module that provides HTTP client functionality for NestJS applications using the high-performance Undici client. As of v0.4.0+, it always returns axios-compatible responses by default.

## Basic Usage

```typescript
import { Module } from '@nestjs/common';
import { HttpModule } from 'nestjs-undici-interceptors';

@Module({
  imports: [HttpModule],
  // ... providers that use HttpService
})
export class AppModule {}
```

## Configuration

The module supports configuration options through the `register` method:

```typescript
@Module({
  imports: [
    HttpModule.register({
      timeout: 5000, // 5 seconds
      headers: {
        'User-Agent': 'MyApp/1.0',
      },
      // Add interceptors
      interceptors: [authInterceptor, loggingInterceptor],
    }),
  ],
})
export class AppModule {}
```

### Async Configuration

You can also use the `registerAsync` method to provide options asynchronously:

```typescript
@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        timeout: configService.get('HTTP_TIMEOUT'),
        headers: {
          'Authorization': await configService.get('API_KEY'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}
```

## Interceptors

The module supports both function-based and class-based interceptors:

### Function-based Interceptors

```typescript
const authInterceptor = (request, next) => {
  request.headers['Authorization'] = 'Bearer token';
  return next.handle(request);
};

HttpModule.register({
  interceptors: [authInterceptor],
});
```

### Class-based Interceptors

```typescript
@Injectable()
export class LoggingInterceptor implements HttpInterceptor {
  intercept(request: HttpInterceptorRequest, next: HttpInterceptorHandler): Observable<any> {
    console.log('Request:', request.url);
    return next.handle(request).pipe(
      tap(response => console.log('Response:', response.status))
    );
  }
}

HttpModule.register({
  interceptors: [LoggingInterceptor],
});
```

## Global Dispatcher

The module uses Undici's dispatcher system. By default, it creates a new Agent for each module instance. You can also use the global dispatcher:

```typescript
HttpModule.register({
  useGlobalDispatcher: true,
});
```

## Migration from @nestjs/axios

nestjs-undici-interceptors now provides enhanced axios compatibility, making migration much simpler:

### Automatic Axios Configuration Detection

The `HttpModule.register()` method now automatically detects and handles axios-style configuration:

```typescript
HttpModule.register({
  // These axios options are automatically detected and mapped!
  baseURL: 'https://api.example.com',
  timeout: 5000,
  maxRedirects: 5,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
  auth: { username: 'user', password: 'pass' },
  transformRequest: [(data) => JSON.stringify(data)],
  transformResponse: [(data) => JSON.parse(data)],
  validateStatus: (status) => status < 400,
})
```

### Response Handling (Compatible ✅)
```typescript
// Both libraries return the same response structure
const response = await httpService.get('/api/data').toPromise();
console.log(response.data);    // ✅ Works the same
console.log(response.status);  // ✅ Works the same
console.log(response.headers); // ✅ Works the same
```

### Interceptors (Both APIs Supported! ✅)
```typescript
// Option 1: Use axios-style interceptors (NEW!)
httpService.axiosRef.interceptors.request.use((config) => {
  config.headers['Authorization'] = 'Bearer token';
  return config;
});

// Option 2: Use undici-style interceptors (more control)
httpService.addInterceptor((request, next) => {
  const updatedRequest = {
    ...request,
    options: {
      ...request.options,
      headers: {
        ...request.options.headers,
        'Authorization': 'Bearer token',
      },
    },
  };
  return next.handle(updatedRequest);
});

// Both APIs can be used together!
```

### Configuration Options (Automatically Mapped! ✅)
```typescript
// This axios configuration now works directly!
HttpModule.register({
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
  maxRedirects: 5,  // Automatically mapped to maxRedirections
  baseURL: 'https://api.example.com',
  auth: { username: 'user', password: 'pass' },
  // ... other axios options
});
```

The library automatically:
- Detects axios-style configuration options
- Maps them to undici equivalents where possible
- Logs warnings for unsupported features
- Converts transformRequest/transformResponse to interceptors

See the [migration example](https://github.com/yordan-kanchelov/nestjs-undici-fork/blob/main/examples/interceptor-demo/src/axios-to-undici-migration.ts) and [enhanced compatibility demo](https://github.com/yordan-kanchelov/nestjs-undici-fork/blob/main/examples/interceptor-demo/src/enhanced-axios-compatibility.ts) for detailed patterns.

## Available Options

All options from [@nodejs/undici](https://github.com/nodejs/undici) are supported, including:

- `timeout`: Request timeout in milliseconds
- `headers`: Default headers for all requests
- `bodyTimeout`: Body timeout in milliseconds
- `headersTimeout`: Headers timeout in milliseconds
- `keepAliveTimeout`: Keep-alive timeout
- `maxRedirections`: Maximum number of redirects to follow
- `interceptors`: Array of interceptors (specific to this fork)

## Type-Safe Module

For better TypeScript support, you can also use `HttpTypedModule`:

```typescript
import { HttpTypedModule } from 'nestjs-undici-interceptors';

@Module({
  imports: [
    HttpTypedModule.register({
      // Same options as HttpModule
    }),
  ],
})
export class AppModule {}
```

This provides enhanced type inference for response data.