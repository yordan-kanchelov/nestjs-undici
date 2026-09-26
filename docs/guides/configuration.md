# Configuration guide

`HttpModule.register()`/`.registerAsync()` accept axios-style options directly, the same ones you'd pass to the `HttpModule` from `@nestjs/axios`, and map them to undici automatically. They also accept undici's own [request options](https://github.com/nodejs/undici#undicirequesturl-options-promise), such as a custom `dispatcher`, for anything the axios mapping doesn't cover. See [Axios compatibility](/docs/axios-supported-options.md#module-level-axios-options) for the full option list.

## Basic configuration

```typescript
import { Module } from '@nestjs/common';
import { HttpModule } from 'nestjs-axios-undici';

@Module({
  imports: [
    HttpModule.register({
      baseURL: 'https://api.example.com',
      // Default headers for all requests
      headers: {
        'User-Agent': 'MyApp/1.0',
      },
    }),
  ],
})
export class AppModule {}
```

### Timeout

`timeout` is a deadline for the whole request, as in axios. It runs from the start of the request until the body is fully read, and the request rejects with `ECONNABORTED` when it passes. See [`timeout`](/docs/axios-supported-options.md?id=request-config) for the details.

```typescript
HttpModule.register({
  timeout: 5000, // 5 seconds in milliseconds
});
```

### Interceptors

Configure HTTP interceptors for request/response modification:

```typescript
// Function-based interceptor
const authInterceptor: HttpInterceptorFunction = (request, next) => {
  request.options.headers = {
    ...request.options.headers,
    Authorization: 'Bearer ' + getToken(),
  };
  return next.handle(request);
};

// Class-based interceptor
@Injectable()
export class LoggingInterceptor implements HttpInterceptor {
  intercept(request: HttpInterceptorRequest, next: HttpInterceptorHandler) {
    console.log('Request:', request.url);
    return next.handle(request);
  }
}

HttpModule.register({
  interceptors: [authInterceptor, LoggingInterceptor],
});
```

Class interceptors are instantiated inside `HttpModule`, so an interceptor that injects your own providers needs one of the patterns in [Interceptors with dependencies](/docs/guides/interceptors.md#interceptors-with-dependencies).

## Async configuration

Use `registerAsync` to load configuration asynchronously, for example from a `ConfigService`.

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule } from 'nestjs-axios-undici';

@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
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

## Advanced configuration (dispatchers)

To configure advanced behavior like connection pooling, proxies, or mocks, use a custom `Dispatcher`. The `dispatcher` property can be passed in the configuration object, and always wins over any of the axios-style options below (`httpAgent`/`httpsAgent`, `socketPath`, `proxy`, `httpVersion`). See [Axios compatibility](/docs/axios-supported-options.md#precedence-an-explicit-dispatcher-always-wins).

You don't need a `Dispatcher` at all for the common axios-style cases: TLS options via `httpsAgent`, `socketPath`, an explicit `proxy` or the `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` environment variables, and `httpVersion: 2`. See [Module-level axios options](/docs/axios-supported-options.md#module-level-axios-options).

With none of these set, `HttpService` still doesn't use undici's *global* dispatcher: it builds its own default `Agent` once, at startup. **Breaking change:** earlier versions fell back to `undici.getGlobalDispatcher()`, so `undici.setGlobalDispatcher()` elsewhere in the process could affect this library's own requests. It no longer can. `app.close()` gracefully closes every dispatcher this library created, whether that's the default `Agent` or whatever `dispatcher`/`httpAgent`/`httpsAgent`/`proxy`/`socketPath` produced. This is bounded by a short internal grace period. Past that period, anything still open is force-aborted instead of hanging shutdown indefinitely. See [Dispatchers and connection lifecycle](/docs/http/http.service.md#dispatchers-and-connection-lifecycle). An explicit `dispatcher` you pass in yourself is never closed by this library.

```typescript
import { Module } from '@nestjs/common';
import { HttpModule } from 'nestjs-axios-undici';
import { Agent } from 'undici';

@Module({
  imports: [
    HttpModule.register({
      // Configure an Agent with specific connection options
      dispatcher: new Agent({
        connect: {
          timeout: 5000,
        },
        keepAliveTimeout: 10000,
        connections: 10,
      }),
    }),
  ],
})
export class AppModule {}
```

For a proxy, a mock, or anything else undici already has a `Dispatcher` for, pass it the same way. It always wins over the axios-style options above:

```typescript
import { ProxyAgent } from 'undici';

HttpModule.register({ dispatcher: new ProxyAgent('http://proxy.example.com:8080') });
```

A `dispatcher` can also be set at runtime (`httpService.setDispatcher(...)`) or per request (`request(url, { dispatcher })`). See [`setDispatcher`](/docs/http/http.service.md#setdispatcherdispatcher).

### Cookies (`cookieJar`)

`withCredentials` (an axios option this module also accepts) is a no-op on Node.js, matching axios itself. Cookie storage/replay is opt-in instead, through an explicit `cookieJar` option, a [`tough-cookie`](https://www.npmjs.com/package/tough-cookie) `CookieJar` instance:

```typescript
import { CookieJar } from 'tough-cookie';

HttpModule.register({ cookieJar: new CookieJar() });
```

Only a jar instance is accepted, never `true`, so you decide its scope explicitly. Typically that's one jar per `register()` call. `http-cookie-agent` and `tough-cookie` are optional peer dependencies, loaded lazily only when `cookieJar` is set. Install both (`npm i http-cookie-agent tough-cookie`) to use this option. See [Cookies: `cookieJar`](/docs/axios-supported-options.md#cookies-cookiejar) for the full details, including why there's no per-request `cookieJar`.
