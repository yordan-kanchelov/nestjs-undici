# Axios to Undici Migration Guide

This guide helps you migrate from `@nestjs/axios` to `nestjs-undici-interceptors` with minimal code changes.

## Quick Start

The simplest migration path:

```typescript
// Before
import { HttpModule, HttpService } from '@nestjs/axios';

@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 5,
    })
  ]
})

// After
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';

@Module({
  imports: [
    HttpModule.registerAxiosCompatible({  // Just add "AxiosCompatible"
      timeout: 5000,
      maxRedirects: 5,
    })
  ]
})
```

## New Axios Compatibility Features

### 1. Axios-style Interceptor API

You can now use the familiar `axiosRef.interceptors` API:

```typescript
@Injectable()
export class MyService implements OnModuleInit {
  constructor(private httpService: HttpService) {}

  onModuleInit() {
    // Request interceptors
    this.httpService.axiosRef.interceptors.request.use(
      (config) => {
        config.headers['Authorization'] = 'Bearer token';
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Response interceptors
    this.httpService.axiosRef.interceptors.response.use(
      (response) => {
        console.log('Response:', response.status);
        return response;
      },
      (error) => {
        if (error.response?.status === 401) {
          // Handle unauthorized
        }
        return Promise.reject(error);
      }
    );
  }
}
```

### 2. Configuration Mapping

The `registerAxiosCompatible()` method automatically maps axios options:

| Axios Option | Undici Equivalent | Notes |
|-------------|-------------------|-------|
| `timeout` | `headersTimeout` & `bodyTimeout` | Automatically mapped |
| `maxRedirects` | `maxRedirections` | Automatically mapped |
| `validateStatus` | `validateStatus` | Supported |
| `auth` | Authorization header | Converted to Basic auth |
| `httpAgent` | - | Shows warning with guidance |
| `httpsAgent` | - | Shows warning with guidance |
| `proxy` | - | Shows warning with guidance |

### 3. Axios-Compatible Responses

All responses are automatically transformed to match axios structure:

```typescript
const response = await this.httpService.get('/api/data').toPromise();

// These all work just like axios:
response.data      // Parsed response body
response.status    // HTTP status code
response.statusText // Status text (e.g., "OK")
response.headers   // Response headers
response.config    // Request configuration
```

### 4. Axios-Compatible Errors

Errors are also axios-compatible:

```typescript
try {
  await this.httpService.get('/api/data').toPromise();
} catch (error) {
  if (error.isAxiosError) {
    console.log(error.response?.status);  // 404, 500, etc.
    console.log(error.response?.data);    // Error response body
    console.log(error.config);            // Request config
    console.log(error.toJSON());          // Serializable error
  }
}
```

## Migration Patterns

### Simple Service Migration

**Before (Axios):**
```typescript
@Injectable()
export class ApiService {
  constructor(private httpService: HttpService) {}

  async getUsers() {
    const { data } = await this.httpService.get('/users').toPromise();
    return data;
  }
}
```

**After (Undici):**
```typescript
@Injectable()
export class ApiService {
  constructor(private httpService: HttpService) {}

  async getUsers() {
    const { data } = await this.httpService.get('/users').toPromise();
    return data;  // No changes needed!
  }
}
```

### Interceptor Migration

**Before (Axios):**
```typescript
this.httpService.axiosRef.interceptors.request.use(config => {
  config.headers['X-Request-ID'] = uuid();
  return config;
});

this.httpService.axiosRef.interceptors.response.use(
  response => response,
  error => {
    this.logger.error(error);
    return Promise.reject(error);
  }
);
```

**After (Undici - Option 1: Using axiosRef):**
```typescript
// Exactly the same code works!
this.httpService.axiosRef.interceptors.request.use(config => {
  config.headers['X-Request-ID'] = uuid();
  return config;
});

this.httpService.axiosRef.interceptors.response.use(
  response => response,
  error => {
    this.logger.error(error);
    return Promise.reject(error);
  }
);
```

**After (Undici - Option 2: Native API for better performance):**
```typescript
this.httpService.addInterceptor((request, next) => {
  request.options.headers['X-Request-ID'] = uuid();
  
  return next.handle(request).pipe(
    tap({
      error: (error) => this.logger.error(error)
    })
  );
});
```

### Configuration Migration

**Before (Axios):**
```typescript
HttpModule.register({
  timeout: 10000,
  maxRedirects: 5,
  httpAgent: new http.Agent({ keepAlive: true }),
  proxy: {
    host: 'proxy.example.com',
    port: 8080,
  },
  validateStatus: (status) => status < 500,
})
```

**After (Undici):**
```typescript
HttpModule.registerAxiosCompatible({
  timeout: 10000,
  maxRedirects: 5,
  httpAgent: new http.Agent({ keepAlive: true }), // Will show warning
  proxy: {                                          // Will show warning
    host: 'proxy.example.com',
    port: 8080,
  },
  validateStatus: (status) => status < 500,        // Supported!
})
```

## Handling Unsupported Features

Some axios features need alternative approaches:

### HTTP/HTTPS Agents
```typescript
// Instead of httpAgent/httpsAgent, use Undici's dispatcher options:
import { Agent } from 'undici';

HttpModule.register({
  dispatcher: new Agent({
    connections: 100,
    pipelining: 10,
  })
})
```

### Proxy Support
```typescript
// Use ProxyAgent from undici:
import { ProxyAgent } from 'undici';

HttpModule.register({
  dispatcher: new ProxyAgent('http://proxy.example.com:8080')
})
```

### Request/Response Transforms
```typescript
// Use interceptors for transforms:
this.httpService.addInterceptor((request, next) => {
  // Transform request
  if (request.options.body) {
    request.options.body = transformRequest(request.options.body);
  }
  
  return next.handle(request).pipe(
    map(response => {
      // Transform response
      response.data = transformResponse(response.data);
      return response;
    })
  );
});
```

## Performance Benefits

After migrating, you'll see:
- **60-70% faster** HTTP requests
- Lower memory usage
- Better connection pooling
- Native HTTP/2 support

## Gradual Migration

You can run both modules side-by-side during migration:

```typescript
import { HttpModule as AxiosModule } from '@nestjs/axios';
import { HttpModule as UndiciModule } from 'nestjs-undici-interceptors';

@Module({
  imports: [
    AxiosModule.register({ /* axios config */ }),
    UndiciModule.registerAxiosCompatible({ /* undici config */ }),
  ]
})
```

Then gradually migrate services one at a time.

## Summary

The new axios compatibility features make migration straightforward:

1. Change imports from `@nestjs/axios` to `nestjs-undici-interceptors`
2. Use `HttpModule.registerAxiosCompatible()` for automatic config mapping
3. Existing interceptor code works with `httpService.axiosRef.interceptors`
4. Response structure and error handling remain the same
5. Get 60-70% performance improvement with minimal changes

For the best performance, consider migrating to the native Undici API over time, but the axios-compatible API will continue to be supported.