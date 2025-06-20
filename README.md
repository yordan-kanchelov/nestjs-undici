# NestJS Undici (Fork with Interceptor Support)

> **Note**: This is a fork of the original [nestjs-undici](https://github.com/hebertcisco/nestjs-undici) package with added HTTP interceptor support.

[![npm version](https://badge.fury.io/js/nestjs-undici-interceptors.svg)](https://badge.fury.io/js/nestjs-undici-interceptors)
[![Original Package](https://img.shields.io/badge/original-nestjs--undici-blue)](https://github.com/hebertcisco/nestjs-undici)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**NestJS Undici** is a powerful HTTP client module for NestJS applications, built on top of [@nodejs/undici](https://github.com/nodejs/undici). It provides a simple and efficient way to make HTTP requests in your NestJS applications.

## Fork Features

This fork adds the following features to the original package:
- ✅ **HTTP Interceptors**: Similar to @nestjs/axios, you can now intercept and modify requests/responses
- ✅ **Function-based interceptors**: Simple functions for request/response processing
- ✅ **Class-based interceptors**: Injectable classes implementing the HttpInterceptor interface
- ✅ **Dynamic interceptor registration**: Add interceptors at runtime

## Features

- 🚀 Built on top of [@nodejs/undici](https://github.com/nodejs/undici)
- 🔄 Full TypeScript support
- ⚡ High-performance HTTP client
- 🔒 Secure by default
- 🛠️ Easy to configure and use
- 📦 Lightweight and dependency-free
- 🔍 Built-in request/response interceptors
- 🔄 Automatic retry mechanism
- 📝 Comprehensive documentation
- 🎯 **Axios Compatibility Mode**: Drop-in replacement for @nestjs/axios

## Installation

```bash
# Using npm
npm install nestjs-undici-interceptors

# Using yarn
yarn add nestjs-undici-interceptors
```

To use the original package without interceptor support:
```bash
npm install nestjs-undici
```

## Quick Start

1. Import the `HttpModule` in your root module:

```typescript
import { Module } from '@nestjs/common';
import { HttpModule } from 'nestjs-undici-interceptors';

@Module({
  imports: [
    HttpModule.register({
      // Optional configuration
      headers: {
        'Content-Type': 'application/json',
      },
    }),
  ],
})
export class AppModule {}
```

2. Inject and use the `HttpService` in your service:

```typescript
import { Injectable } from '@nestjs/common';
import { HttpService } from 'nestjs-undici-interceptors';

@Injectable()
export class AppService {
  constructor(private readonly httpService: HttpService) {}

  async getUsers() {
    const response = await this.httpService
      .request('https://api.example.com/users')
      .toPromise();
    
    return response.data;
  }
}
```

## Configuration

The `HttpModule` can be configured using the `register` or `registerAsync` methods:

### Synchronous Configuration

```typescript
HttpModule.register({
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 5000,
  retry: {
    attempts: 3,
    delay: 1000,
  },
});
```

### Asynchronous Configuration

```typescript
HttpModule.registerAsync({
  useFactory: async (configService: ConfigService) => ({
    headers: {
      'Authorization': await configService.get('API_KEY'),
    },
  }),
  inject: [ConfigService],
});
```

## Advanced Usage

### Making HTTP Requests

```typescript
// GET request
const response = await this.httpService
  .request('https://api.example.com/users')
  .toPromise();

// POST request
const response = await this.httpService
  .request('https://api.example.com/users', {
    method: 'POST',
    body: JSON.stringify({ name: 'John Doe' }),
  })
  .toPromise();
```

### Using Interceptors

NestJS Undici now supports HTTP interceptors for modifying requests and responses. Interceptors allow you to:
- Add authentication headers to all requests
- Log request/response details
- Transform response data
- Handle errors globally
- Implement retry logic

#### Function-based Interceptors

```typescript
// Simple function interceptor
const authInterceptor = (request, next) => {
  // Modify the request
  const modifiedRequest = {
    ...request,
    options: {
      ...request.options,
      headers: {
        ...request.options.headers,
        'Authorization': 'Bearer my-token',
      },
    },
  };
  
  // Pass to next interceptor or execute request
  return next.handle(modifiedRequest);
};

// Register in module
HttpModule.register({
  interceptors: [authInterceptor],
});
```

#### Class-based Interceptors

```typescript
import { Injectable } from '@nestjs/common';
import { HttpInterceptor, HttpInterceptorHandler, HttpInterceptorRequest } from 'nestjs-undici-interceptors';
import { Observable } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements HttpInterceptor {
  intercept(
    request: HttpInterceptorRequest,
    next: HttpInterceptorHandler
  ): Observable<any> {
    console.log('Request:', request.url);
    return next.handle(request);
  }
}

// Register in module
HttpModule.register({
  interceptors: [LoggingInterceptor],
});
```

#### Dynamic Interceptors

You can also add interceptors at runtime:

```typescript
@Injectable()
export class MyService {
  constructor(private httpService: HttpService) {
    // Add interceptor dynamically
    this.httpService.addInterceptor((request, next) => {
      console.log('Dynamic interceptor');
      return next.handle(request);
    });
  }
}
```

### Axios Compatibility Mode

For easier migration from `@nestjs/axios`, this fork provides an Axios compatibility mode that transforms Undici responses to match the Axios response structure:

```typescript
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';

// Enable Axios compatibility mode - it's that simple!
@Module({
  imports: [
    HttpModule.registerAxiosCompatible({
      timeout: 5000,
      // ... other options
    })
  ],
})
export class AppModule {}

// Your existing Axios code works without changes!
@Injectable()
export class MyService {
  constructor(private httpService: HttpService) {}
  
  async getData() {
    const response = await lastValueFrom(
      this.httpService.get('https://api.example.com/data')
    );
    
    // Works exactly like Axios!
    return response.data;  // Already parsed JSON
  }
}
```

With Axios compatibility mode, responses have the familiar Axios structure:
- `response.data` - Parsed response body (JSON/text/Buffer)
- `response.status` - HTTP status code (200, 404, etc.)
- `response.statusText` - HTTP status text ("OK", "Not Found", etc.)
- `response.headers` - Response headers
- `response.config` - Request configuration

**Important**: Just like Axios, responses with status codes >= 400 are thrown as errors with the same error structure as Axios (including `error.response`, `error.config`, and `error.isAxiosError`).

#### Migration from @nestjs/axios

Migration is incredibly simple - just two steps:

1. **Replace the package import:**
   ```typescript
   // Before
   import { HttpModule, HttpService } from '@nestjs/axios';
   
   // After
   import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
   ```

2. **Use `registerAxiosCompatible` instead of `register`:**
   ```typescript
   // Before
   HttpModule.register({ timeout: 5000 })
   
   // After
   HttpModule.registerAxiosCompatible({ timeout: 5000 })
   ```

That's it! Your existing code continues to work without any other changes. You get:
- ✅ Same response structure as Axios
- ✅ All convenience methods (get, post, put, delete, patch, etc.)
- ✅ Better performance with Undici
- ✅ Full compatibility with existing code
- ✅ Support for all RxJS operators
- ✅ TypeScript types work as expected

##### Supported Convenience Methods
All the familiar Axios methods are available:
- `httpService.get(url, config?)`
- `httpService.post(url, data?, config?)`
- `httpService.put(url, data?, config?)`
- `httpService.delete(url, config?)`
- `httpService.patch(url, data?, config?)`
- `httpService.head(url, config?)`
- `httpService.options(url, config?)`
- `httpService.postForm(url, data?, config?)`
- `httpService.putForm(url, data?, config?)`
- `httpService.patchForm(url, data?, config?)`

## API Reference

For detailed API documentation, please visit our [documentation site](https://hebertcisco.github.io/nestjs-undici/).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

If you find this package useful, please consider giving it a ⭐️ on [GitHub](https://github.com/hebertcisco/nestjs-undici).
