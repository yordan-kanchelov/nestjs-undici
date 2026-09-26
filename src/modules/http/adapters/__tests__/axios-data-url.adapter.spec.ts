import {
  dataUrlString,
  estimateDataURLBufferAllocation,
  resolveDataUrlRequest,
} from '../axios-data-url.adapter';
import type { HttpInterceptorRequest } from '../../interfaces/http-interceptor.interface';

/**
 * plan.md phase 2 "fix: support data: URLs" (found by upstream conformance):
 * `HttpService.executeRequest`'s `unsupportedProtocol` check only allowed
 * `http:`/`https:`, so `axiosRef.get('data:...')` rejected. Real axios
 * decodes a `data:` URL entirely locally. These cases mirror axios' own
 * `tests/unit/adapters/http.test.js` "Data URL" block exactly (checked
 * against real axios 1.20).
 */

function fakeRequest(
  options: Record<string, any> = {},
): HttpInterceptorRequest {
  return { url: 'data:x', options: { method: 'GET', ...options } };
}

describe('dataUrlString', () => {
  it('recognizes a data: URL string case-insensitively', () => {
    expect(dataUrlString('data:text/plain,hi')).toBe('data:text/plain,hi');
    expect(dataUrlString('DATA:text/plain,hi')).toBe('DATA:text/plain,hi');
  });

  it('recognizes a data: URL instance', () => {
    const url = new URL('data:text/plain,hi');
    expect(dataUrlString(url)).toBe(url.toString());
  });

  it('returns undefined for a plain http(s) URL or a relative path', () => {
    expect(dataUrlString('http://example.com')).toBeUndefined();
    expect(dataUrlString('/relative/path')).toBeUndefined();
  });
});

describe('estimateDataURLBufferAllocation (axios estimateDataURLBufferAllocation port)', () => {
  it('allows a base64 payload exactly at the allocation limit', () => {
    // 'TQ==' decodes to the single byte 'M' - allocation estimate 1.
    expect(
      estimateDataURLBufferAllocation(
        'data:application/octet-stream;base64,TQ==',
      ),
    ).toBe(1);
  });

  it('estimates the raw-length allocation bound for percent-embedded base64, ignoring percent-decoding (matches Buffer.from(str, "base64")\'s own allocation, not the decoded size)', () => {
    const body = 'QQ' + '%41'.repeat(4000);
    const estimated = estimateDataURLBufferAllocation(
      `data:application/octet-stream;base64,${body}`,
    );
    expect(estimated).toBeGreaterThan(3000);
  });

  it('counts ignored input after base64 padding toward the allocation bound', () => {
    const estimated = estimateDataURLBufferAllocation(
      'data:application/octet-stream;base64,TQ==' + '%'.repeat(4096),
    );
    expect(estimated).toBeGreaterThan(1);
  });

  it('returns 0 for a non-data: URL or one with no comma', () => {
    expect(estimateDataURLBufferAllocation('http://x')).toBe(0);
    expect(estimateDataURLBufferAllocation('data:no-comma')).toBe(0);
  });
});

describe('resolveDataUrlRequest', () => {
  it('supports a data: URL as a Buffer by default', async () => {
    const buffer = Buffer.from('123');
    const dataURI = `data:application/octet-stream;base64,${buffer.toString('base64')}`;
    const response = await resolveDataUrlRequest(fakeRequest(), dataURI);
    expect(response.status).toBe(200);
    expect(Buffer.isBuffer(response.data)).toBe(true);
    expect((response.data as Buffer).equals(buffer)).toBe(true);
    expect(response.request).toBeUndefined();
  });

  it('supports responseType: text', async () => {
    const buffer = Buffer.from('123', 'utf-8');
    const dataURI = `data:application/octet-stream;base64,${buffer.toString('base64')}`;
    const response = await resolveDataUrlRequest(
      fakeRequest({ responseType: 'text' }),
      dataURI,
    );
    expect(response.data).toBe('123');
  });

  it('supports responseType: stream', async () => {
    const buffer = Buffer.from('123', 'utf-8');
    const dataURI = `data:application/octet-stream;base64,${buffer.toString('base64')}`;
    const response = await resolveDataUrlRequest(
      fakeRequest({ responseType: 'stream' }),
      dataURI,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of response.data as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString()).toBe('123');
  });

  it('supports responseType: blob when the platform Blob exists', async () => {
    const buffer = Buffer.from('123');
    const dataURI = `data:application/octet-stream;base64,${buffer.toString('base64')}`;
    const response = await resolveDataUrlRequest(
      fakeRequest({ responseType: 'blob' }),
      dataURI,
    );
    expect((response.data as Blob).type).toBe('application/octet-stream');
    await expect((response.data as Blob).text()).resolves.toBe('123');
  });

  it('allows a base64 data URL at the Buffer allocation limit', async () => {
    const response = await resolveDataUrlRequest(
      fakeRequest({ maxContentLength: 1 }),
      'data:application/octet-stream;base64,TQ==',
    );
    expect((response.data as Buffer).equals(Buffer.from('M'))).toBe(true);
  });

  it('rejects a percent-embedded base64 whose Buffer allocation exceeds the limit', async () => {
    const body = 'QQ' + '%41'.repeat(4000);
    await expect(
      resolveDataUrlRequest(
        fakeRequest({ maxContentLength: 3000 }),
        `data:application/octet-stream;base64,${body}`,
      ),
    ).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
      message: expect.stringContaining(
        'maxContentLength size of 3000 exceeded',
      ),
    });
  });

  it('rejects, counting ignored input after base64 padding toward the limit', async () => {
    await expect(
      resolveDataUrlRequest(
        fakeRequest({ maxContentLength: 1 }),
        'data:application/octet-stream;base64,TQ==' + '%'.repeat(4096),
      ),
    ).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
      message: expect.stringContaining('maxContentLength size of 1 exceeded'),
    });
  });

  it('a non-GET method resolves a synthetic 405, which then fails the default validateStatus (rejects with ERR_BAD_REQUEST) - matching axios settle()', async () => {
    await expect(
      resolveDataUrlRequest(
        fakeRequest({ method: 'POST' }),
        'data:text/plain,hi',
      ),
    ).rejects.toMatchObject({
      code: 'ERR_BAD_REQUEST',
      response: expect.objectContaining({ status: 405 }),
    });
  });

  it('a non-GET method resolves when validateStatus allows it', async () => {
    const response = await resolveDataUrlRequest(
      fakeRequest({ method: 'POST', validateStatus: () => true }),
      'data:text/plain,hi',
    );
    expect(response.status).toBe(405);
    expect(response.statusText).toBe('method not allowed');
  });

  it('rejects a malformed data: URL as ERR_BAD_REQUEST', async () => {
    await expect(
      resolveDataUrlRequest(fakeRequest(), 'data:'),
    ).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST' });
  });

  it('never sets response.request, matching axios (no real request object exists for a data: URL)', async () => {
    const response = await resolveDataUrlRequest(fakeRequest(), 'data:,hi');
    expect(response.request).toBeUndefined();
  });
});
