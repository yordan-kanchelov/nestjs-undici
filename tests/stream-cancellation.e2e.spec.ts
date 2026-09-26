/**
 * Real-server tests for plan.md phase 2's two `responseType: 'stream'`
 * cancellation items:
 *
 * - "cancel a responseType: 'stream' response when its request stream is
 *   destroyed" - destroying the caller's own upload body stream mid-request
 *   used to destroy the response stream too, but with undici's raw
 *   `AbortError`/`UND_ERR_ABORTED`, not axios' `CanceledError`/
 *   `ERR_CANCELED`. Mirrors axios' own upstream test of the same name
 *   (`tests/unit/adapters/http.test.js`, "should destroy the response
 *   stream with an error on request stream destroying").
 * - "abort a responseType: 'stream' response when the caller's AbortSignal
 *   fires after emission" - once the stream was already handed back,
 *   `.abort()` on `config.signal` used to have no effect at all.
 *
 * See `wrapStreamCancellation` (`src/modules/http/adapters/axios-response
 * .adapter.ts`) for the mechanism, and the deterministic unit tests in
 * `axios-response.adapter.spec.ts` ("responseType stream cancellation") for
 * the fine-grained cases (gating, non-abort errors, bidirectional destroy).
 * No fixed sleeps: every assertion waits on a real event (a server-observed
 * request, or a stream event), never a timer.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { firstValueFrom } from 'rxjs';
import { HttpModule, HttpService, isCancel } from '../src';

describe('responseType: "stream" cancellation (real server)', () => {
  let server: Server;
  let baseUrl: string;
  let service: HttpService;

  // Resolved once the server has received at least one chunk of the
  // request body for a given request id - proof the connection is fully
  // established before the test destroys the client's own upload stream.
  const pendingUploadStarts = new Map<string, () => void>();
  const waitForUploadStart = (id: string): Promise<void> =>
    new Promise(resolve => pendingUploadStarts.set(id, resolve));

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://placeholder');

      if (url.pathname === '/echo-slow') {
        const id = url.searchParams.get('id') as string;
        // Headers (and the first flush) arrive at the client immediately,
        // well before the upload - which never naturally ends in this
        // test - could ever finish, mirroring axios' own upstream fixture
        // (`req.pipe(res)` against a server that starts writing right
        // away).
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.flushHeaders();
        let first = true;
        req.on('data', (chunk: Buffer) => {
          if (first) {
            first = false;
            pendingUploadStarts.get(id)?.();
            pendingUploadStarts.delete(id);
          }
          res.write(chunk);
        });
        req.on('end', () => res.end());
        // Deliberately no `req.on('error', ...)`/cleanup beyond that: a
        // destroyed request stream on the client just closes this
        // connection, which Node's own `http.Server` handles without this
        // test needing to do anything else with it.
        return;
      }

      if (url.pathname === '/drip') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.flushHeaders();
        // Keeps writing until the connection closes (client abort) or the
        // test's own timeout would kick in - never `.end()`s on its own.
        const interval = setInterval(() => res.write('x'), 5);
        res.on('close', () => clearInterval(interval));
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(async () => {
    pendingUploadStarts.clear();
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    service = module.get<HttpService>(HttpService);
  });

  /** A `Readable` that keeps pushing chunks a tick apart until destroyed - never ends on its own, matching axios' own `generateReadable()` fixture. */
  function generateReadable(): Readable {
    let i = 0;
    return new Readable({
      read() {
        if (i++ < 1_000_000) {
          this.push(Buffer.from('x'.repeat(1000)));
        } else {
          this.push(null);
        }
      },
    });
  }

  it('destroying the request stream mid-upload cancels a responseType: "stream" response with a real CanceledError', async () => {
    const id = 'request-stream-destroy';
    const started = waitForUploadStart(id);
    const uploadStream = generateReadable();

    const response = await firstValueFrom(
      service.post(`${baseUrl}/echo-slow?id=${id}`, uploadStream, {
        responseType: 'stream',
      }),
    );

    // Make sure the upload has genuinely reached the server before
    // destroying it - otherwise the destroy could win the race against the
    // connection ever being fully established.
    await started;

    let streamError: any;
    const drained = new Promise<void>(resolve => {
      response.data.on('data', () => undefined);
      response.data.on('error', (error: any) => {
        streamError = error;
        resolve();
      });
      response.data.on('end', resolve);
    });

    uploadStream.destroy();
    await drained;

    expect(streamError).toBeTruthy();
    expect(streamError.isAxiosError).toBe(true);
    expect(streamError.name).toBe('CanceledError');
    expect(streamError.code).toBe('ERR_CANCELED');
    expect(isCancel(streamError)).toBe(true);
  });

  it("aborting the caller's AbortSignal after the stream was already emitted destroys it with a real CanceledError", async () => {
    const controller = new AbortController();
    const response = await firstValueFrom(
      service.get(`${baseUrl}/drip`, {
        responseType: 'stream',
        signal: controller.signal,
      }),
    );

    // Wait for at least one real chunk, proving this is genuinely
    // "after emission", not a race with the headers themselves.
    await new Promise<void>(resolve => response.data.once('data', resolve));

    let streamError: any;
    const drained = new Promise<void>(resolve => {
      response.data.on('data', () => undefined);
      response.data.on('error', (error: any) => {
        streamError = error;
        resolve();
      });
      response.data.on('end', resolve);
    });

    controller.abort();
    await drained;

    expect(streamError).toBeTruthy();
    expect(streamError.isAxiosError).toBe(true);
    expect(streamError.name).toBe('CanceledError');
    expect(streamError.code).toBe('ERR_CANCELED');
    expect(isCancel(streamError)).toBe(true);
  });

  it('a plain streamed GET with no signal and no streamed body is unaffected: no wrapper at all, and the stream just ends normally when destroyed', async () => {
    const response = await firstValueFrom(
      service.get(`${baseUrl}/echo-slow?id=plain`, { responseType: 'stream' }),
    );
    // Zero-cost check: `wrapStreamCancellation` is never applied here (no
    // signal, no streamed upload body), so the caller gets back undici's
    // own body object directly - it still has `.text()`/`.arrayBuffer()`,
    // which a `PassThrough` wrapper never would.
    expect(typeof (response.data as any).text).toBe('function');

    // No request body at all here, so the server never writes anything
    // back either - close the connection from the client side to let the
    // handler (and this test) finish promptly.
    const ended = new Promise<void>(resolve => {
      response.data.on('error', resolve);
      response.data.on('end', resolve);
      response.data.on('close', resolve);
    });
    (response.data as any).destroy();
    await ended;
  });
});
