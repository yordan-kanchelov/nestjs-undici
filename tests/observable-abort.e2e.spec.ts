import { Test, TestingModule } from '@nestjs/testing';
import { createServer, Server } from 'node:http';
import { getEventListeners } from 'node:events';
import { AddressInfo } from 'node:net';
import { firstValueFrom, Subject } from 'rxjs';
import { retry, takeUntil, timeout as rxTimeout } from 'rxjs/operators';
import { HttpModule, HttpService, isCancel } from '../src';

/**
 * Covers plan.md phase 2 "fix(observable): abort on unsubscribe and run
 * request interceptors per subscription": unsubscribing before the response
 * arrives must abort the upstream request (matching `@nestjs/axios`), and
 * each subscription must run the axiosRef request interceptors fresh.
 *
 * No fixed sleeps: every assertion waits on a server-side event (the
 * request's socket `close`, or the interceptor chain's own completion).
 */
describe('HttpService Observable semantics: abort on unsubscribe', () => {
  let server: Server;
  let baseUrl: string;
  let service: HttpService;

  // requestId -> resolve() called from the server's `close` handler for that
  // request. Populated by /hang, which never sends a response, so `close`
  // only fires when the client tore down the connection (an abort).
  const pendingCloses = new Map<string, () => void>();
  const waitForServerClose = (id: string): Promise<void> =>
    new Promise(resolve => pendingCloses.set(id, resolve));

  // requestId -> resolve() called as soon as /hang receives that request, so
  // a test can wait for the connection to actually reach the server before
  // triggering an unsubscribe/abort (otherwise the abort could win the race
  // and the request would never reach the server at all).
  const pendingStarts = new Map<string, () => void>();
  const waitForServerStart = (id: string): Promise<void> =>
    new Promise(resolve => pendingStarts.set(id, resolve));

  // Requests seen by /retry-target, in order, with the headers they carried.
  let retryAttempts: Array<Record<string, string | string[] | undefined>>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://placeholder');

      if (url.pathname === '/hang') {
        const id = url.searchParams.get('id') as string;
        pendingStarts.get(id)?.();
        pendingStarts.delete(id);
        req.on('close', () => {
          if (!res.writableEnded) {
            pendingCloses.get(id)?.();
            pendingCloses.delete(id);
          }
        });
        // Deliberately never respond: the only way this connection closes
        // is the client aborting it.
        return;
      }

      if (url.pathname === '/retry-target') {
        retryAttempts.push({ ...req.headers });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('boom');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  let module: TestingModule;

  beforeEach(async () => {
    retryAttempts = [];
    pendingCloses.clear();
    pendingStarts.clear();
    module = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    service = module.get<HttpService>(HttpService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('rxjs timeout() unsubscribing aborts the upstream request', async () => {
    const closed = waitForServerClose('timeout-case');

    await expect(
      firstValueFrom(
        service.get(`${baseUrl}/hang?id=timeout-case`).pipe(rxTimeout(50)),
      ),
    ).rejects.toThrow();

    // Resolves only when the server observed the connection close; a stuck
    // test here would mean the request was left running.
    await closed;
  });

  it('takeUntil() unsubscribing aborts the upstream request', async () => {
    const started = waitForServerStart('take-until-case');
    const closed = waitForServerClose('take-until-case');
    const stop$ = new Subject<void>();

    const result$ = service
      .get(`${baseUrl}/hang?id=take-until-case`)
      .pipe(takeUntil(stop$));
    const subscription = result$.subscribe();

    // Wait for the connection to actually reach the server before firing the
    // notifier, otherwise the abort could win the race against the socket
    // ever being opened and the server would never see anything at all.
    await started;
    stop$.next();
    subscription.unsubscribe();

    // Resolves only once the server observes the connection close; a stuck
    // test here would mean the request was left running.
    await closed;
    expect(subscription.closed).toBe(true);
  });

  it('a user-supplied AbortSignal still cancels the request', async () => {
    const started = waitForServerStart('signal-case');
    const closed = waitForServerClose('signal-case');
    const controller = new AbortController();

    const pending = firstValueFrom(
      service.get(`${baseUrl}/hang?id=signal-case`, {
        signal: controller.signal,
      }),
    );
    await started;
    controller.abort();

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(isCancel(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('ERR_CANCELED');
    await closed;
  });

  it('leaves no abort listeners on a user signal reused across requests', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 3; i++) {
      const response = await firstValueFrom(
        service.get(`${baseUrl}/ok`, { signal: controller.signal }),
      );
      expect(response.data).toEqual({ ok: true });
    }

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('rxjs retry() re-runs the axiosRef request interceptors, with fresh headers each attempt', async () => {
    let n = 0;
    service.axiosRef.interceptors.request.use(config => {
      n += 1;
      // Replacing `config.headers` with a plain object is a runtime-only
      // pattern (axios' own `InternalAxiosRequestConfig.headers` is
      // similarly typed as `AxiosHeaders`, not a plain object, so this needs
      // a cast against real axios' types too).
      config.headers = {
        ...(config.headers as Record<string, string>),
        'X-Attempt': String(n),
      } as any;
      return config;
    });

    await expect(
      firstValueFrom(service.get(`${baseUrl}/retry-target`).pipe(retry(2))),
    ).rejects.toMatchObject({ isAxiosError: true });

    expect(retryAttempts).toHaveLength(3);
    expect(retryAttempts.map(headers => headers['x-attempt'])).toEqual([
      '1',
      '2',
      '3',
    ]);
  });
});
