/**
 * Real-server test for plan.md phase 2 "corrupt/truncated compressed body":
 * a server that claims a compressed `Content-Encoding` but sends bytes that
 * aren't that format at all used to surface the raw decode error
 * (`Z_DATA_ERROR` for zlib, differently-shaped codes for brotli/zstd - see
 * `isDecodeError`'s doc comment in `axios-response.adapter.ts`) unwrapped -
 * no `isAxiosError`/`config`/`request`. axios wraps it via
 * `AxiosError.from(err, null, config, lastRequest, response)`; this now
 * matches, for every codec this library decodes and for both buffered and
 * `responseType: 'stream'` (see `wrapStreamCancellation`'s doc comment in
 * `axios-response.adapter.ts`). PR #38 review (HIGH): an earlier version of
 * this gated the wrap on the error's `code` starting with `Z_`, which only
 * zlib (gzip/deflate) raises - brotli's own decode error code is
 * `ERR__ERROR_FORMAT_PADDING_1`, zstd's is `ZSTD_error_prefix_unknown`
 * (confirmed directly) - so brotli/zstd corruption silently went unwrapped.
 * Covered here for all three codecs.
 *
 * A body that's merely *truncated* mid-stream (a valid header, cut off
 * before the end) is a separate case, covered here too: axios' own
 * flush-tolerant zlib/brotli/zstd options (`finishFlush: Z_SYNC_FLUSH` etc.
 * - `GZIP_FLUSH_OPTIONS`/`BROTLI_FLUSH_OPTIONS`/`ZSTD_FLUSH_OPTIONS` in
 * `axios-response-type.adapter.ts`, checked against real axios 1.20's own
 * `zlibOptions`/`brotliOptions`/`zstdOptions`) mean this never throws at
 * all, resolving with whatever could be decoded from the partial bytes
 * instead - confirmed directly against each codec's own sync decompressor
 * with axios' flush options, and asserted here against that exact
 * reference (not just "some string came back" - PR #38 review, minor).
 * Without this, this library's *own* corrupt-body wrapping (above) would
 * have started wrapping this case as an AxiosError too, a regression from
 * axios' real behaviour caught by the axios upstream conformance suite's
 * "should not fail with an empty response (with|without) content-length
 * header (Z_BUF_ERROR)" (a degenerate, zero-byte case of exactly this).
 *
 * See also the deterministic, in-process unit tests in
 * `axios-response.adapter.spec.ts` and `axios-response-type.adapter.spec.ts`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  gzipSync,
  gunzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib';
import { firstValueFrom } from 'rxjs';
import { HttpModule, HttpService } from '../src';

/** axios' own flush options (see the file doc comment above), so the "truncated" assertions below compare against the exact same reference this library's own decoder now uses - not just "some non-empty string". */
const FLUSH_OPTIONS: Record<string, Record<string, unknown>> = {
  gzip: {
    finishFlush: zlibConstants.Z_SYNC_FLUSH,
  },
  br: {
    finishFlush: zlibConstants.BROTLI_OPERATION_FLUSH,
  },
  zstd: {
    finishFlush: (zlibConstants as any).ZSTD_e_flush,
  },
};

const DECOMPRESS: Record<string, (buf: Buffer, opts: any) => Buffer> = {
  gzip: gunzipSync,
  br: brotliDecompressSync,
  zstd: zstdDecompressSync,
};

const COMPRESS: Record<string, (buf: Buffer) => Buffer> = {
  gzip: gzipSync,
  br: brotliCompressSync,
  zstd: zstdCompressSync,
};

