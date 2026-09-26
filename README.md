# NestJS Axios Undici

**The `@nestjs/axios` API, powered by [Undici](https://github.com/nodejs/undici): change one import, keep your code, get about half the latency.**

[![npm version](https://img.shields.io/npm/v/nestjs-axios-undici.svg)](https://www.npmjs.com/package/nestjs-axios-undici)
[![Benchmarks](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/benchmarks.yml/badge.svg)](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/benchmarks.yml)
[![Release](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/release.yml/badge.svg)](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/release.yml)
[![Upstream conformance](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/upstream.yml/badge.svg)](https://github.com/yordan-kanchelov/nestjs-axios-undici/actions/workflows/upstream.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/yordan-kanchelov/nestjs-axios-undici/blob/main/LICENSE)

📖 **[Documentation](https://yordan-kanchelov.github.io/nestjs-axios-undici/)** · 📊 **[Benchmarks](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/benchmarks)** · 🔁 **[Migration guide](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/migration-guide)** · ↔️ **[Axios compatibility](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options)**

## Why nestjs-axios-undici?

`@nestjs/axios` is the default way to make HTTP calls in NestJS, built on axios, which is not built for throughput. undici is Node.js's own HTTP client - the engine behind `fetch()` - and does less work per request. This package gives you undici's speed behind the same `HttpModule`/`HttpService` API, without rewriting your services.

- 🚀 **Higher throughput, lower latency.** <!-- bench-headline:start -->
Same NestJS app, only the import changed: **nestjs-axios-undici served 4.0-4.2x the requests/s of @nestjs/axios, with 77% lower p95 latency** (Express and Fastify, Node.js 24). Preliminary: from a short local run; the full Docker + k6 benchmark replaces these numbers on the next release.
<!-- bench-headline:end --> The full benchmark runs in CI for every release and a performance regression check runs on every pull request; see the [results](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/benchmarks).
- 🔁 **Drop-in replacement.** Same `HttpModule` / `HttpService`, same `register` / `registerAsync` options, same `get` / `post` / `put` / `patch` / `delete` methods and `request(config)`, the same response shape (`data`, `status`, `headers`) and the same errors (`isAxiosError`, `error.response`, `error.code`). A 66-case compatibility test suite runs every case against real `@nestjs/axios`, on top of a 220+ scenario differential harness - see [Axios compatibility](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options) for the handful of documented, remaining differences.
- 🧪 **Tested against the upstream test suites.** Every pull request runs `@nestjs/axios`' own `HttpModule`/`HttpService` specs and axios' own HTTP adapter test suite against this package. The `@nestjs/axios` specs pass. Every axios test that doesn't pass is listed with a reason: a known gap (tracked for a fix), a deliberate difference, or a test-harness limitation. See the [expected-failure lists](https://github.com/yordan-kanchelov/nestjs-axios-undici/tree/main/tests/upstream) and [Axios compatibility](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options).
- 🧩 **Interceptors, two ways.** Keep your `httpService.axiosRef.interceptors.request.use(...)` code, or use native interceptors: functions or injectable classes that wrap every request.
- 🪶 **No axios dependency.** Requests go straight through undici. `axios` itself is an optional peer, only used (lazily, if installed) so `error instanceof axios.AxiosError` also holds for this package's errors - see [Errors](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options?id=errors).
- ✅ **Tested on Node.js 22, 24 and 26** (22 and 24 are LTS; 26 becomes LTS in October 2026), with a performance regression check on every pull request.

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
| `reflect-metadata` | 0.1.13+, 0.2 | required by `@nestjs/common`/`@nestjs/core` themselves (their own peer dependency), not declared as this package's own peer - unused by this package's code |

Every combination is installed from the packed package and run as both a CommonJS and an ESM app in CI, including the lowest versions of each range, and again weekly to catch new releases.

`http-cookie-agent` (8) and `tough-cookie` (5 or 6) are optional peers, only needed for the `cookieJar` option (see [Cookies: `cookieJar`](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options?id=cookies-cookiejar)) - install them yourself if you use it. `axios` (1.x) is also an optional peer: install it and `error instanceof axios.AxiosError` holds for this package's errors too, with no other change in behaviour.

## Migrating from @nestjs/axios

```typescript
// Before
import { HttpModule, HttpService } from '@nestjs/axios';

// After
import { HttpModule, HttpService } from 'nestjs-axios-undici';
```

Existing calls, axios options and `axiosRef` interceptors keep working. The [migration guide](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/migration-guide) covers the remaining differences.

## Quick Start

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

Non-2xx responses reject with an axios-style error (`error.response.status`, `error.code`), exactly like `@nestjs/axios`.

## Configuration

`register()` accepts axios options (`baseURL`, `timeout`, `headers`, `auth`, `params`, `maxRedirects`, `validateStatus`, `httpAgent`, `proxy`, `withCredentials` (a no-op, like axios on Node.js - see `cookieJar` for opt-in cookie handling), ...) and undici options (such as a custom `dispatcher`). `registerAsync()` applies the same mapping:

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

See [Configuration](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/configuration) and [Axios Compatibility](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options).

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
- Guides: [Configuration](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/configuration) · [Making Requests](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/making-requests) · [Interceptors](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/interceptors) · [Error Handling](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/error-handling) · [Testing](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/guides/testing)
- Reference: [Axios Compatibility](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/axios-supported-options) · [HttpModule](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/http/http.module) · [HttpService](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/http/http.service)
- [Benchmarks](https://yordan-kanchelov.github.io/nestjs-axios-undici/#/docs/benchmarks) and how to run them: [`benchmarks/`](https://github.com/yordan-kanchelov/nestjs-axios-undici/tree/main/benchmarks)

## Contributing

Contributions are welcome. Run `npm test` (unit, e2e and examples) before opening a pull request, and add a changeset (`npx changeset`) describing any change to the published package. Releases are cut automatically from the changesets; see [CHANGELOG.md](https://github.com/yordan-kanchelov/nestjs-axios-undici/blob/main/CHANGELOG.md).

The dev dependencies are NestJS 12, whose packages are ESM-only. Jest can load them only on Node.js 24.9 or later, so develop on Node 24+ and run Jest through the npm scripts (`npm test`, `npm run test:jest`, `npm run test:cov`), which pass the `--experimental-vm-modules` flag Jest needs; a bare `npx jest` won't. On Node 22, install an older Nest major over the lockfile first, as CI does: `npm i --no-save @nestjs/common@11 @nestjs/core@11 @nestjs/testing@11 @nestjs/platform-express@11 @nestjs/axios@4` (and `npm ci` to go back).

## Credits

This project started as a fork of [nestjs-undici](https://github.com/hebertcisco/nestjs-undici) by [Hebert Cisco](https://github.com/hebertcisco). Thank you for the foundation it is built on.

## License

[MIT](https://github.com/yordan-kanchelov/nestjs-axios-undici/blob/main/LICENSE)
