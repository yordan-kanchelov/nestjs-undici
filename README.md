# nestjs-axios-undici

The `@nestjs/axios` `HttpModule` and `HttpService`, running on [undici](https://github.com/nodejs/undici) instead of axios. Change one import. Your services, axios options, interceptors and error handling keep working.

[![npm version](https://img.shields.io/npm/v/nestjs-axios-undici.svg)](https://www.npmjs.com/package/nestjs-axios-undici)
[![Benchmarks](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/benchmarks.yml/badge.svg)](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/benchmarks.yml)
[![Release](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/release.yml/badge.svg)](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/release.yml)
[![Upstream conformance](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/upstream.yml/badge.svg)](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/upstream.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/yordan-kanchelov/nestjs-axios-undici/blob/main/LICENSE)

[Documentation](https://yordan-kanchelov.github.io/nestjs-axios-undici/) · [Benchmarks](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/benchmarks) · [Migration guide](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/migration-guide) · [Axios compatibility](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options)

## Why use it

`@nestjs/axios` sends every request through axios and Node.js's `http` module. This package sends them through undici, the HTTP client behind Node.js's own `fetch()`, which does less work per request. The API your services call stays the same.

<!-- bench-headline:start -->
In the same NestJS app, with only the import changed, **nestjs-axios-undici served 4.0-4.2x the requests per second of @nestjs/axios, with 77% lower p95 latency**, on Express and Fastify with Node.js 24. These numbers are preliminary, from a short local run. The full Docker and k6 benchmark replaces them on the next release.
<!-- bench-headline:end -->

The [benchmarks page](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/benchmarks) has the full results, and CI reruns the full benchmark for every release.

- **Same API as `@nestjs/axios`.** `HttpModule.register()` and `registerAsync()` take the same options. `HttpService` has the same `get`, `post`, `put`, `patch`, `delete` and `request(config)` methods. Responses have `data`, `status` and `headers`, and errors have `isAxiosError`, `error.response` and `error.code`.
- **Checked against the upstream test suites.** Every pull request runs the `HttpModule` and `HttpService` specs from `@nestjs/axios`, and the HTTP adapter tests from axios, against this package. The `@nestjs/axios` specs pass. Each axios test that doesn't pass has a written reason in the [expected-failure lists](https://github.com/yordan-kanchelov/nestjs-axios-undici/tree/main/tests/upstream). On top of that, a 66-case compatibility suite and a differential harness of 220+ scenarios run every case against real `@nestjs/axios`. [Axios compatibility](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options) lists the differences that remain.
- **Your interceptors keep working.** `httpService.axiosRef.interceptors.request.use(...)` behaves as it does with `@nestjs/axios`. You can also register native interceptors, as functions or injectable classes.
- **No axios at runtime.** Requests never go through axios. Install `axios` only if you want `error instanceof axios.AxiosError` to hold for this package's errors.
- **Tested on Node.js 22, 24 and 26.** Every pull request also runs a CPU-per-request benchmark against the base branch, and fails if the request path gets more than 10% slower.

## Installation

```bash
npm install nestjs-axios-undici undici
```

Requires Node.js 22.17+, NestJS 10, 11 or 12, `rxjs` 7 and `undici` 7 or 8.

### Supported versions

| Dependency | Versions | Notes |
| --- | --- | --- |
| Node.js | 22.17+, 24, 26 | `undici` 8 itself requires Node.js 22.19+ |
| NestJS (`@nestjs/common`, `@nestjs/core`) | 10, 11, 12 | |
| `undici` | 7, 8 | |
| `rxjs` | 7.1+ | |
| `reflect-metadata` | 0.1.13+, 0.2 | NestJS itself needs it. This package doesn't use it or declare it as a peer. |

CI installs every combination from the packed package and runs it as a CommonJS app and as an ESM app, including the lowest version in each range. It repeats this weekly to catch new releases.

The `cookieJar` option needs two optional peers, `http-cookie-agent` 8 and `tough-cookie` 5 or 6. Install them yourself if you use it (see [Cookies](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options?id=cookies-cookiejar)). `axios` 1.x is also an optional peer. With it installed, `error instanceof axios.AxiosError` holds for this package's errors, and nothing else changes.

## Migrating from @nestjs/axios

```typescript
// Before
import { HttpModule, HttpService } from '@nestjs/axios';

// After
import { HttpModule, HttpService } from 'nestjs-axios-undici';
```

Existing calls, axios options and `axiosRef` interceptors keep working. The [migration guide](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/migration-guide) covers the remaining differences.

## Quick start

```typescript
import { Module } from '@nestjs/common';
import { HttpModule } from 'nestjs-axios-undici';

@Module({
  imports: [
    HttpModule.register({
      baseURL: 'https://api.example.com',
      timeout: 5000,
      headers: { 'User-Agent': 'my-service' },
    }),
  ],
  providers: [UsersService],
})
export class AppModule {}
```

```typescript
import { Injectable } from '@nestjs/common';
import { HttpService } from 'nestjs-axios-undici';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class UsersService {
  constructor(private readonly httpService: HttpService) {}

  async findAll() {
    const { data } = await firstValueFrom(
      this.httpService.get<User[]>('/users', { params: { active: true } }),
    );
    return data; // parsed JSON, like axios
  }

  create(user: CreateUserDto) {
    return this.httpService.post<User>('/users', user); // Observable<AxiosResponse-like>
  }
}
```

A non-2xx response rejects with an axios-style error (`error.response.status`, `error.code`), as it does with `@nestjs/axios`.

## Configuration

`register()` takes axios options such as `baseURL`, `timeout`, `headers`, `auth`, `params`, `maxRedirects`, `validateStatus`, `httpAgent` and `proxy`, and undici options such as a custom `dispatcher`. `withCredentials` does nothing, as with axios on Node.js. Use `cookieJar` if you want cookies handled. `registerAsync()` takes the same options from a factory:

```typescript
HttpModule.registerAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    baseURL: config.get('API_URL'),
    timeout: config.get('HTTP_TIMEOUT'),
  }),
  inject: [ConfigService],
});
```

See [Configuration](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/configuration) and [Axios compatibility](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options).

## Interceptors

```typescript
// Axios style, unchanged from @nestjs/axios
this.httpService.axiosRef.interceptors.request.use((config) => {
  config.headers['Authorization'] = `Bearer ${token}`;
  return config;
});

// Native: a function or an injectable class, registered on the module
@Injectable()
export class LoggingInterceptor implements HttpInterceptor {
  intercept(request: HttpInterceptorRequest, next: HttpInterceptorHandler) {
    const start = Date.now();
    return next.handle(request).pipe(
      tap((response) => console.log(`${request.url} ${response.status} ${Date.now() - start}ms`)),
    );
  }
}

HttpModule.register({ interceptors: [LoggingInterceptor] });
```

More in the [Interceptors guide](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/interceptors), including [interceptors with dependencies](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/interceptors?id=interceptors-with-dependencies).

## Documentation

- [Migration from @nestjs/axios](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/migration-guide)
- Guides: [Configuration](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/configuration) · [Making requests](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/making-requests) · [Interceptors](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/interceptors) · [Error handling](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/error-handling) · [Testing](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/testing)
- Reference: [Axios compatibility](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options) · [HttpModule](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/http/http.module) · [HttpService](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/http/http.service)
- [Benchmarks](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/benchmarks) and how to run them: [`benchmarks/`](https://github.com/yordan-kanchelov/nestjs-axios-undici/tree/main/benchmarks)

## Contributing

Run `npm test` (unit, e2e and examples) before opening a pull request, and add a changeset (`npx changeset`) describing any change to the published package. Releases are built from the changesets. See [CHANGELOG.md](https://github.com/yordan-kanchelov/nestjs-axios-undici/blob/main/CHANGELOG.md).

The dev dependencies are NestJS 12, whose packages are ESM-only. Jest can load them only on Node.js 24.9 or later, so develop on Node 24+ and run Jest through the npm scripts (`npm test`, `npm run test:jest`, `npm run test:cov`). They pass the `--experimental-vm-modules` flag Jest needs, and a bare `npx jest` doesn't. On Node 22, install an older Nest major over the lockfile first, as CI does: `npm i --no-save @nestjs/common@11 @nestjs/core@11 @nestjs/testing@11 @nestjs/platform-express@11 @nestjs/axios@4` (and `npm ci` to go back).

## Credits

This project started as a fork of [nestjs-undici](https://github.com/hebertcisco/nestjs-undici) by [Hebert Cisco](https://github.com/hebertcisco).

## License

[MIT](https://github.com/yordan-kanchelov/nestjs-axios-undici/blob/main/LICENSE)
