# HttpService

The `HttpService` is the main service for making HTTP requests in your NestJS application. As of v0.4.0+, it always returns axios-compatible responses, making it a drop-in replacement for `@nestjs/axios`.

## Basic Usage

To use the HttpService, inject it into your component or service:

```typescript
import { Injectable } from '@nestjs/common';
import { HttpService } from 'nestjs-undici-interceptors';
import { lastValueFrom } from 'rxjs';

@Injectable()
export class UserService {
  constructor(private readonly httpService: HttpService) {}

  async getUser(id: number) {
    const response = await lastValueFrom(
      this.httpService.get(`https://api.example.com/users/${id}`)
    );
    return response.data; // Axios-compatible response
  }
}
```

## Available Methods

The HttpService provides all standard HTTP methods:

### GET Request
```typescript
const response = await lastValueFrom(
  this.httpService.get('/users')
);
console.log(response.data); // The parsed response data
console.log(response.status); // HTTP status code
console.log(response.headers); // Response headers
```

### POST Request
```typescript
const newUser = { name: 'John Doe', email: 'john@example.com' };
const response = await lastValueFrom(
  this.httpService.post('/users', newUser)
);
console.log(response.data); // Created user data
```

### PUT Request
```typescript
const updatedUser = { name: 'Jane Doe' };
const response = await lastValueFrom(
  this.httpService.put('/users/1', updatedUser)
);
```

### PATCH Request
```typescript
const partialUpdate = { email: 'newemail@example.com' };
const response = await lastValueFrom(
  this.httpService.patch('/users/1', partialUpdate)
);
```

### DELETE Request
```typescript
const response = await lastValueFrom(
  this.httpService.delete('/users/1')
);
```

### HEAD Request
```typescript
const response = await lastValueFrom(
  this.httpService.head('/users/1')
);
```

## Request Options

All methods accept an optional configuration object:

```typescript
const response = await lastValueFrom(
  this.httpService.get('/users', {
    headers: {
      'Authorization': 'Bearer token',
      'X-Custom-Header': 'value'
    },
    timeout: 5000, // 5 seconds
    params: {
      page: 1,
      limit: 10
    }
  })
);
```

## Working with Observables

The HttpService returns RxJS Observables, allowing you to use RxJS operators:

```typescript
import { map, catchError, retry } from 'rxjs/operators';
import { of } from 'rxjs';

getUserName(id: number): Observable<string> {
  return this.httpService.get(`/users/${id}`).pipe(
    map(response => response.data.name),
    retry(3),
    catchError(error => {
      console.error('Error fetching user:', error);
      return of('Unknown User');
    })
  );
}
```

## Type Safety

The HttpService supports TypeScript generics for type-safe responses:

```typescript
interface User {
  id: number;
  name: string;
  email: string;
}

async getUser(id: number): Promise<User> {
  const response = await lastValueFrom(
    this.httpService.get<User>(`/users/${id}`)
  );
  return response.data; // Type is User
}
```

## Error Handling

Errors are thrown as standard JavaScript errors with axios-compatible structure:

```typescript
try {
  const response = await lastValueFrom(
    this.httpService.get('/users/999')
  );
} catch (error) {
  if (error.response) {
    // Server responded with error status
    console.log(error.response.status); // e.g., 404
    console.log(error.response.data); // Error response body
  } else if (error.request) {
    // Request was made but no response received
    console.log('No response received');
  } else {
    // Error in request configuration
    console.log('Request error:', error.message);
  }
}
```

## Interceptors

You can add interceptors dynamically to the HttpService:

```typescript
// Add an interceptor
const interceptorId = this.httpService.addInterceptor((request, next) => {
  console.log('Request:', request.url);
  return next.handle(request);
});

// Remove an interceptor
this.httpService.removeInterceptor(interceptorId);
```

## Migration from @nestjs/axios

Migration requires updating imports and adapting interceptor usage:

```typescript
// Before
import { HttpService } from '@nestjs/axios';

// After
import { HttpService } from 'nestjs-undici-interceptors';
```

**What stays the same:**
- Response structure (data, status, headers)
- HTTP method calls (get, post, put, etc.)
- Observable/Promise handling

**What changes:**
- Interceptor API (see examples above)
- Some configuration options
- No direct access to axios instance

For detailed migration patterns, see the [migration guide](https://github.com/yordan-kanchelov/nestjs-undici-fork/blob/main/examples/interceptor-demo/src/axios-to-undici-migration.ts).