# Migration Guide: From @nestjs/axios to nestjs-undici-interceptors

This comprehensive guide helps you migrate from `@nestjs/axios` to `nestjs-undici-interceptors` with minimal code changes while gaining significant performance improvements.

## Quick Start

The simplest migration path - just change your import:

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
    HttpModule.register({  // Same method, automatic detection!
      timeout: 5000,
      maxRedirects: 5,    // Automatically mapped to maxRedirections
    })
  ]
})
```

The `HttpModule.register()` method automatically detects axios-style configuration options and maps them to their undici equivalents. No need for special registration methods!

## Key Features for Migration

### 1. Axios-style Interceptor API

You can continue using the familiar `axiosRef.interceptors` API:

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

### 2. AxiosHeaders Class

`nestjs-undici-interceptors` includes the `AxiosHeaders` class that matches axios's header handling:

```typescript
import { AxiosHeaders } from 'nestjs-undici-interceptors';

// Create headers just like in axios
const headers = new AxiosHeaders();
headers.set('Content-Type', 'application/json');
headers.set('Authorization', 'Bearer token');

// All axios methods are supported
headers.get('content-type');  // Case-insensitive
headers.has('Authorization'); 
headers.delete('Authorization');
headers.forEach((value, key) => console.log(key, value));
```

### 3. Automatic Configuration Mapping

The following axios options are automatically detected and mapped:

| Axios Option | Undici Equivalent | Notes |
|-------------|-------------------|-------|
| `timeout` | `headersTimeout` & `bodyTimeout` | ✅ Automatically mapped |
| `maxRedirects` | `maxRedirections` | ✅ Automatically mapped |
| `validateStatus` | `validateStatus` | ✅ Supported |
| `auth` | Authorization header | ✅ Converted to Basic auth |
| `httpAgent` | Undici Agent | ✅ Automatically configured |
| `httpsAgent` | Undici Agent | ✅ Automatically configured |
| `proxy` | ProxyAgent | ✅ Automatically configured |
| `maxBodyLength` | Size limit interceptor | ✅ Enforced via interceptor |
| `maxContentLength` | Size limit interceptor | ✅ Enforced via interceptor |
| `withCredentials` | CookieAgent | ✅ Cookie jar support |

See [Axios Supported Options](./axios-supported-options.md) for detailed documentation.

### 4. Axios-Compatible Responses

All responses are automatically transformed to match axios structure:

```typescript
const response = await this.httpService.get('/api/data').toPromise();

// These all work just like axios:
response.data       // Parsed response body
response.status     // HTTP status code
response.statusText // Status text (e.g., "OK")
response.headers    // Response headers
response.config     // Request configuration
```

### 5. Axios-Compatible Errors

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

## Common Migration Patterns

### Simple Service Migration

No code changes needed for basic services:

```typescript
@Injectable()
export class ApiService {
  constructor(private httpService: HttpService) {}

  async getUsers() {
    const { data } = await this.httpService.get('/users').toPromise();
    return data;  // Works exactly the same!
  }
}
```

### OpenTelemetry Integration

Here's a complete example of migrating OpenTelemetry trace injection:

```typescript
import { HttpModule, HttpService, AxiosHeaders } from "nestjs-undici-interceptors";
import { DynamicModule, Global, Module, OnModuleInit } from "@nestjs/common";
import { context, propagation } from "@opentelemetry/api";

@Global()
@Module({})
export class HttpConfigModule implements OnModuleInit {
  public static forRoot(config?: HttpConfig): DynamicModule {
    const httpModule = HttpModule.register({
      timeout: config?.timeout ?? 5000,
      maxRedirects: config?.maxRedirects ?? 5,
    });

    return {
      module: HttpConfigModule,
      imports: [httpModule],
      exports: [httpModule],
    };
  }

  constructor(private readonly httpService: HttpService) {}

  public onModuleInit() {
    // Add Axios-compatible interceptor to inject OpenTelemetry trace context
    this.httpService.axiosRef.interceptors.request.use((config) => {
      // Inject OpenTelemetry trace context into headers
      const traceHeaders: Record<string, string> = {};
      propagation.inject(context.active(), traceHeaders);

      // Ensure headers is an AxiosHeaders instance
      if (!config.headers) {
        config.headers = new AxiosHeaders();
      } else if (!(config.headers instanceof AxiosHeaders)) {
        config.headers = AxiosHeaders.from(config.headers);
      }

      // Now you can use set() just like in axios!
      Object.entries(traceHeaders).forEach(([key, value]) => {
        config.headers.set(key, value);
      });

      return config;
    });
  }
}
```

### Native Undici Interceptors (Optional)

For better performance, you can optionally migrate to native undici interceptors:

```typescript
// Native undici interceptor API
this.httpService.addInterceptor((request, next) => {
  request.options.headers['X-Request-ID'] = uuid();
  
  return next.handle(request).pipe(
    tap({
      error: (error) => this.logger.error(error)
    })
  );
});
```

## Handling Special Cases

### HTTP/HTTPS Agents

If you need custom agent configuration beyond what's automatically mapped:

```typescript
import { Agent } from 'undici';

HttpModule.register({
  dispatcher: new Agent({
    connections: 100,
    pipelining: 10,
  })
})
```

### Proxy Support

For advanced proxy configurations:

```typescript
import { ProxyAgent } from 'undici';

HttpModule.register({
  dispatcher: new ProxyAgent('http://proxy.example.com:8080')
})
```

### Request/Response Transforms

Use interceptors for transforms:

```typescript
this.httpService.axiosRef.interceptors.request.use((config) => {
  // Transform request data
  if (config.data) {
    config.data = transformRequest(config.data);
  }
  return config;
});

this.httpService.axiosRef.interceptors.response.use((response) => {
  // Transform response data
  response.data = transformResponse(response.data);
  return response;
});
```

## Gradual Migration Strategy

You can run both modules side-by-side during migration:

```typescript
import { HttpModule as AxiosModule } from '@nestjs/axios';
import { HttpModule as UndiciModule } from 'nestjs-undici-interceptors';

@Module({
  imports: [
    AxiosModule.register({ /* axios config */ }),
    UndiciModule.register({ /* undici config */ }),
  ],
  providers: [
    { provide: 'AxiosHttp', useExisting: AxiosModule },
    { provide: 'UndiciHttp', useExisting: UndiciModule },
  ]
})
```

Then gradually migrate services one at a time.

## Performance Benefits

After migrating, you'll see:
- **60-70% faster** HTTP requests
- Lower memory usage
- Better connection pooling
- Native HTTP/2 support

## Summary

Migration from `@nestjs/axios` is straightforward:

1. **Change imports** from `@nestjs/axios` to `nestjs-undici-interceptors`
2. **That's it!** Your existing configuration and code will work
3. The `HttpModule.register()` method automatically detects and maps axios options
4. Existing interceptor code works with `httpService.axiosRef.interceptors`
5. Response structure and error handling remain the same
6. Get 60-70% performance improvement with minimal changes

The library automatically handles:
- Configuration mapping (timeout, maxRedirects, agents, proxy, etc.)
- Response transformation to axios-compatible format
- Error structure compatibility
- All convenience methods (get, post, put, delete, etc.)
- AxiosHeaders class for full header compatibility

For the best performance, consider migrating to the native Undici API over time, but the axios-compatible API will continue to be supported.

## Need Help?

- See [Axios Supported Options](./axios-supported-options.md) for all configuration options
- Check [Interceptor Patterns](./interceptor-patterns.md) for advanced patterns
- Review the [examples](../examples/) directory for working code samples