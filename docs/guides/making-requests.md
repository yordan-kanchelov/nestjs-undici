# Making requests

The `HttpService` provides an axios-compatible API on top of the [undici](https://github.com/nodejs/undici) client. Every method returns an RxJS `Observable` that emits an axios-like response.

## Basic usage

```typescript
import { Injectable } from '@nestjs/common';
import { HttpService } from 'nestjs-axios-undici';
import { lastValueFrom } from 'rxjs';

@Injectable()
export class CatsService {
  constructor(private readonly httpService: HttpService) {}

  async findAll() {
    const response = await lastValueFrom(
      this.httpService.get<Cat[]>('https://api.example.com/cats')
    );
    return response.data; // Already parsed JSON
  }
}
```

## Convenience methods

The familiar axios methods are available: `get`, `post`, `put`, `delete`, `patch`, `head`, `options`, `postForm`, `putForm` and `patchForm`.

```typescript
async create(cat: CreateCatDto) {
  const response = await lastValueFrom(
    this.httpService.post<Cat>('https://api.example.com/cats', cat)
  );
  return response.data; // Objects are serialized to JSON automatically
}
```

## Request options

The methods take the same per-request options as axios:

```typescript
const { data } = await firstValueFrom(
  this.httpService.get<Cat[]>('https://api.example.com/cats', {
    headers: { Authorization: 'Bearer token' },
    params: { page: 1, limit: 10 },
    timeout: 5000,
  }),
);
```

`request(config)` accepts the axios config object:

```typescript
this.httpService.request({
  url: 'https://api.example.com/cats',
  method: 'POST',
  data: { name: 'Tom' },
});
```

See [Axios compatibility](/docs/axios-supported-options.md#request-config) for every option and its differences from axios.

## Undici-style `request`

`request(url, options)` also accepts [undici request options](https://github.com/nodejs/undici#undicirequesturl-options-promise) such as `method`, `headers`, `body`, `query` and `dispatcher`:

```typescript
this.httpService.request('https://api.example.com/search', {
  query: { q: 'nestjs', page: 1 },
  timeout: 5000,
});
```

## Working with observables

The methods return cold Observables. The request is sent when you subscribe, or call `firstValueFrom` or `lastValueFrom`, so RxJS operators such as `retry` send it again:

```typescript
import { of } from 'rxjs';
import { catchError, map, retry } from 'rxjs/operators';

getCatName(id: string) {
  return this.httpService.get<Cat>(`https://api.example.com/cats/${id}`).pipe(
    map(response => response.data.name),
    retry(3),
    catchError(() => of('Unknown cat')),
  );
}
```

## Response handling

Responses have the axios structure:

- `data`: Parsed response body (JSON, text or `Buffer`)
- `status` / `statusText`: HTTP status code and text
- `headers`: Response headers
- `config`: Request configuration

Like axios, non-2xx responses are emitted as errors. See [Error handling](/docs/guides/error-handling.md).
