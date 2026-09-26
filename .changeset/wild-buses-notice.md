---
'nestjs-axios-undici': minor
---

Unsubscribing from a request Observable before it emits (rxjs `timeout()`, `switchMap`, `takeUntil`, `race`, ...) now aborts the in-flight undici request, matching `@nestjs/axios`' `makeObservable`. The abort is skipped once the response has been emitted, or, for `responseType: 'stream'`, once the headers have arrived.

`axiosRef` request interceptors now run fresh on every subscription instead of once when `get()`/`post()`/... is called, so `get().pipe(retry())` sends a new set of headers on each attempt instead of replaying the first one. `HttpService` methods already returned cold Observables; they still do no work before subscribe.
