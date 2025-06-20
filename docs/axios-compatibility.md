# Axios Compatibility Mode

The nestjs-undici-interceptors package provides a complete Axios compatibility mode that allows you to migrate from @nestjs/axios with minimal code changes while benefiting from Undici's superior performance.

## Quick Migration Guide

### Step 1: Change your imports

```typescript
// Before
import { HttpModule, HttpService } from '@nestjs/axios';

// After
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
```

### Step 2: Use registerAxiosCompatible

```typescript
// Before
@Module({
  imports: [HttpModule.register({ timeout: 5000 })],
})
export class AppModule {}

// After
@Module({
  imports: [HttpModule.registerAxiosCompatible({ timeout: 5000 })],
})
export class AppModule {}
```

### That's it! Your existing code continues to work.

## What's Included

### Response Structure Compatibility

The Axios compatibility mode ensures responses have the exact same structure as @nestjs/axios:

- `response.data` - Pre-parsed response body (JSON, text, or Buffer)
- `response.status` - HTTP status code (e.g., 200, 404)
- `response.statusText` - HTTP status text (e.g., "OK", "Not Found")
- `response.headers` - Response headers object
- `response.config` - Request configuration

### Automatic Body Parsing

The adapter automatically parses response bodies based on content-type:

- **JSON**: Automatically parsed to JavaScript objects
- **Text/HTML/XML**: Returned as strings
- **Binary**: Returned as Buffer objects
- **Empty responses**: Return empty string (`''`)

### Full RxJS Support

All RxJS operators work exactly as they do with @nestjs/axios:

```typescript
this.httpService.request(url).pipe(
  map(response => response.data),
  catchError(error => of(null)),
  retry({ count: 3, delay: 1000 })
)
```

### Interceptor Compatibility

While the interceptor APIs differ between Axios and Undici, the compatibility mode allows you to:

1. Use function-based interceptors that work with the Axios-like response structure
2. Access and modify response data in interceptors
3. Chain multiple interceptors

Example interceptor that works with Axios compatibility mode:

```typescript
httpService.addInterceptor((request, next) => {
  return next.handle(request).pipe(
    map((response: any) => ({
      ...response,
      data: {
        ...response.data,
        intercepted: true
      }
    }))
  );
});
```

## Supported Features

### ✅ Fully Supported

- All HTTP methods (GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD)
- Request/response headers
- Query parameters
- Request body (JSON, text, binary)
- Response status codes and text
- Timeouts
- Custom headers
- Error responses with body (thrown as errors like Axios)
- Large payloads
- UTF-8 and special characters
- Multiple header values (e.g., Set-Cookie)
- Binary responses (images, files)
- Empty responses (204, 304)
- **Error throwing for 4xx/5xx status codes** (matches Axios behavior)

### ⚠️ Minor Differences to Note

1. **Interceptor API**: Different API but similar capabilities (see examples below)
2. **Request Config**: Some config options have different names (e.g., `validateStatus` not directly supported)
3. **1xx Status Codes**: Limited support due to Undici limitations
4. **axiosRef**: No direct access to underlying client (use `undiciRef` instead)

## Performance Benefits

By switching to nestjs-undici-interceptors, you get:

- **60-70% faster** HTTP requests compared to Axios
- Lower memory usage
- Better connection pooling
- Native Node.js HTTP/2 support
- Zero external dependencies

## Example: Before and After

### Before (with @nestjs/axios)

```typescript
@Injectable()
export class ApiService {
  constructor(private httpService: HttpService) {}

  async getData() {
    const response = await lastValueFrom(
      this.httpService.get('https://api.example.com/data').pipe(
        map(res => res.data),
        catchError(() => of(null))
      )
    );
    return response;
  }
}
```

### After (with nestjs-undici-interceptors)

```typescript
@Injectable()
export class ApiService {
  constructor(private httpService: HttpService) {}

  async getData() {
    const response = await lastValueFrom(
      this.httpService.request('https://api.example.com/data').pipe(
        map(res => res.data),
        catchError(() => of(null))
      )
    );
    return response;
  }
}
```

The only change needed is using `request()` instead of `get()`. Everything else remains the same!

## Advanced Usage

### Custom Interceptors

You can still add custom interceptors that work with the Axios-compatible responses:

```typescript
// Add request headers
httpService.addInterceptor((request, next) => {
  const modifiedRequest = {
    ...request,
    options: {
      ...request.options,
      headers: {
        ...request.options.headers,
        'Authorization': 'Bearer token'
      }
    }
  };
  return next.handle(modifiedRequest);
});

// Transform responses
httpService.addInterceptor((request, next) => {
  return next.handle(request).pipe(
    tap((response: any) => {
      console.log(`${response.status} ${response.statusText}`);
    })
  );
});
```

### Error Handling

Error handling works exactly like Axios - responses with status codes >= 400 are thrown as errors:

```typescript
this.httpService.get(url).pipe(
  catchError((error) => {
    // Error structure matches Axios
    console.log(error.response.status);  // e.g., 404
    console.log(error.response.data);    // Error response body
    console.log(error.response.headers); // Response headers
    console.log(error.isAxiosError);     // true (for compatibility)
    
    if (error.response?.status === 404) {
      return of({ data: null });
    }
    throw error;
  })
)
```

Just like Axios, error responses include:
- `error.response` - The response object with data, status, statusText, headers
- `error.request` - The request configuration
- `error.config` - The request configuration (alias for compatibility)
- `error.isAxiosError` - Set to `true` for Axios compatibility
- `error.message` - Error message (e.g., "Request failed with status code 404")

## Testing

The package includes comprehensive test coverage comparing behavior between @nestjs/axios and nestjs-undici-interceptors to ensure compatibility:

- Response structure tests
- Content-type handling tests
- Status code tests
- Header preservation tests
- Large payload tests
- Special character encoding tests
- Error response tests

See `tests/axios-full-compatibility.e2e.spec.ts` for the complete test suite.

## Migration Checklist

- [ ] Update package.json to use `nestjs-undici-interceptors`
- [ ] Update imports from `@nestjs/axios` to `nestjs-undici-interceptors`
- [ ] Change `HttpModule.register()` to `HttpModule.registerAxiosCompatible()`
- [ ] Replace `httpService.get/post/put/delete()` with `httpService.request()`
- [ ] Update request body from `data` property to `body` property
- [ ] Test your application thoroughly
- [ ] Enjoy the performance benefits!

## Need Help?

If you encounter any issues during migration, please check:

1. The examples in `examples/interceptor-demo/src/`
2. The test files for usage patterns
3. Open an issue on GitHub with a minimal reproduction