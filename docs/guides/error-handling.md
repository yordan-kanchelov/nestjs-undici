# Error handling

`nestjs-axios-undici` follows axios semantics. Responses with a status outside the 2xx range are emitted as errors.

## HTTP status codes

Failed responses reject with an axios-like error exposing `error.response`, `error.config`, `error.status` and `error.isAxiosError`:

```typescript
import { Injectable, HttpException } from '@nestjs/common';
import { HttpService } from 'nestjs-axios-undici';
import { lastValueFrom } from 'rxjs';

@Injectable()
export class CatsService {
  constructor(private readonly httpService: HttpService) {}

  async findOne(id: string) {
    try {
      const response = await lastValueFrom(
        this.httpService.get(`https://api.example.com/cats/${id}`)
      );
      return response.data;
    } catch (error) {
      if (error.isAxiosError && error.response?.status === 404) {
        throw new HttpException('Cat not found', 404);
      }
      throw error;
    }
  }
}
```

To accept other status codes, pass `validateStatus` in the module options or per request, as you would with axios.

To tell status errors from errors without a response, check `error.response`. `error.request` is also set for network, timeout and cancellation errors. It's built from the hop that was actually dispatched, and includes `path`, `method`, `host`, `protocol` and `res.responseUrl`. It isn't set in the couple of cases where axios itself never builds a request object either, such as a signal that aborted before the request was ever dispatched, or an unsupported URL protocol.

```typescript
import { isAxiosError } from 'nestjs-axios-undici';

try {
  await lastValueFrom(this.httpService.get('https://api.example.com/cats/999'));
} catch (error) {
  if (isAxiosError(error) && error.response) {
    // The server responded with a status outside validateStatus
    console.log(error.response.status, error.response.data);
  } else if (isAxiosError(error)) {
    // No response: network error, timeout or cancellation
    console.log(error.code, error.message);
  } else {
    throw error; // e.g. an error thrown by an interceptor
  }
}
```

## Network errors

Network errors (DNS failures, refused connections, timeouts, cancellations) are emitted as axios errors too, with the same `code` values axios uses (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `ECONNABORTED`, `ERR_CANCELED`, ...). The original undici/Node.js error is available as `error.cause`. Handle them with `try/catch` or RxJS operators:

```typescript
import { catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';

this.httpService.get('https://api.example.com')
  .pipe(
    catchError(error => {
      console.error('Error:', error);
      return throwError(() => new Error('Something went wrong'));
    })
  )
  .subscribe();
```

## Timeouts

A `timeout` (module-level or per request) is a total, deadline-style timeout, like axios. It covers the whole request, from the moment it starts until the response body is fully read. For `responseType: 'stream'`, it covers the request until the response headers arrive, matching axios there too. This is a real timer, not undici's idle `headersTimeout`/`bodyTimeout`. Those are still set alongside it as a backstop, so a response body that trickles in slowly, one byte at a time, still times out at the configured value.

A timeout rejects with `code: 'ECONNABORTED'` and the message `timeout of <n>ms exceeded`, exactly like axios:

```typescript
import { isAxiosError } from 'nestjs-axios-undici';

try {
  await lastValueFrom(this.httpService.get('https://slow-api.com', { timeout: 2000 }));
} catch (error) {
  if (isAxiosError(error) && error.code === 'ECONNABORTED') {
    // Handle timeout
  }
}
```

Two axios options are honoured on the message/code:

```typescript
this.httpService.get('https://slow-api.com', {
  timeout: 2000,
  timeoutErrorMessage: 'The upstream API took too long to respond',
  transitional: { clarifyTimeoutError: true }, // code becomes 'ETIMEDOUT' instead of 'ECONNABORTED'
});
```

## Cancellation

Pass an `AbortSignal` (or an axios `CancelToken`). A cancelled request rejects with a `CanceledError` (`code: 'ERR_CANCELED'`), so `axios.isCancel(error)` and `isCancel(error)` from this package return `true`:

```typescript
const controller = new AbortController();
this.httpService.get('https://api.example.com', { signal: controller.signal }).subscribe();
controller.abort();
```

Unsubscribing from the Observable before it emits also aborts the request, for example with `timeout()`, `switchMap` or `takeUntil`, as in `@nestjs/axios`.
