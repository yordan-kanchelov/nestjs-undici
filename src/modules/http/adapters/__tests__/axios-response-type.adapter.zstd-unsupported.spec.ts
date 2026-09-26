import { Readable } from 'node:stream';

/**
 * Simulates a Node build without zstd support in `zlib` (as every Node
 * before 22.15.0/23.8.0 is) by mocking `node:zlib` to omit
 * `createZstdDecompress`/`zstdDecompressSync` - `isZstdSupported`
 * (`axios-response-type.adapter.ts`) is computed once, at module load, from
 * exactly that check, so this file's own fresh, isolated module registry
 * (jest gives every test file its own) picks it up as `false` for every
 * import in this file, with no other test file affected.
 *
 * Verifies this library falls back exactly like axios itself does when
 * `isZstdSupported` is `false` (`lib/adapters/http.js`'s `switch` on
 * `content-encoding: zstd` is a no-op in that case): the raw, still-encoded
 * bytes pass through untouched, the same "unknown encoding" branch this
 * adapter already has for anything else it can't decode.
 */
jest.mock('node:zlib', () => {
  const real = jest.requireActual<typeof import('node:zlib')>('node:zlib');
  const { createZstdDecompress, zstdDecompressSync, ...rest } = real;
  return rest;
});

import {
  decompressBuffer,
  decompressStream,
  isZstdSupported,
  readBodyAsResponseType,
} from '../axios-response-type.adapter';

function bodyFromBuffer(buf: Buffer): any {
  const stream = Readable.from([buf]) as any;
  stream.arrayBuffer = async () =>
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  stream.text = async () => buf.toString('utf8');
  stream.bodyUsed = false;
  return stream;
}

describe('axios-response-type adapter: zstd feature-detect (mocked, unsupported)', () => {
  it('isZstdSupported is false under the mock', () => {
    expect(isZstdSupported).toBe(false);
  });

  it('decompressBuffer passes a zstd buffer through untouched', () => {
    const raw = Buffer.from('not actually decompressed');
    expect(decompressBuffer(raw, 'zstd')).toBe(raw);
  });

  it('decompressStream returns the same stream untouched (no decompressor wired up)', () => {
    const source = Readable.from([Buffer.from('x')]);
    expect(decompressStream(source, 'zstd')).toBe(source);
  });

  it('readBodyAsResponseType hands back the raw (still zstd-encoded) bytes, matching axios', async () => {
    const raw = Buffer.from('raw zstd frame bytes, not decoded');
    const body = bodyFromBuffer(raw);

    const result = await readBodyAsResponseType(
      body,
      'arraybuffer',
      undefined,
      { contentEncoding: 'zstd' },
    );

    expect(Buffer.compare(Buffer.from(result), raw)).toBe(0);
  });
});
