/**
 * Real-server test for plan.md phase 2 "fix: decode Content-Encoding:
 * compress": axios' Node `http` transport aliases `compress`/`x-compress`
 * onto its gzip decoder (checked against real axios 1.20, `lib/adapters
 * /http.js`); this library now does the same, for both `decompress` control
 * paths (buffered and `responseType: 'stream'`) and the streamed
 * `maxContentLength` check. Also covers plan.md phase 2 "delete
 * Content-Encoding from response.headers after a successful decode" for
 * the same encodings, on a real response (not a hand-built fixture). See
 * also the deterministic, in-process unit tests in `axios-response-type
 * .adapter.spec.ts` and `axios-response.adapter.spec.ts`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { firstValueFrom } from 'rxjs';
import { HttpModule, HttpService } from '../src';

describe('Content-Encoding: compress / x-compress decompression (real server)', () => {
  let server: Server;
  let baseUrl: string;
  let service: HttpService;
  const PAYLOAD = { hello: 'compress', n: 54321 };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const p = new URL(req.url!, 'http://x').searchParams;
      const encoding = p.get('enc') || 'compress';
      const n = Number(p.get('n') || 0);
      const raw = n
        ? Buffer.alloc(n, 'c')
        : Buffer.from(JSON.stringify(PAYLOAD));
      res.writeHead(200, {
        'Content-Type': n ? 'text/plain' : 'application/json',
        // axios' own decoder for `compress`/`x-compress` is really just
        // gzip under another name (checked against real axios 1.20) - the
        // server sends genuinely gzip-compressed bytes under that label,
        // exactly matching axios' own upstream conformance fixture.
        'Content-Encoding': encoding,
      });
      res.end(gzipSync(raw));
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

  it.each(['compress', 'x-compress', 'COMPRESS'])(
    'decompresses a %s JSON response transparently (buffered, default responseType)',
    async encoding => {
      const response = await firstValueFrom(
        service.request(`${baseUrl}?enc=${encoding}`),
      );
      expect(response.data).toEqual(PAYLOAD);
      // plan.md phase 2 "delete Content-Encoding ...": actually decoded, so
      // the header is removed, matching axios.
      expect(response.headers['content-encoding']).toBeUndefined();
    },
  );

  it('decompresses for responseType: "stream" too', async () => {
    const response = await firstValueFrom(
      service.request(`${baseUrl}?enc=x-compress`, { responseType: 'stream' }),
    );

    const chunks: Buffer[] = [];
    for await (const chunk of response.data as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(PAYLOAD);
  });

  it('decompress: false returns the raw (still-encoded) bytes, and leaves the header alone', async () => {
    const response = await firstValueFrom(
      service.request(`${baseUrl}?enc=compress`, {
        decompress: false,
        responseType: 'arraybuffer',
      }),
    );

    const raw = Buffer.from(JSON.stringify(PAYLOAD));
    expect(Buffer.compare(Buffer.from(response.data), raw)).not.toBe(0);
    expect(response.headers['content-encoding']).toBe('compress');
  });

  it('enforces maxContentLength against the DECOMPRESSED size for responseType: "stream"', async () => {
    const response = await firstValueFrom(
      service.request(`${baseUrl}?enc=compress&n=100000`, {
        maxContentLength: 1000,
        responseType: 'stream',
      }),
    );

    await expect(
      (async () => {
        for await (const _chunk of response.data as Readable) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE', isAxiosError: true });
  });

  it('the default Accept-Encoding request header advertises compress, matching axios’ own default', async () => {
    let seenAcceptEncoding: string | undefined;
    const echoServer = createServer((req, res) => {
      seenAcceptEncoding = req.headers['accept-encoding'] as string;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>(resolve =>
      echoServer.listen(0, '127.0.0.1', resolve),
    );
    try {
      const echoUrl = `http://127.0.0.1:${(echoServer.address() as AddressInfo).port}`;
      await firstValueFrom(service.request(echoUrl));
      expect(seenAcceptEncoding).toBe('gzip, compress, deflate, br');
    } finally {
      await new Promise<void>(resolve => echoServer.close(() => resolve()));
    }
  });
});
