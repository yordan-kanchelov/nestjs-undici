/**
 * Real-server regression test for the `maxContentLength` + gzip fix:
 * `readBuffer`/`readText` (axios-response-type.adapter.ts) now stream the
 * decompression and enforce `maxContentLength` on the decompressed bytes as
 * they arrive, instead of buffering the whole (possibly huge) decompressed
 * body first. See also the deterministic, in-process unit tests in
 * `src/modules/http/adapters/__tests__/axios-response-type.adapter.spec.ts`.
 *
 * This test uses a real local `node:http` server that trickles a highly
 * compressible ("gzip bomb"-shaped) response over several writes, so the
 * client's early abort has a real chance to land before the server has
 * finished sending everything - and the server can observe its own request
 * socket close early, the same way `tests/compat/differential/harness.ts`
 * tracks `aborted` (`!res.writableFinished`) for other cases.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { constants as zlibConstants, createGzip } from 'node:zlib';
import { firstValueFrom } from 'rxjs';
import { HttpModule, HttpService } from '../src';

describe('gzip response + maxContentLength: early abort on a real server', () => {
  let server: Server;
  let baseUrl: string;
  let service: HttpService;

  // Total writes the server would send if never interrupted, and how many
  // it actually got through before its response was closed/errored.
  const TOTAL_WRITES = 40;
  const WRITE_INTERVAL_MS = 5;
  const ZERO_CHUNK = Buffer.alloc(2 * 1024 * 1024); // 2MB of zeros per write
  let writesCompleted = 0;
  let serverSawEarlyClose = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url !== '/gzip-bomb') {
        res.writeHead(404);
        res.end();
        return;
      }
      writesCompleted = 0;
      serverSawEarlyClose = false;

      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'gzip',
      });
      const gz = createGzip();
      gz.pipe(res);

      let i = 0;
      const timer: ReturnType<typeof setInterval> = setInterval(() => {
        if (res.destroyed || res.writableEnded || i >= TOTAL_WRITES) {
          clearInterval(timer);
          if (i >= TOTAL_WRITES && !res.writableEnded && !res.destroyed) {
            gz.end();
          }
          return;
        }
        i++;
        gz.write(ZERO_CHUNK);
        gz.flush(zlibConstants.Z_SYNC_FLUSH, () => {
          writesCompleted++;
          if (writesCompleted >= TOTAL_WRITES) gz.end();
        });
      }, WRITE_INTERVAL_MS);

      res.on('close', () => {
        clearInterval(timer);
        if (writesCompleted < TOTAL_WRITES) serverSawEarlyClose = true;
        gz.destroy();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    service = module.get<HttpService>(HttpService);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('rejects quickly, and the server sees the connection close before sending the whole body', async () => {
    const wouldTakeMs = TOTAL_WRITES * WRITE_INTERVAL_MS; // ~200ms if never aborted

    const t0 = Date.now();
    await expect(
      firstValueFrom(
        service.get(`${baseUrl}/gzip-bomb`, {
          maxContentLength: 1000,
          responseType: 'arraybuffer',
        }),
      ),
    ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
    const elapsedMs = Date.now() - t0;

    // Rejects well before the server would have finished sending everything
    // (generous bound for CI noise; the decompressed limit is crossed on
    // one of the very first writes).
    expect(elapsedMs).toBeLessThan(wouldTakeMs);

    // Give the server's own 'close' handler a moment to run.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(serverSawEarlyClose).toBe(true);
    expect(writesCompleted).toBeLessThan(TOTAL_WRITES);
  });
});