describe('corrupt/truncated compressed body (real server)', () => {
  let server: Server;
  let baseUrl: string;
  let service: HttpService;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const p = new URL(req.url!, 'http://x').searchParams;
      const kind = p.get('kind');
      const enc = p.get('enc') || 'gzip';
      res.writeHead(200, { 'Content-Encoding': enc });
      if (kind === 'garbage') {
        res.end(`this is definitely not ${enc} data, just plain text`);
      } else if (kind === 'truncated') {
        const full = COMPRESS[enc](Buffer.alloc(50_000, 'z'));
        res.end(full.subarray(0, full.length - 30));
      } else if (kind === 'empty') {
        res.end();
      } else {
        res.end('{}');
      }
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

  // Every Node version this package supports already has zstd (added in
  // 22.15.0/23.8.0, engines.node is >=22.17.0), matching the existing
  // `zstd-decompression.e2e.spec.ts`'s own convention of not feature-gating
  // at the e2e level.
  const CODECS = ['gzip', 'br', 'zstd'];

  it.each(CODECS)(
    'buffered (%s): genuinely-corrupt data rejects with a real AxiosError, not the raw decode error',
    async enc => {
      let caught: any;
      try {
        await firstValueFrom(
          service.request(`${baseUrl}?kind=garbage&enc=${enc}`),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeTruthy();
      expect(caught.isAxiosError).toBe(true);
      expect(caught.config).toBeTruthy();
      expect(typeof caught.code).toBe('string');
      expect(caught.request).toBeTruthy();
      // The real value-add here: axios attaches `response` (status/headers/
      // config/request) even for a buffered read that failed to decode -
      // `AxiosError.from(err, null, config, lastRequest, response)` in
      // `lib/adapters/http.js`'s `handleStreamError`. Before this fix, this
      // library's fallback error-shaping (`toAxiosError`'s generic branch)
      // already gave `isAxiosError`/`code`/`request`, but never `response`.
      expect(caught.response).toBeTruthy();
      expect(caught.response.status).toBe(200);
    },
  );

  it.each(CODECS)(
    'responseType: "stream" (%s): genuinely-corrupt data errors with a real AxiosError, not the raw decode error',
    async enc => {
      const response = await firstValueFrom(
        service.request(`${baseUrl}?kind=garbage&enc=${enc}`, {
          responseType: 'stream',
        }),
      );
      let caught: any;
      try {
        for await (const _chunk of response.data as Readable) {
          // drain
        }
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeTruthy();
      expect(caught.isAxiosError).toBe(true);
      expect(caught.config).toBeTruthy();
      expect(typeof caught.code).toBe('string');
    },
  );

  it.each(CODECS)(
    'buffered (%s): a body truncated mid-stream resolves with exactly the partial bytes axios’ own flush options would decode, not an error',
    async enc => {
      const response = await firstValueFrom(
        service.request(`${baseUrl}?kind=truncated&enc=${enc}`, {
          responseType: 'arraybuffer',
        }),
      );
      const full = COMPRESS[enc](Buffer.alloc(50_000, 'z'));
      const truncated = full.subarray(0, full.length - 30);
      const reference = DECOMPRESS[enc](truncated, FLUSH_OPTIONS[enc]);
      expect(Buffer.compare(Buffer.from(response.data), reference)).toBe(0);
    },
  );

  it.each(CODECS)(
    'responseType: "stream" (%s): a body truncated mid-stream resolves with exactly the partial bytes axios’ own flush options would decode, not an error',
    async enc => {
      const response = await firstValueFrom(
        service.request(`${baseUrl}?kind=truncated&enc=${enc}`, {
          responseType: 'stream',
        }),
      );
      const chunks: Buffer[] = [];
      for await (const chunk of response.data as Readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const full = COMPRESS[enc](Buffer.alloc(50_000, 'z'));
      const truncated = full.subarray(0, full.length - 30);
      const reference = DECOMPRESS[enc](truncated, FLUSH_OPTIONS[enc]);
      expect(Buffer.compare(Buffer.concat(chunks), reference)).toBe(0);
    },
  );

  it('an empty (zero-byte) gzip-encoded response resolves with an empty string, not Z_BUF_ERROR', async () => {
    const response = await firstValueFrom(
      service.request(`${baseUrl}?kind=empty`),
    );
    expect(response.data).toBe('');
  });
});
