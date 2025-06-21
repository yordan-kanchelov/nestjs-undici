# Axios Options Support in nestjs-undici-interceptors

This document details the axios options that are now fully supported in nestjs-undici-interceptors.

## Newly Supported Options (v0.4.2+)

### 1. `httpAgent` / `httpsAgent` - Connection Pooling

Automatically maps Node.js Agent options to Undici's connection pooling:

```typescript
import { Agent } from 'http';

HttpModule.register({
  httpAgent: new Agent({
    keepAlive: true,
    maxSockets: 10,
    maxFreeSockets: 5,
    timeout: 60000,
  }),
});
```

**How it works:**
- `keepAlive` → Undici's `pipelining` option
- `maxSockets` → Undici's `connections` limit
- `timeout` → Undici's `headersTimeout` and `bodyTimeout`

### 2. `proxy` - Proxy Support

Automatically creates and configures an Undici ProxyAgent:

```typescript
HttpModule.register({
  proxy: {
    host: 'proxy.example.com',
    port: 8080,
    auth: {
      username: 'user',
      password: 'pass',
    },
  },
});
```

**How it works:**
- Creates a `ProxyAgent` instance with the provided configuration
- Supports authentication via Basic Auth
- Handles both HTTP and HTTPS proxies

### 3. `maxBodyLength` / `maxContentLength` - Size Limits

Enforces request body and response content size limits:

```typescript
HttpModule.register({
  maxBodyLength: 10 * 1024 * 1024,    // 10MB request body limit
  maxContentLength: 50 * 1024 * 1024, // 50MB response content limit
});
```

**How it works:**
- Implements size checking via interceptors
- Throws axios-compatible errors when limits are exceeded
- Error messages match axios format: `"maxContentLength size of X exceeded"`

### 4. `withCredentials` - Cookie Support

Automatically handles cookies across requests:

```typescript
HttpModule.register({
  withCredentials: true,
});
```

**How it works:**
- Uses `http-cookie-agent` with `tough-cookie` for cookie management
- Creates a cookie jar that persists cookies across requests
- Automatically sends cookies based on domain/path matching

## Previously Supported Options

These options were already supported:

- `timeout` - Request timeout in milliseconds
- `maxRedirects` - Maximum number of redirects to follow
- `validateStatus` - Function to determine if status is valid
- `auth` - Basic authentication credentials
- `baseURL` - Base URL for relative requests
- `headers` - Default headers for all requests

## Options Requiring Manual Handling

### `socketPath` - Unix Socket Support

While not automatically configured, you can use Unix sockets by modifying the URL:

```typescript
// Instead of socketPath, use unix:// protocol
httpService.get('unix:/var/run/docker.sock:/v1.24/containers/json');
```

### `xsrfCookieName` / `xsrfHeaderName` - XSRF Protection

XSRF protection needs to be implemented manually using interceptors:

```typescript
const xsrfInterceptor = (request, next) => {
  // Read XSRF token from cookie
  const token = /* read from cookie */;
  request.headers['X-XSRF-TOKEN'] = token;
  return next.handle(request);
};

HttpModule.register({
  interceptors: [xsrfInterceptor],
});
```

## Migration Example

Here's a complete example migrating from @nestjs/axios:

```typescript
// Before - @nestjs/axios
import { HttpModule } from '@nestjs/axios';

HttpModule.register({
  timeout: 5000,
  maxRedirects: 5,
  maxBodyLength: 10 * 1024 * 1024,
  maxContentLength: 50 * 1024 * 1024,
  withCredentials: true,
  httpAgent: new Agent({
    keepAlive: true,
    maxSockets: 10,
  }),
  proxy: {
    host: 'proxy.example.com',
    port: 8080,
  },
});

// After - nestjs-undici-interceptors
import { HttpModule } from 'nestjs-undici-interceptors';

HttpModule.register({
  // All the same options work!
  timeout: 5000,
  maxRedirects: 5,
  maxBodyLength: 10 * 1024 * 1024,
  maxContentLength: 50 * 1024 * 1024,
  withCredentials: true,
  httpAgent: new Agent({
    keepAlive: true,
    maxSockets: 10,
  }),
  proxy: {
    host: 'proxy.example.com',
    port: 8080,
  },
});
```

## Known Limitations

- Combining `httpAgent`/`httpsAgent` with `withCredentials` in the same configuration may cause issues due to how the CookieAgent wraps dispatchers. Use them separately or use Undici's native APIs for complex scenarios.

## Performance Note

While these compatibility features make migration easier, you can achieve better performance by using Undici's native APIs directly:

```typescript
// Native Undici approach (better performance)
import { ProxyAgent, Agent } from 'undici';

const proxyAgent = new ProxyAgent('http://proxy.example.com:8080');
const agent = new Agent({
  connections: 10,
  pipelining: 1,
});

HttpModule.register({
  dispatcher: proxyAgent, // or agent
});
```