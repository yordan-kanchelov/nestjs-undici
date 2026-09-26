/**
 * plan.md phase 3 "Resource cleanup" / "HttpService members" / "Default
 * dispatcher" / "Duplicate undici copy" / "Option mapping": tests for the
 * per-service default `Agent`, `OnModuleDestroy`, `setDispatcher` and the
 * axios-only-key stripping this item adds.
 *
 * Reproduces the probes from `plan/prototypes/quality/scripts/
 * runtime-probes.js` ("dispatchers created by module closed on app close?",
 * "static HttpModule (no register) shares instanceOptions across apps") as
 * real Jest tests, plus new coverage for `setDispatcher`/`undiciRef`/option
 * stripping.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Agent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';

import { HttpModule, HttpService } from '../src';

describe('dispatcher lifecycle (e2e)', () => {
  let server: http.Server;
  let baseUrl: string;
  let openConns = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
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

  async function register(
    options: Parameters<typeof HttpModule.register>[0] = {},
  ): Promise<{ module: TestingModule; service: HttpService }> {
    const module = await Test.createTestingModule({
      imports: [HttpModule.register(options)],
    }).compile();
    return { module, service: module.get(HttpService) };
  }

  /** Lets a just-closed TCP connection's server-side `close` event actually
   * fire before the next test reads `openConns` - closing a dispatcher
   * resolves once undici's side is done, a moment before the socket's FIN/
   * ACK teardown completes and the server sees it. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 200));
  afterEach(settle);

  it('uses its own per-service default Agent, unaffected by undici.setGlobalDispatcher()', async () => {
    const previous = getGlobalDispatcher();
    const foreignDispatch = jest.fn(() => {
      throw new Error('the foreign global dispatcher must never be used');
    });
    setGlobalDispatcher({
      dispatch: foreignDispatch,
      close: async () => undefined,
      destroy: async () => undefined,
    } as unknown as Dispatcher);

    const { module, service } = await register({});
    try {
      const response = await firstValueFrom(service.get(baseUrl));
      expect(response.status).toBe(200);
      expect(foreignDispatch).not.toHaveBeenCalled();
    } finally {
      setGlobalDispatcher(previous);
      await module.close();
    }
  });

  it('onModuleDestroy closes the per-service default dispatcher: no lingering connection after app.close()', async () => {
    const before = openConns;
    const { module, service } = await register({});
    await firstValueFrom(service.get(baseUrl));
    await module.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(openConns).toBe(before);
  });

  it('onModuleDestroy closes a module-built dispatcher (httpAgent keep-alive)', async () => {
    const before = openConns;
    const { module, service } = await register({
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 4 }),
    });
    await firstValueFrom(service.get(baseUrl));
    await module.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(openConns).toBe(before);
  });

  it('onModuleDestroy never closes a user-supplied dispatcher', async () => {
    const userDispatcher = new Agent();
    const closeSpy = jest.spyOn(userDispatcher, 'close');
    const { module, service } = await register({ dispatcher: userDispatcher });
    await firstValueFrom(service.get(baseUrl));
    await module.close();
    expect(closeSpy).not.toHaveBeenCalled();
    await userDispatcher.close();
  });

  it('setDispatcher replaces the dispatcher and closes the one this service created', async () => {
    const { module, service } = await register({});
    // Nothing configured, so the per-service default is the one currently
    // serving requests - `setDispatcher` must close it once replaced.
    const defaultDispatcher = (
      service as unknown as { defaultDispatcher: Dispatcher }
    ).defaultDispatcher;
    const closeSpy = jest.spyOn(defaultDispatcher, 'close');

    const replacement = new Agent();
    service.setDispatcher(replacement);
    // undici's own `Agent#close()` invokes itself more than once internally
    // (verified directly against undici) - assert it was closed at all,
    // not an exact call count.
    expect(closeSpy).toHaveBeenCalled();

    const dispatchSpy = jest.spyOn(replacement, 'dispatch');
    const response = await firstValueFrom(service.get(baseUrl));
    expect(response.status).toBe(200);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    await module.close();
    await replacement.close();
  });

  it('setDispatcher never closes a dispatcher the caller supplied, even when replaced', async () => {
    const original = new Agent();
    const closeSpy = jest.spyOn(original, 'close');
    const { module, service } = await register({ dispatcher: original });

    service.setDispatcher(new Agent());
    expect(closeSpy).not.toHaveBeenCalled();

    await module.close();
    await original.close();
  });

  it('undiciRef is a frozen, read-only snapshot without internal __ keys', async () => {
    const { module, service } = await register({
      proxy: { host: '127.0.0.1', port: 1 },
      httpAgent: new http.Agent({ keepAlive: true }),
    });
    try {
      const ref = service.undiciRef;
      expect(Object.isFrozen(ref)).toBe(true);
      expect(
        Object.keys(ref as unknown as Record<string, unknown>).filter(k =>
          k.startsWith('__'),
        ),
      ).toEqual([]);
      expect(() => {
        'use strict';
        (ref as unknown as Record<string, unknown>).dispatcher = undefined;
      }).toThrow();
      // A fresh call is a fresh object - mutating one snapshot can't affect
      // a later read either.
      expect(service.undiciRef).not.toBe(ref);
    } finally {
      await module.close();
    }
  });

  it('strips axios-only keys before they reach the dispatcher', async () => {
    const dispatcher = new Agent();
    const dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
    const { module, service } = await register({
      dispatcher,
      auth: { username: 'u', password: 'p' },
      withCredentials: true,
      xsrfCookieName: 'XSRF-TOKEN',
      xsrfHeaderName: 'X-XSRF-TOKEN',
      httpVersion: 1,
    });
    try {
      await firstValueFrom(service.get(baseUrl));
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const opts = dispatchSpy.mock.calls[0][0] as unknown as Record<
        string,
        unknown
      >;
      for (const key of [
        'auth',
        'httpAgent',
        'httpsAgent',
        'proxy',
        'httpVersion',
        'cookieJar',
        'withCredentials',
        'xsrfCookieName',
        'xsrfHeaderName',
        '__resolvedConfig',
      ]) {
        expect(opts).not.toHaveProperty(key);
      }
    } finally {
      await module.close();
      await dispatcher.close();
    }
  });

  it('axiosRef.create() shares the parent HttpService transport', async () => {
    const { module, service } = await register({});
    try {
      const defaultDispatcher = (
        service as unknown as { defaultDispatcher: Dispatcher }
      ).defaultDispatcher;
      const dispatchSpy = jest.spyOn(defaultDispatcher, 'dispatch');

      const child = service.axiosRef.create();
      const response = await child.get(baseUrl);
      expect(response.status).toBe(200);
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await module.close();
    }
  });

  it('the static HttpModule import (no register()) does not share options between apps', async () => {
    const [moduleA, moduleB] = await Promise.all([
      Test.createTestingModule({ imports: [HttpModule] }).compile(),
      Test.createTestingModule({ imports: [HttpModule] }).compile(),
    ]);
    try {
      const serviceA = moduleA.get(HttpService);
      const serviceB = moduleB.get(HttpService);
      serviceA.setDispatcher(new Agent());
      expect(serviceA.undiciRef).not.toBe(serviceB.undiciRef);
      expect(serviceB.undiciRef.dispatcher).toBeUndefined();
    } finally {
      await moduleA.close();
      await moduleB.close();
    }
  });
});
