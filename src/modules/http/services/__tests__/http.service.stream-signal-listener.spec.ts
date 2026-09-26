import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { getEventListeners } from 'events';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Readable } from 'stream';

import { HttpService } from '../http.service';
import { HttpModule } from '../../http.module';

/**
 * PR #38 review (MEDIUM): pins the lifetime of the `abort` listener
 * `HttpService` attaches to a caller-supplied `AbortSignal` for a
 * `responseType: 'stream'` response (see `openStream`/`onUserAbort` in
 * `http.service.ts`, and the `signal` row in
 * `docs/axios-supported-options.md`). The listener is deliberately kept
 * alive for as long as the stream itself stays open - mirroring axios' own
 * `stream.finished(data, onFinished)` (`lib/adapters/http.js`), which has
 * the same lifetime - so it's removed only once the stream closes or is
 * destroyed, not the instant the response resolves. An abandoned,
 * never-drained, never-destroyed stream therefore keeps it (and everything
 * it closes over) alive forever; that's intentional axios parity, not a
 * bug, but it's easy to hit by accident with a long-lived/shared signal -
 * documented, and pinned here.
 */
describe('HttpService - abort listener lifetime for responseType: "stream"', () => {
  let service: HttpService;
  let module: TestingModule;
  let server: http.Server;
  let url: string;

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello world');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    module = await Test.createTestingModule({
      imports: [HttpModule.register()],
    }).compile();
    service = module.get(HttpService);
  });

  afterEach(async () => {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await module.close();
  });

  it('attaches exactly one abort listener to the caller signal while the stream is open', async () => {
    const controller = new AbortController();
    await firstValueFrom(
      service.get(url, {
        responseType: 'stream',
        signal: controller.signal,
      } as any),
    );

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
  });

  it('removes the listener once the stream is fully drained (closes)', async () => {
    const controller = new AbortController();
    const res = await firstValueFrom(
      service.get(url, {
        responseType: 'stream',
        signal: controller.signal,
      } as any),
    );
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    for await (const _chunk of res.data as Readable) {
      // drain
    }
    // 'close' fires on the next tick after the stream ends.
    await new Promise(resolve => setImmediate(resolve));

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes the listener when the stream is destroyed instead of drained', async () => {
    const controller = new AbortController();
    const res = await firstValueFrom(
      service.get(url, {
        responseType: 'stream',
        signal: controller.signal,
      } as any),
    );
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    (res.data as Readable).destroy();
    await new Promise(resolve => setImmediate(resolve));

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('an abandoned, never-drained, never-destroyed stream keeps the listener alive (documented axios parity, not a leak in this library specifically)', async () => {
    const controller = new AbortController();
    await firstValueFrom(
      service.get(url, {
        responseType: 'stream',
        signal: controller.signal,
      } as any),
    );

    // Give any close/cleanup microtask a chance to run - there shouldn't
    // be one, since nothing consumed or destroyed the stream.
    await new Promise(resolve => setImmediate(resolve));

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
  });

  it('does NOT keep the listener alive after resolution for a buffered (non-stream) responseType', async () => {
    const controller = new AbortController();
    await firstValueFrom(
      service.get(url, { signal: controller.signal } as any),
    );

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
