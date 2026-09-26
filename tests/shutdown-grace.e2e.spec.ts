/**
 * plan.md phase 2, "decide: `HttpService.onModuleDestroy` waits forever for
 * an unconsumed `responseType: 'stream'` response": `dispatcher.close()` is
 * graceful - it waits for every outstanding request to finish - so a
 * `responseType: 'stream'` response nobody ever reads or `.destroy()`s
 * keeps its dispatcher open, and used to keep `onModuleDestroy` (and
 * therefore `app.close()`) waiting forever.
 *
 * Fixed by racing `close()` against an internal grace period
 * (`closeDispatcherWithGrace`, `src/modules/http/services/http.service.ts`)
 * and falling back to `destroy()` - which aborts whatever is left - once it
 * elapses. These tests exercise that against real servers/sockets; every one
 * of them would hang (or, at best, time out at Jest's default 5s test
 * timeout without ever observing the intended behaviour) on the unfixed
 * code, since `onModuleDestroy` awaited `close()` with no bound at all.
 *
 * The grace period itself is a plain internal constant
 * (`DEFAULT_SHUTDOWN_GRACE_MS`, 5s - see its doc comment for why), not a
 * public option - kept fast here only through an undocumented, test-only
 * environment variable override (`__NESTJS_AXIOS_UNDICI_TEST_SHUTDOWN_GRACE_MS`),
 * read fresh on every `close()`/`destroy()` race, never cached.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';

import { HttpModule, HttpService } from '../src';

const GRACE_ENV_VAR = '__NESTJS_AXIOS_UNDICI_TEST_SHUTDOWN_GRACE_MS';

describe('HttpService shutdown grace period (e2e)', () => {
  let server: http.Server;
  let baseUrl: string;
  let openConns = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://placeholder');

      if (url.pathname === '/hang') {
        // Headers (and a first chunk, so the client definitely has
        // something buffered) arrive right away; the response then never
        // ends - simulating a `responseType: 'stream'` body nobody ever
        // reads or `.destroy()`s. Only `destroy()`-ing the dispatcher (or
        // the server closing the socket itself) ever ends this.
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('partial');
        res.flushHeaders();
        return;
      }

      if (url.pathname === '/slow') {
        const delayMs = Number(url.searchParams.get('delayMs')) || 150;
        setTimeout(() => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, delayMs }));
        }, delayMs);
        return;
      }

      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    server.on('connection', socket => {
      openConns++;
      socket.on('close', () => {
        openConns--;
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  /** Lets a just-closed TCP connection's server-side `close` event actually
   * fire before the next assertion reads `openConns` - see the identical
   * helper in `dispatcher-lifecycle.e2e.spec.ts`. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 200));

  afterEach(() => {
    delete process.env[GRACE_ENV_VAR];
  });

  async function register(
    options: Parameters<typeof HttpModule.register>[0] = {},
  ): Promise<{ module: TestingModule; service: HttpService }> {
    const module = await Test.createTestingModule({
      imports: [HttpModule.register(options)],
    }).compile();
    return { module, service: module.get(HttpService) };
  }

  it('closes within the grace period plus a small margin for an abandoned responseType: "stream" response, and the server sees the socket closed', async () => {
    process.env[GRACE_ENV_VAR] = '300';
    const before = openConns;
    const { module, service } = await register({});

    // Fired and never touched again: no `.data` read, no `.destroy()` - the
    // exact "unconsumed stream" scenario the decision item describes.
    const response = await firstValueFrom(
      service.get(`${baseUrl}/hang`, { responseType: 'stream' }),
    );
    expect(response.status).toBe(200);

    const start = Date.now();
    await module.close();
    const elapsed = Date.now() - start;

    // Bounded by the grace period (destroy() then takes over) - not
    // instant (proves it genuinely tried `close()` first), and nowhere
    // near unbounded/hanging.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1500);

    await settle();
    expect(openConns).toBe(before);
  });

  it('keeps a normal in-flight request working: it still completes successfully while shutdown is in progress', async () => {
    const { module, service } = await register({});

    const responsePromise = firstValueFrom(
      service.get(`${baseUrl}/slow?delayMs=200`),
    );
    // Give the request a moment to actually reach the server before
    // closing, so `close()` has something in flight to wait for.
    await new Promise(resolve => setTimeout(resolve, 30));

    const closeStart = Date.now();
    const closePromise = module.close();
    const [response] = await Promise.all([responsePromise, closePromise]);
    const closeElapsed = Date.now() - closeStart;

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true, delayMs: 200 });
    // Proves shutdown waited for the slow response to finish gracefully
    // (close() winning the race), rather than cutting it short.
    expect(closeElapsed).toBeGreaterThanOrEqual(100);
    // Nowhere near the 5s default grace period / a destroy() fallback.
    expect(closeElapsed).toBeLessThan(2000);
  });

  it('resolves immediately on a clean shutdown with nothing in flight, without waiting for the grace period', async () => {
    const { module, service } = await register({});
    // Fully drain a normal request first, so nothing is left open.
    await firstValueFrom(service.get(baseUrl));
    await settle();

    const start = Date.now();
    await module.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  it('never closes or destroys a user-supplied dispatcher, even with an abandoned responseType: "stream" response left on it', async () => {
    process.env[GRACE_ENV_VAR] = '300';
    const userDispatcher = new Agent();
    const closeSpy = jest.spyOn(userDispatcher, 'close');
    const destroySpy = jest.spyOn(userDispatcher, 'destroy');
    const { module, service } = await register({ dispatcher: userDispatcher });

    const response = await firstValueFrom(
      service.get(`${baseUrl}/hang`, { responseType: 'stream' }),
    );
    expect(response.status).toBe(200);

    const start = Date.now();
    await module.close();
    const elapsed = Date.now() - start;

    // Not this service's dispatcher to manage - onModuleDestroy has
    // nothing of its own to close, so it returns immediately, without even
    // waiting out the (overridden, short) grace period.
    expect(elapsed).toBeLessThan(200);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();

    // Cleanup: the caller owns this dispatcher, so this library never tore
    // down the still-open `/hang` connection on it - do it ourselves.
    await userDispatcher.destroy();
  });
});
