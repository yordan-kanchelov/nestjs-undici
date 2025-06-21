# NestJS Undici (Fork with Interceptor Support)

> **Note**: This is a fork of the original [nestjs-undici](https://github.com/hebertcisco/nestjs-undici) package with added HTTP interceptor support.

> **Breaking Change in v0.4.0**: This library now always returns axios-compatible responses. All axios options are automatically detected and handled by the standard `register()` method.

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
- ✅ **Axios-Compatible Responses**: All responses are now axios-compatible (v0.4.0+)
- 🆕 **Axios-style Interceptor API**: Use familiar `httpService.axiosRef.interceptors` syntax
- 🆕 **Automatic Axios Config Detection**: `register()` automatically maps axios options to undici
- 🆕 **Enhanced Migration Support**: Drop-in replacement with minimal code changes

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
- 🎯 **Drop-in Replacement**: Can replace @nestjs/axios with minimal code changes
- 🔄 **Axios-Compatible**: All responses use axios format by default
- 🎯 **Smart Config Detection**: Automatically maps axios options to undici

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
import { firstValueFrom } from 'rxjs';

@Injectable()
export class AppService {
  constructor(private readonly httpService: HttpService) {}

  async getUsers() {
    // Responses are always axios-compatible (v0.4.0+)
    const response = await firstValueFrom(
      this.httpService.get('https://api.example.com/users')
    );

    return response.data; // Direct access to data property
  }
}
```

## Migration from @nestjs/axios

Migrating from @nestjs/axios is simple - just change your import:

```typescript
// Before
import { HttpModule, HttpService } from '@nestjs/axios';

// After
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
```

Your existing code, including axios-style configuration and interceptors, will continue to work. The `register()` method automatically detects and maps axios options.

See the [Migration Guide](docs/migration-guide.md) for detailed instructions.


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

Interceptors allow you to modify requests and responses globally. You can use either axios-style or native interceptors:

```typescript
// Axios-style (familiar syntax)
this.httpService.axiosRef.interceptors.request.use(
  (config) => {
    config.headers['Authorization'] = 'Bearer token';
    return config;
  }
);

// Native style (better performance)
this.httpService.addInterceptor((request, next) => {
  request.options.headers['Authorization'] = 'Bearer token';
  return next.handle(request);
});
```

See the [Interceptor Patterns](docs/interceptor-patterns.md) documentation for advanced usage.

### Performance Benefits

After migrating from axios, you'll see:
- **60-70% faster** HTTP requests
- Lower memory usage
- Better connection pooling
- Native HTTP/2 support

```typescript
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';

// Drop-in replacement for @nestjs/axios!
@Module({
  imports: [
    HttpModule.register({
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

All responses have the familiar Axios structure:
- `response.data` - Parsed response body (JSON/text/Buffer)
- `response.status` - HTTP status code (200, 404, etc.)
- `response.statusText` - HTTP status text ("OK", "Not Found", etc.)
- `response.headers` - Response headers
- `response.config` - Request configuration

**Important**: Just like Axios, responses with status codes >= 400 are thrown as errors with the same error structure as Axios (including `error.response`, `error.config`, and `error.isAxiosError`).

#### Simple Migration from @nestjs/axios

Migration is incredibly simple - just change the import:

```typescript
// Before
import { HttpModule, HttpService } from '@nestjs/axios';

// After
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
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

### Need Raw Undici Responses?

The library always returns axios-compatible responses for consistency and ease of use. If you need to work with raw Undici responses, consider using the `undici` package directly for those specific use cases.

## API Reference

For detailed API documentation, please visit our [documentation site](https://hebertcisco.github.io/nestjs-undici/).

## Testing

Run the test suite:

```bash
# All tests (unit + e2e + examples)
npm test

# Individual test suites
npm run test:unit          # Unit tests only
npm run test:unit:watch    # Unit tests in watch mode
npm run test:unit:cov      # Unit tests with coverage
npm run test:e2e           # E2E tests only
npm run test:examples      # Example tests only

# Verbose example tests
npm run test:examples:verbose
```

The `npm test` command runs all three test suites sequentially, ensuring comprehensive coverage including unit tests, e2e tests, and example validation.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

If you find this package useful, please consider giving it a ⭐️ on [GitHub](https://github.com/hebertcisco/nestjs-undici).
