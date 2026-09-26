# HttpModule

`HttpModule` provides `HttpService`. Its API matches the `HttpModule` from `@nestjs/axios`. Import it as is, or configure it with `register()` or `registerAsync()`.

```typescript
import { Module } from '@nestjs/common';
import { HttpModule } from 'nestjs-axios-undici';

@Module({
  imports: [HttpModule],
})
export class AppModule {}
```

Each import of `HttpModule`, `HttpModule.register()` or `registerAsync()` creates its own `HttpService`, with its own configuration, interceptors and dispatcher. Bare `HttpModule` (no `register()` call) gets empty options. Previously, every app that imported the bare module this way shared the *same* empty options object, so calling `setDispatcher()` (or the old `setGlobalDispatcher()`) in one app leaked into every other app's `HttpService` too. That's fixed now: each app gets its own.

## `register(options)`

```typescript
HttpModule.register({
  baseURL: 'https://api.example.com',
  timeout: 5000,
  headers: { 'User-Agent': 'MyApp/1.0' },
  interceptors: [authInterceptor, LoggingInterceptor],
});
```

## `registerAsync(options)`

Resolves the options at startup, for example from a `ConfigService`:

```typescript
HttpModule.registerAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: async (config: ConfigService) => ({
    baseURL: config.get('API_URL'),
    timeout: config.get('HTTP_TIMEOUT'),
  }),
});
```

| Option | Description |
|--------|-------------|
| `useFactory` | Function returning the options (or a Promise of them). |
| `inject` | Providers passed to `useFactory`. |
| `imports` | Modules whose exported providers `useFactory`, `useClass` or `useExisting` need. |
| `useClass` | A class implementing `HttpModuleOptionsFactory` (`createHttpOptions()`), instantiated by the module. |
| `useExisting` | Like `useClass`, but reuses an existing provider. |
| `extraProviders` | Additional providers registered in the module. |
| `global` | Registers the module as global. |

```typescript
@Injectable()
class HttpConfigService implements HttpModuleOptionsFactory {
  createHttpOptions() {
    return { timeout: 5000 };
  }
}

HttpModule.registerAsync({ useClass: HttpConfigService });
```

## Options

`register()` and the object returned by `registerAsync()` accept:

- **Axios options**: `baseURL`, `headers`, `timeout`, `params`, `paramsSerializer`, `auth`, `validateStatus`, `responseType`, `maxRedirects`, `httpAgent`/`httpsAgent`, `proxy`, `withCredentials` (a no-op, like axios on Node.js), `maxBodyLength`/`maxContentLength`, `transformRequest`/`transformResponse`. They are detected and mapped to undici; see [Module-level axios options](/docs/axios-supported-options.md#module-level-axios-options) for what each one does and how it differs from axios.
- **`cookieJar`**: not an axios option. Opts into cookie storage/replay through a caller-supplied `tough-cookie` `CookieJar` instance; see [Cookies: `cookieJar`](/docs/axios-supported-options.md#cookies-cookiejar).
- **Undici request options**, used as defaults for every request, for example `dispatcher`, `headersTimeout` and `bodyTimeout`. See the [undici `request()` options](https://github.com/nodejs/undici#undicirequesturl-options-promise).
- **`interceptors`**: an array of interceptors (see below).
- **`global`**: registers the module as global, as in `@nestjs/axios`.

## Dispatchers and shutdown

Whatever dispatcher `register()`/`registerAsync()` options produce (an explicit `dispatcher`, or one built from `proxy`/`cookieJar`/`socketPath`/`httpAgent`/`httpsAgent`/`httpVersion: 2`), or the per-service default `Agent` when none of that applies, `app.close()` gracefully closes everything this library created for that `HttpService`. This is bounded by a short internal grace period, so an abandoned `responseType: 'stream'` response can't hang shutdown forever. See [Dispatchers and connection lifecycle](/docs/http/http.service.md#dispatchers-and-connection-lifecycle). An explicit `dispatcher` you pass in is never closed by this library.

## `interceptors`

An array of native interceptors, run in order for every request made through this module's `HttpService`:

```typescript
const authInterceptor: HttpInterceptorFunction = (request, next) => {
  request.options.headers = { ...request.options.headers, Authorization: `Bearer ${getToken()}` };
  return next.handle(request);
};

HttpModule.register({
  interceptors: [authInterceptor, LoggingInterceptor], // LoggingInterceptor implements HttpInterceptor
});
```

- In `register()`, classes are instantiated by Nest inside `HttpModule`. Their constructor dependencies must be available there (for example from a `@Global()` module); providers of your own module are not visible to it.
- In `registerAsync()`, classes are instantiated the same way, with dependencies also resolved from its `imports` and `extraProviders`.
- Interceptor instances (objects with an `intercept()` method) are used as they are.

See [Interceptors](/docs/guides/interceptors.md) for writing interceptors and for interceptors that inject other providers.
