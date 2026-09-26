/**
 * Real-server test for zstd decompression (plan.md phase 2 "fix: zstd
 * decompression"): `Content-Encoding: zstd`, buffered and
 * `responseType: 'stream'`, honouring `decompress`/`maxContentLength` -
 * exactly like the existing gzip/br/deflate support. See also the
 * deterministic, in-process unit tests in `axios-response-type.adapter
 * .spec.ts` (including the mocked "unsupported Node build" fallback) and the
 * axios-vs-this-library differential cases in `tests/compat/differential/
 * response.diff.spec.ts`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import { firstValueFrom } from 'rxjs';
import { HttpModule, HttpService } from '../src';

describe('zstd decompression (real server)', () => {
  let server: Server;
  let baseUrl: string;
  let service: HttpService;
  const PAYLOAD = { hello: 'zstd', n: 12345 };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const p = new URL(req.url!, 'http://x').searchParams;
      const n = Number(p.get('n') || 0);
      const raw = n
        ? Buffer.alloc(n, 'z')
        : Buffer.from(JSON.stringify(PAYLOAD));
      const compressed = zstdCompressSync(raw);
      res.writeHead(200, {
        'Content-Type': n ? 'text/plain' : 'application/json',
        'Content-Encoding': 'zstd',
      });
      res.end(compressed);
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

  it('decompresses a zstd JSON response transparently (buffered, default responseType)', async () => {
    const response = await firstValueFrom(service.request(baseUrl));

    expect(response.data).toEqual(PAYLOAD);
    // plan.md phase 2 "delete Content-Encoding from response.headers after
    // a successful decode": zstd is actually decoded here, so the header is
    // removed, matching axios exactly (see `axios-response.adapter.ts`).
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('decompresses a zstd response for responseType: "stream"', async () => {
    const response = await firstValueFrom(
      service.request(baseUrl, { responseType: 'stream' }),
    );

    const chunks: Buffer[] = [];
    for await (const chunk of response.data as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(PAYLOAD);
  });

  it('decompress: false returns the raw (still zstd-encoded) bytes', async () => {
    const response = await firstValueFrom(
      service.request(baseUrl, {
        decompress: false,
        responseType: 'arraybuffer',
      }),
    );

    const raw = Buffer.from(JSON.stringify(PAYLOAD));
    expect(Buffer.compare(Buffer.from(response.data), raw)).not.toBe(0);
    // Round-tripping it back through zstd decompression recovers the
    // original - proving these are genuinely still-compressed bytes, not
    // just "different for some other reason".
    const { zstdDecompressSync } = await import('node:zlib');
    expect(
      zstdDecompressSync(Buffer.from(response.data)).toString('utf8'),
    ).toBe(JSON.stringify(PAYLOAD));
  });

  it('enforces maxContentLength against the DECOMPRESSED size (buffered)', async () => {
    await expect(
      firstValueFrom(
        service.request(`${baseUrl}?n=100000`, { maxContentLength: 1000 }),
      ),
    ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
  });

  it('enforces maxContentLength against the DECOMPRESSED size for responseType: "stream" too', async () => {
    const response = await firstValueFrom(
      service.request(`${baseUrl}?n=100000`, {
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
    ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
  });

  it("doesn't advertise zstd in the default Accept-Encoding request header", async () => {
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
