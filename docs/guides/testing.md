# Testing

You can test services that use `nestjs-axios-undici` either by mocking the `HttpService` directly or by using undici's `MockAgent`.

## Mocking HttpService

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from 'nestjs-axios-undici';
import { of } from 'rxjs';
import { CatsService } from './cats.service';

describe('CatsService', () => {
  let service: CatsService;
  let httpService: HttpService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatsService,
        { provide: HttpService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<CatsService>(CatsService);
    httpService = module.get<HttpService>(HttpService);
  });

  it('should find all cats', async () => {
    jest.spyOn(httpService, 'get').mockReturnValue(
      of({ data: [{ name: 'Cat 1' }], status: 200, statusText: 'OK', headers: {}, config: {} } as any),
    );

    expect(await service.findAll()).toEqual([{ name: 'Cat 1' }]);
  });
});
```

## Using undici's MockAgent

`MockAgent` intercepts requests inside the Node.js process, so the real `HttpService` logic (interceptors, response and error handling) is exercised.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule } from 'nestjs-axios-undici';
import { MockAgent } from 'undici';
import { CatsService } from './cats.service';

describe('CatsService (Integration)', () => {
  let service: CatsService;

  beforeEach(async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get('https://api.example.com')
      .intercept({ path: '/cats', method: 'GET' })
      .reply(200, [{ name: 'Cat 1' }], { headers: { 'content-type': 'application/json' } });

    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({ dispatcher: mockAgent })],
      providers: [CatsService],
    }).compile();

    service = module.get<CatsService>(CatsService);
  });

  it('should return cats from mock agent', async () => {
    expect(await service.findAll()).toEqual([{ name: 'Cat 1' }]);
  });
});
```

## Testing interceptors

An interceptor is a function (or an `intercept()` method) that takes a request and a handler, so it can be tested without a module or a server. Stub `next.handle()` and check the request it receives:

```typescript
import { of, lastValueFrom } from 'rxjs';
import type { HttpInterceptorHandler, HttpInterceptorRequest } from 'nestjs-axios-undici';
import { createAuthInterceptor } from './auth.interceptor';

describe('authInterceptor', () => {
  it('adds the Authorization header', async () => {
    const next: HttpInterceptorHandler = {
      handle: jest.fn().mockReturnValue(of({ data: 'ok', status: 200 })),
    };
    const request: HttpInterceptorRequest = { url: 'https://api.example.com', options: { headers: {} } };

    await lastValueFrom(createAuthInterceptor('token')(request, next));

    expect(next.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer token' }),
        }),
      }),
    );
  });
});
```

Class interceptors with dependencies can be created through a testing module. Here, `LoggingInterceptor` injects Nest's own `Logger`:

```typescript
import { Logger } from '@nestjs/common';

@Injectable()
class LoggingInterceptor implements HttpInterceptor {
  constructor(private readonly logger: Logger) {}

  intercept(request: HttpInterceptorRequest, next: HttpInterceptorHandler) {
    this.logger.log(`Request to ${request.url}`);
    return next.handle(request);
  }
}

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let logger: Logger;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [LoggingInterceptor, Logger],
    }).compile();

    interceptor = module.get(LoggingInterceptor);
    logger = module.get(Logger);
  });

  it('logs requests', async () => {
    const spy = jest.spyOn(logger, 'log');
    const next = { handle: jest.fn().mockReturnValue(of({ data: 'ok', status: 200 })) };

    await lastValueFrom(interceptor.intercept({ url: '/test', options: {} }, next));

    expect(spy).toHaveBeenCalledWith('Request to /test');
  });
});
```

To test an interceptor together with the real `HttpService`, register it on `HttpModule` with a `MockAgent` dispatcher, as shown above.

## Upstream conformance suites

This package's own test suite is one thing; whether it actually behaves like `@nestjs/axios` and axios is another. `tests/upstream/` runs each project's *own, unmodified* test files against this package: `@nestjs/axios`'s `http.service.spec.ts`/`http.module.spec.ts` against `HttpModule`/`HttpService`, and axios' `tests/unit/adapters/http.test.js` against both `axiosRef` (as the axios instance) and a small adapter backed by this package's transport code. Each upstream project is cloned at a pinned tag at run time (never vendored), and a checked-in `expected-failures*.json` per suite tracks the known, already-understood gaps. The run fails on any *new* failure, and on any expected failure that starts passing (a fix landed, so it's removed from the list).

```bash
npm run test:upstream          # both suites
npm run test:upstream:nestjs   # just @nestjs/axios
npm run test:upstream:axios    # just axios (both strategies)
```

See `tests/upstream/README.md` for the full breakdown, the expected-failures format, and the licensing note for the two cloned projects.

## Overriding the module's own providers

`HttpModule.register()`/`.registerAsync()` register `HttpService` from two injection tokens, both exported so a test module can override either directly with Nest's `overrideProvider()` instead of building a whole `HttpModule.register({...})`:

- `UNDICI_INSTANCE_TOKEN`: the resolved undici/request options `HttpService`'s constructor receives (what `HttpService#undiciRef` reads back).
- `HTTP_MODULE_OPTIONS`: the original, axios-shaped module options (what seeds `axiosRef.defaults`).

```typescript
import { Test } from '@nestjs/testing';
import {
  HttpModule,
  HttpService,
  UNDICI_INSTANCE_TOKEN,
  HTTP_MODULE_OPTIONS,
} from 'nestjs-axios-undici';

const module = await Test.createTestingModule({
  imports: [HttpModule],
})
  .overrideProvider(UNDICI_INSTANCE_TOKEN)
  .useValue({ baseURL: 'https://api.example.com' })
  .overrideProvider(HTTP_MODULE_OPTIONS)
  .useValue({ baseURL: 'https://api.example.com' })
  .compile();

const httpService = module.get(HttpService);
```

Most tests are simpler with `HttpModule.register({...})` directly (as shown throughout this guide); reach for these tokens only when a testing helper needs to override an already-built module's providers without reconstructing it.
