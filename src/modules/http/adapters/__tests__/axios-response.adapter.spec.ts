import { Readable } from 'node:stream';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import {
  joinDuplicateHeaders,
  RequestInfo,
  resolveIsValidStatus,
  toAxiosLikeResponse,
} from '../axios-response.adapter';
import type { HttpInterceptorRequest } from '../../interfaces/http-interceptor.interface';

/**
 * A fake `Dispatcher.ResponseData['body']` backed by a real, pipeable
 * `Readable` - enough for both the fast (`.arrayBuffer()`/`.text()`) and
 * streaming (`.pipe()`) decode paths, matching the equivalent helper in
 * `axios-response-type.adapter.spec.ts`.
 */
function bodyFromBuffer(buf: Buffer): any {
  const stream = Readable.from([buf]) as any;
  stream.arrayBuffer = async () =>
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  stream.text = async () => buf.toString('utf8');
  stream.bodyUsed = false;
  return stream;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Resolves once `stream` emits `'close'` (or immediately if it's already destroyed) - `destroy()` schedules `'close'` asynchronously, so a disposal assertion right after calling it needs to wait for this instead of racing it. */
function onceClosed(stream: {
  destroyed?: boolean;
  once(event: 'close', listener: () => void): unknown;
}): Promise<void> {
  return new Promise(resolve => {
    if (stream.destroyed) {
      resolve();
      return;
    }
    stream.once('close', () => resolve());
  });
}

/**
 * A `Readable` that pushes `chunks` one at a time, a tick apart, instead of
 * handing the whole payload to a `.pipe()` destination in one synchronous
 * go - `Readable.from([buffer])` (a single, already-fully-buffered chunk)
 * drains into a small `.pipe()` destination's internal buffer immediately
 * regardless of how slowly (or whether at all) anything downstream actually
 * reads it, so it reaches its own natural `'end'`/`'close'` on its own -
 * without ever exercising the destroy-*propagation* this file's disposal
 * tests are actually about. This instead stays genuinely open (like a real,
 * live socket under backpressure) until something explicitly destroys it.
 */
function slowReadable(chunks: Buffer[]): Readable {
  const stream = new Readable({ read() {} });
  let i = 0;
  const pushNext = (): void => {
    if (i >= chunks.length) {
      stream.push(null);
      return;
    }
    stream.push(chunks[i++]);
    setTimeout(pushNext, 10);
  };
  setTimeout(pushNext, 10);
  return stream;
}

/** Splits `buf` into `parts` roughly-equal pieces, for feeding `slowReadable` a payload across several slow chunks instead of one. */
function splitBuffer(buf: Buffer, parts: number): Buffer[] {
  const size = Math.ceil(buf.length / parts);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buf.length; offset += size) {
    chunks.push(buf.subarray(offset, offset + size));
  }
  return chunks;
}

describe('RequestInfo (perf: response.request / error.request built lazily)', () => {
  it('parses nothing in the constructor; a field is parsed only on first read, and cached after', () => {
    const OriginalURL = globalThis.URL;
    let parseCount = 0;
    class CountingURL extends OriginalURL {
      constructor(input: string | URL, base?: string | URL) {
        super(input as any, base as any);
        parseCount++;
      }
    }
    (globalThis as any).URL = CountingURL;
    try {
      const info = new RequestInfo('http://api.example.com/x?y=1', 'GET');
      expect(parseCount).toBe(0);

      expect(info.path).toBe('/x?y=1');
      expect(parseCount).toBe(1);

      // Further reads (any of the parsed fields) don't parse again.
      expect(info.host).toBe('api.example.com');
      expect(info.protocol).toBe('http:');
      expect(info.path).toBe('/x?y=1');
      expect(parseCount).toBe(1);
    } finally {
      (globalThis as any).URL = OriginalURL;
    }
  });

  it('method is read directly, with no parsing at all', () => {
    const info = new RequestInfo('not a url at all', 'POST');
    expect(info.method).toBe('POST');
    // An unparsable string leaves path/host/protocol undefined, matching
    // axios for a request that never got far enough to resolve one -
    // doesn't throw either.
    expect(info.path).toBeUndefined();
    expect(info.host).toBeUndefined();
    expect(info.protocol).toBeUndefined();
  });

  it('accepts a URL instance directly (no re-parsing needed/possible)', () => {
    const info = new RequestInfo(
      new URL('https://api.example.com:8443/a/b?c=1'),
      'GET',
    );
    expect(info.protocol).toBe('https:');
    expect(info.host).toBe('api.example.com');
    expect(info.path).toBe('/a/b?c=1');
  });

  it('accepts a UrlObject (pathname/search/protocol/hostname own fields)', () => {
    const info = new RequestInfo(
      { protocol: 'http:', hostname: 'x', pathname: '/p', search: '?s=1' },
      'GET',
    );
    expect(info.protocol).toBe('http:');
    expect(info.host).toBe('x');
    expect(info.path).toBe('/p?s=1');
  });

  it('res is undefined when no responseUrl source was given (e.g. a network/timeout error)', () => {
    const info = new RequestInfo('http://api/x', 'GET');
    expect(info.res).toBeUndefined();
  });

  it('res.responseUrl is computed from the responseUrl source, and cached (same reference) across reads', () => {
    const info = new RequestInfo('http://api/x', 'GET', 'http://api/final');
    const first = info.res;
    expect(first).toEqual({ responseUrl: 'http://api/final' });
    const second = info.res;
    // Same object reference both times - proves the result is memoized,
    // not recomputed (and re-allocated) on every read.
    expect(second).toBe(first);
  });

  it('res.responseUrl is built from the responseUrl source via urlToString, even for a non-string (URL/UrlObject) hop', () => {
    const info = new RequestInfo(
      'http://api/x',
      'GET',
      new URL('http://api/final?x=1'),
    );
    expect(info.res).toEqual({ responseUrl: 'http://api/final?x=1' });
  });
});

/**
 * Review fix (PR #30): a metered download (`onDownloadProgress`/download
 * `maxRate` set) silently succeeded with an empty body on a real stream
 * error (an abort, the source being destroyed, or - before the
 * `asyncDecorator` fix - a throwing `onDownloadProgress` callback itself),
 * instead of rejecting. `toAxiosLikeResponse`'s corrupt-gzip recovery
 * fallback (a second raw-text read) was never meant for a metered stream (a
 * plain `Transform`, not undici's own body - no `.bodyUsed`/`.text()`), and
 * silently swallowed every one of those into `parsedData = ''`.
 */
describe('toAxiosLikeResponse: metered body error propagation', () => {
  const fakeRequest = (
    options: Record<string, any>,
  ): HttpInterceptorRequest => ({
    url: 'http://localhost/test',
    options: { method: 'GET', ...options },
  });

  it('a source stream error while metered (onDownloadProgress) rejects, instead of falling back to an empty string', async () => {
    const source = new Readable({ read() {} });
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: source,
    };
    const promise = toAxiosLikeResponse(
      fakeRequest({ onDownloadProgress: () => undefined }),
      undiciResponse,
    );
    source.push(Buffer.from('{"partial":'));
    source.emit('error', new Error('socket hang up'));
    await expect(promise).rejects.toThrow('socket hang up');
  });

  it('a destroyed/aborted source stream while metered (maxRate) rejects, instead of resolving with an empty body', async () => {
    const source = new Readable({ read() {} });
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/octet-stream' },
      body: source,
    };
    const promise = toAxiosLikeResponse(
      fakeRequest({ maxRate: 1_000_000 }),
      undiciResponse,
    );
    source.destroy(new Error('aborted'));
    await expect(promise).rejects.toThrow('aborted');
  });

  it('a throwing onDownloadProgress callback is decoupled via process.nextTick, so it can never corrupt the response - matching real axios 1.20 (verified manually against it: the response resolves with the full, correct body, and the throw surfaces as a separate uncaughtException, entirely outside the response pipeline)', async () => {
    const payload = { hello: 'world', big: 'x'.repeat(500) };
    const bodyBuf = Buffer.from(JSON.stringify(payload));
    const source = Readable.from([bodyBuf]);
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        'content-length': String(bodyBuf.length),
      },
      body: source,
    };

    // Intercepts the real `process.nextTick` so the deferred callback can be
    // invoked - and its throw safely caught - directly by this test, instead
    // of letting it actually escape as a real, process-wide uncaught
    // exception (which jest-circus attributes to whatever test happens to
    // still be running, regardless of any `process.on('uncaughtException')`
    // handler of the test's own - not a meaningful thing to assert on here).
    const scheduled: Array<() => void> = [];
    const realNextTick = process.nextTick;
    (process as any).nextTick = (cb: () => void) => scheduled.push(cb);
    try {
      const response = await toAxiosLikeResponse(
        fakeRequest({
          onDownloadProgress: () => {
            throw new Error('user callback boom');
          },
        }),
        undiciResponse,
      );
      // The response already resolved, fully intact, without the deferred
      // callback ever having run - proving it can't have any effect on it.
      expect(response.data).toEqual(payload);
      expect(scheduled.length).toBeGreaterThan(0);
      // Running the deferred callback now (as the real event loop would)
      // does throw, with the exact error the user's callback raised -
      // exactly what becomes an uncaught exception in a real process.
      expect(() => scheduled.forEach(fn => fn())).toThrow('user callback boom');
    } finally {
      process.nextTick = realNextTick;
    }
  });
});

/**
 * plan.md phase 2 "fix: enforce maxContentLength for responseType: 'stream'"
 * (found by upstream conformance): the stream branch used to return the
 * body untouched, so a streamed download had no cap at all despite
 * `maxContentLength` - checked against real axios 1.20 (`lib/adapters/
 * http.js`'s own streamed enforcement, `Readable.from(enforceMaxContent
 * Length(), ...)`).
 */
describe('toAxiosLikeResponse: maxContentLength for responseType: stream', () => {
  const fakeRequest = (
    options: Record<string, any>,
  ): HttpInterceptorRequest => ({
    url: 'http://localhost/test',
    options: { method: 'GET', responseType: 'stream', ...options },
  });

  it('a stream under the limit reads through untouched', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: Readable.from([Buffer.from('hello')]),
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ maxContentLength: 1000 }),
      undiciResponse,
    );
    await expect(readAll(response.data)).resolves.toEqual(Buffer.from('hello'));
  });

  it('a stream over the limit destroys with a real AxiosError (ERR_BAD_RESPONSE), matching axios exactly', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: Readable.from([Buffer.alloc(10, 'x'), Buffer.alloc(10, 'y')]),
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ maxContentLength: 15 }),
      undiciResponse,
    );
    const error: any = await readAll(response.data).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.isAxiosError).toBe(true);
    expect(error.code).toBe('ERR_BAD_RESPONSE');
    expect(error.message).toBe('maxContentLength size of 15 exceeded');
    // `config`/`request` are set eagerly on this error (unlike the buffered
    // case's `AxiosError`, which builds `config` lazily on read) - matches
    // axios' own streamed enforcement, which already has both in scope.
    expect(error.config).toBeDefined();
  });

  it('enforces the limit against the DECODED (decompressed) byte count, not the compressed one on the wire', async () => {
    const decoded = Buffer.alloc(1000, 'z');
    const compressed = gzipSync(decoded);
    // The compressed payload is well under the limit; only the decoded
    // (much larger) payload should trip it.
    expect(compressed.length).toBeLessThan(200);
    // Fed as several slow chunks (not one `Readable.from([compressed])`
    // buffer) so `body` is still genuinely open - mid-stream, not yet at its
    // own natural `'end'` - at the moment the limit trips; that's the only
    // way this test can tell an explicit `body.destroy()` apart from the
    // stream just finishing on its own, which is what let this bug slip
    // through the PR's original (single-chunk) version of this test.
    const body = slowReadable(splitBuffer(compressed, 4));
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'gzip' },
      body,
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ maxContentLength: 200 }),
      undiciResponse,
    );
    const error: any = await readAll(response.data).catch(e => e);
    expect(error?.code).toBe('ERR_BAD_RESPONSE');
    expect(error?.message).toBe('maxContentLength size of 200 exceeded');
    // Review fix: `guardStreamMaxContentLength` used to destroy only the
    // decompressed (`.pipe()`-derived) stream, never the raw undici body
    // behind it - `.pipe()` never propagates destruction upstream, so the
    // raw body/socket stayed open under backpressure. It must be destroyed
    // too, or a real server connection would leak.
    await onceClosed(body);
    expect(body.destroyed).toBe(true);
  });

  it('unset/-1 maxContentLength never wraps the stream at all (same object identity as the raw body)', async () => {
    const body = Readable.from([Buffer.from('x')]);
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body,
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ maxContentLength: -1 }),
      undiciResponse,
    );
    expect(response.data).toBe(body);
  });

  it('an uncompressed stream over the limit destroys the raw body too (the already-working case, kept as a regression guard)', async () => {
    const body = Readable.from([Buffer.alloc(10, 'x'), Buffer.alloc(10, 'y')]);
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body,
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ maxContentLength: 15 }),
      undiciResponse,
    );
    await readAll(response.data).catch(() => undefined);
    await onceClosed(body);
    expect(body.destroyed).toBe(true);
  });

  /**
   * Review fix, same root cause, pre-existing on `claude/v1.0.0` before this
   * PR ever touched this file: a `responseType: 'stream'` consumer that
   * stops reading a *compressed* response early (no `maxContentLength`
   * involved at all) destroys the decompressed stream it was handed, but
   * the raw undici body/socket behind it never got destroyed either -
   * `decompressStream` (`axios-response-type.adapter.ts`) now wires that up
   * directly, so every consumer of a compressed `responseType: 'stream'`
   * response benefits, not just the `maxContentLength` path above.
   */
  it('a consumer destroying a compressed stream early also destroys the raw body', async () => {
    // Slow chunks again (see the limit-crossed test above): otherwise the
    // single already-buffered chunk drains into gunzip and `body` reaches
    // its own natural `'end'`/`'close'` before `.destroy()` below even runs,
    // so the assertion would pass whether or not destroy-propagation works.
    const body = slowReadable(
      splitBuffer(gzipSync(Buffer.alloc(1000, 'z')), 4),
    );
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'gzip' },
      body,
    };
    const response = await toAxiosLikeResponse(fakeRequest({}), undiciResponse);
    // A consumer that stops reading early - explicitly, not via a for-await
    // `break` (which would already trigger the async iterator's own
    // `return()`/`destroy()`, muddying which mechanism is under test here).
    (response.data as any).destroy();
    await onceClosed(body);
    expect(body.destroyed).toBe(true);
  });

  it('a consumer destroying an uncompressed stream early also destroys the raw body (the already-working case, kept as a regression guard)', async () => {
    const body = Readable.from([Buffer.alloc(1000, 'z')]);
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body,
    };
    const response = await toAxiosLikeResponse(fakeRequest({}), undiciResponse);
    (response.data as any).destroy();
    await onceClosed(body);
    expect(body.destroyed).toBe(true);
  });
});

describe('resolveIsValidStatus', () => {
  it('defaults to the 2xx range with no validateStatus at all', () => {
    expect(resolveIsValidStatus(undefined, 200)).toBe(true);
    expect(resolveIsValidStatus({}, 404)).toBe(false);
  });

  it('a function validateStatus decides outright', () => {
    expect(resolveIsValidStatus({ validateStatus: () => true }, 500)).toBe(
      true,
    );
    expect(resolveIsValidStatus({ validateStatus: () => false }, 200)).toBe(
      false,
    );
  });

  it('validateStatus present as an own key (even null/undefined) always resolves, matching axios settle()', () => {
    expect(resolveIsValidStatus({ validateStatus: null }, 500)).toBe(true);
    expect(resolveIsValidStatus({ validateStatus: undefined }, 500)).toBe(true);
  });
});

/**
 * plan.md phase 2 "fix: join duplicate response headers like axios/Node".
 * undici's own header parser accumulates every repeated header name into an
 * array uniformly; Node's `IncomingMessage.headers` getter - and so axios,
 * which runs on it - applies a per-name rule instead (ported from
 * `_http_incoming.js`'s `matchKnownFields`/`_addHeaderLine`). Each case here
 * would fail without `joinDuplicateHeaders`: the pre-fix code just handed
 * `undiciResponse.headers` through untouched.
 */
describe('joinDuplicateHeaders (plan.md phase 2: join duplicate response headers like axios/Node)', () => {
  it('returns the same object reference when nothing is duplicated (no allocation on the common path)', () => {
    const headers = { 'content-type': 'application/json', 'x-req-id': 'abc' };
    expect(joinDuplicateHeaders(headers)).toBe(headers);
  });

  it('joins a duplicated generic header with ", "', () => {
    expect(joinDuplicateHeaders({ 'x-foo': ['one', 'two'] })).toEqual({
      'x-foo': 'one, two',
    });
  });

  it('joins a duplicated, Node-known "comma" header (e.g. accept-encoding) with ", " too', () => {
    expect(joinDuplicateHeaders({ 'accept-encoding': ['gzip', 'br'] })).toEqual(
      { 'accept-encoding': 'gzip, br' },
    );
  });

  it('keeps only the first value of a "no duplicates" header and drops the rest', () => {
    expect(
      joinDuplicateHeaders({
        'content-type': ['text/plain', 'text/html'],
      }),
    ).toEqual({ 'content-type': 'text/plain' });
    for (const name of [
      'age',
      'authorization',
      'content-length',
      'etag',
      'expires',
      'from',
      'host',
      'if-modified-since',
      'if-unmodified-since',
      'last-modified',
      'location',
      'max-forwards',
      'proxy-authorization',
      'referer',
      'retry-after',
      'server',
      'user-agent',
    ]) {
      expect(joinDuplicateHeaders({ [name]: ['first', 'second'] })).toEqual({
        [name]: 'first',
      });
    }
  });

  it('always keeps set-cookie as an array, never joining it', () => {
    const headers = { 'set-cookie': ['a=1', 'b=2'] };
    expect(joinDuplicateHeaders(headers)).toEqual({
      'set-cookie': ['a=1', 'b=2'],
    });
  });

  it('joins a duplicated cookie header with "; " (not ", ")', () => {
    expect(joinDuplicateHeaders({ cookie: ['a=1', 'b=2'] })).toEqual({
      cookie: 'a=1; b=2',
    });
  });

  it('leaves every other header untouched alongside a duplicated one', () => {
    expect(
      joinDuplicateHeaders({
        'x-foo': ['one', 'two'],
        date: 'Mon, 01 Jan 2024 00:00:00 GMT',
        'content-length': '2',
      }),
    ).toEqual({
      'x-foo': 'one, two',
      date: 'Mon, 01 Jan 2024 00:00:00 GMT',
      'content-length': '2',
    });
  });
});

describe('toAxiosLikeResponse: duplicate response headers (plan.md phase 2: join duplicate response headers like axios/Node)', () => {
  const fakeRequest = (
    options: Record<string, any> = {},
  ): HttpInterceptorRequest => ({
    url: 'http://localhost/test',
    options: { method: 'GET', ...options },
  });

  it("exposes duplicate headers on response.headers the way axios/Node would, not undici's raw arrays", async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {
        'x-foo': ['one', 'two'],
        'content-type': ['text/plain', 'text/html'],
        'set-cookie': ['a=1', 'b=2'],
        cookie: ['c=1', 'd=2'],
      },
      body: Readable.from([Buffer.from('ok')]),
    };
    const response = await toAxiosLikeResponse(fakeRequest(), undiciResponse);
    expect(response.headers['x-foo']).toBe('one, two');
    expect(response.headers['content-type']).toBe('text/plain');
    expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(response.headers['cookie']).toBe('c=1; d=2');
  });

  it('parses the body using the singleton content-type, not the raw duplicated array (would otherwise crash: array has no .trim())', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-type': ['application/json', 'text/html'] },
      body: Readable.from([Buffer.from('{"ok":true}')]),
    };
    const response = await toAxiosLikeResponse(fakeRequest(), undiciResponse);
    expect(response.data).toEqual({ ok: true });
  });
});

/**
 * plan.md phase 2 "delete Content-Encoding from response.headers after a
 * successful decode". Matches axios exactly (`lib/adapters/http.js`, checked
 * against real axios 1.20): deleted only when `decompress !== false` and the
 * header is present, then either unconditionally (`HEAD`/`204`, regardless
 * of the encoding) or when the encoding is one this library actually
 * decodes (`isDecodableEncoding`) - never for `decompress: false`, and never
 * for an encoding it doesn't recognize at all. `content-length` is left
 * untouched either way (axios doesn't touch it on decode).
 */
describe('toAxiosLikeResponse: delete Content-Encoding after a successful decode', () => {
  const fakeRequest = (
    options: Record<string, any> = {},
  ): HttpInterceptorRequest => ({
    url: 'http://localhost/test',
    options: { method: 'GET', ...options },
  });

  it('deletes content-encoding after decoding gzip', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {
        'content-encoding': 'gzip',
        'content-length': '13',
        'content-type': 'application/json',
      },
      body: bodyFromBuffer(gzipSync(Buffer.from('{"a":1}'))),
    };
    const response = await toAxiosLikeResponse(fakeRequest(), undiciResponse);
    expect(response.data).toEqual({ a: 1 });
    expect(response.headers['content-encoding']).toBeUndefined();
    // axios never touches content-length on decode - the (now-inaccurate,
    // compressed-size) value is left exactly as the server sent it.
    expect(response.headers['content-length']).toBe('13');
  });

  it.each([
    ['gzip', gzipSync],
    ['x-gzip', gzipSync],
    ['compress', gzipSync],
    ['x-compress', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const)(
    'deletes content-encoding after decoding %s',
    async (encoding, compress) => {
      const undiciResponse: any = {
        statusCode: 200,
        statusText: 'OK',
        headers: { 'content-encoding': encoding },
        body: bodyFromBuffer(compress(Buffer.from('ok'))),
      };
      const response = await toAxiosLikeResponse(
        fakeRequest({ responseType: 'arraybuffer' }),
        undiciResponse,
      );
      expect(response.headers['content-encoding']).toBeUndefined();
    },
  );

  it('does NOT delete content-encoding when decompress: false, since nothing was actually decoded', async () => {
    const compressed = gzipSync(Buffer.from('ok'));
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'gzip' },
      body: bodyFromBuffer(compressed),
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ decompress: false, responseType: 'arraybuffer' }),
      undiciResponse,
    );
    expect(response.headers['content-encoding']).toBe('gzip');
  });

  it('does NOT delete content-encoding for an encoding it doesn’t recognize', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'identity' },
      body: bodyFromBuffer(Buffer.from('ok')),
    };
    const response = await toAxiosLikeResponse(fakeRequest(), undiciResponse);
    expect(response.headers['content-encoding']).toBe('identity');
  });

  it('deletes a stale content-encoding on a HEAD response, regardless of the encoding named', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'identity' },
      body: undefined,
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ method: 'HEAD' }),
      undiciResponse,
    );
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('deletes a stale content-encoding on a 204, regardless of the encoding named', async () => {
    const undiciResponse: any = {
      statusCode: 204,
      statusText: 'No Content',
      headers: { 'content-encoding': 'identity' },
      body: undefined,
    };
    const response = await toAxiosLikeResponse(fakeRequest(), undiciResponse);
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('leaves content-encoding untouched when the header was never present at all', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: Readable.from([Buffer.from('ok')]),
    };
    const response = await toAxiosLikeResponse(fakeRequest(), undiciResponse);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(
        response.headers,
        'content-encoding',
      ),
    ).toBe(false);
  });
});

/**
 * plan.md phase 2 "corrupt/truncated compressed body": matches axios exactly
 * (`AxiosError.from(err, null, config, lastRequest, response)`, checked
 * against real axios 1.20's `lib/adapters/http.js`'s buffered
 * `handleStreamError`, extended here to the stream path too - see
 * `wrapStreamCancellation`'s doc comment in `axios-response.adapter.ts`):
 * `isAxiosError`/`config`/`request` are all populated, and `code` falls
 * back to the raw zlib error code (e.g. `'Z_BUF_ERROR'`) since axios itself
 * never overrides it for this case.
 */
describe('toAxiosLikeResponse: corrupt/truncated compressed body wraps as an AxiosError', () => {
  const fakeRequest = (
    options: Record<string, any> = {},
  ): HttpInterceptorRequest => ({
    url: 'http://localhost/test',
    options: { method: 'GET', ...options },
  });

  it('buffered: a corrupt gzip body rejects with a real AxiosError, not the raw zlib error', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {
        'content-encoding': 'gzip',
        'content-type': 'application/json',
      },
      body: bodyFromBuffer(Buffer.from('this is not gzip at all')),
    };
    let caught: any;
    try {
      await toAxiosLikeResponse(fakeRequest(), undiciResponse);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeTruthy();
    // Matches axios exactly: `AxiosError.from` unconditionally overwrites
    // `.name` with the wrapped error's own `.name` (a zlib error is a plain
    // `Error`, so this stays `'Error'`, not `'AxiosError'` - checked against
    // real axios 1.20's `lib/core/AxiosError.js`).
    expect(caught.isAxiosError).toBe(true);
    expect(caught.name).toBe('Error');
    expect(typeof caught.code).toBe('string');
    expect(caught.code).not.toBe('ERR_BAD_RESPONSE');
    expect(caught.config).toBeTruthy();
    // Matches axios: `response` (status/statusText/headers/config/request)
    // is attached even though `.data` never got assigned before the
    // buffered read's own 'error' fired.
    expect(caught.response).toBeTruthy();
    expect(caught.response.status).toBe(200);
    expect(caught.response.data).toBeUndefined();
  });

  // A body truncated mid-stream does NOT reject: matches axios' own
  // flush-tolerant zlib options (`finishFlush: Z_SYNC_FLUSH` etc. -
  // `GZIP_FLUSH_OPTIONS` in `axios-response-type.adapter.ts`, checked
  // against real axios 1.20's own `zlibOptions`). It resolves with whatever
  // could be decoded from the partial bytes instead, never throwing for a
  // merely-incomplete (as opposed to structurally invalid) stream -
  // confirmed directly: `gunzipSync` with axios' own flush options never
  // throws for a truncated-but-header-valid gzip buffer, only for one that
  // fails the format check entirely (the "garbage" tests above).
  it('buffered: a body truncated mid-stream does not reject, unlike genuinely corrupt data', async () => {
    const full = gzipSync(Buffer.alloc(10_000, 'z'));
    const truncated = full.subarray(0, full.length - 20);
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'gzip' },
      body: bodyFromBuffer(truncated),
    };
    // Doesn't throw - resolves normally (with less data than the full
    // 10,000 bytes would have decoded to).
    const response = await toAxiosLikeResponse(fakeRequest(), undiciResponse);
    expect(response.status).toBe(200);
    expect(typeof response.data).toBe('string');
  });

  it('stream: a corrupt gzip body destroys the returned stream with a real AxiosError, not the raw zlib error', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'gzip' },
      body: Readable.from([Buffer.from('this is not gzip at all')]),
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ responseType: 'stream' }),
      undiciResponse,
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
    expect(caught.name).toBe('Error');
    expect(caught.config).toBeTruthy();
  });

  /**
   * PR #38 review (HIGH): brotli and zstd decode failures weren't wrapped
   * at all - the old gate sniffed `error.code` for a `Z_`-prefix, which
   * only zlib (gzip/deflate) raises; brotli's own decode error code is
   * `ERR__ERROR_FORMAT_PADDING_1`, zstd's is `ZSTD_error_prefix_unknown`
   * (confirmed directly, `brotliDecompressSync`/`zstdDecompressSync`
   * against the same garbage bytes as the gzip case above) - neither
   * matched. Fixed by tagging the error at its actual origin
   * (`DECODE_ERROR`, `decompressBuffer`/`decompressStream`) instead of
   * sniffing its shape - these tests cover every codec uniformly.
   */
  it('buffered: a corrupt brotli body rejects with a real AxiosError, not the raw brotli error', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'br' },
      body: bodyFromBuffer(Buffer.from('this is not brotli at all')),
    };
    let caught: any;
    try {
      await toAxiosLikeResponse(fakeRequest(), undiciResponse);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeTruthy();
    expect(caught.isAxiosError).toBe(true);
    expect(typeof caught.code).toBe('string');
    expect(caught.config).toBeTruthy();
    expect(caught.response).toBeTruthy();
    expect(caught.response.status).toBe(200);
  });

  it('stream: a corrupt brotli body destroys the returned stream with a real AxiosError, not the raw brotli error', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'br' },
      body: Readable.from([Buffer.from('this is not brotli at all')]),
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ responseType: 'stream' }),
      undiciResponse,
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
  });

  // Every Node version this package supports already has zstd (added in
  // 22.15.0/23.8.0, `engines.node` is >=22.17.0 - `isZstdSupported` is
  // always `true` here), so these run unconditionally, matching the rest
  // of this describe block's other codec cases.
  it('buffered: a corrupt zstd body rejects with a real AxiosError, not the raw zstd error', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'zstd' },
      body: bodyFromBuffer(Buffer.from('this is not zstd at all')),
    };
    let caught: any;
    try {
      await toAxiosLikeResponse(fakeRequest(), undiciResponse);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeTruthy();
    expect(caught.isAxiosError).toBe(true);
    expect(typeof caught.code).toBe('string');
    expect(caught.config).toBeTruthy();
    expect(caught.response).toBeTruthy();
    expect(caught.response.status).toBe(200);
  });

  it('stream: a corrupt zstd body destroys the returned stream with a real AxiosError, not the raw zstd error', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'zstd' },
      body: Readable.from([Buffer.from('this is not zstd at all')]),
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ responseType: 'stream' }),
      undiciResponse,
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
  });

  it('a genuine network error (UND_ERR_SOCKET) while decompression is configured is NOT wrapped as a decode error - it still reaches the caller raw', async () => {
    // `decompressStream`'s decompressor 'error' fires for two different
    // reasons - see its own doc comment (`bodyErroredFirst`) - this pins
    // the case that must NOT be tagged `DECODE_ERROR`: `body` (the raw
    // undici stream) erroring first, forwarded to the decompressor purely
    // so it gets cleaned up too, is a network failure, not a decode one.
    const body = new Readable({ read() {} });
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'gzip' },
      body,
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ responseType: 'stream' }),
      undiciResponse,
    );
    const socketError = Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
    });
    let caught: any;
    const drained = (async () => {
      try {
        for await (const _chunk of response.data as Readable) {
          // drain
        }
      } catch (error) {
        caught = error;
      }
    })();
    // `.destroy(err)`, not a bare `.emit('error', ...)`: a real undici body
    // errors via destroy, which also marks it `destroyed`.
    body.destroy(socketError);
    await drained;
    // Passed straight through: no `isAxiosError`/`.config` attached by the
    // corrupt-body path (this library's own `fail()`/`toAxiosError`, for a
    // real request that never got this far, is what remaps
    // UND_ERR_SOCKET -> ECONNRESET before the response is ever handed
    // back - out of scope for this direct `toAxiosLikeResponse` unit test,
    // which only pins that the *stream*-side wrap doesn't misfire here).
    expect(caught).toBe(socketError);
    expect(caught.isAxiosError).toBeUndefined();
  });

  it('an already-AxiosError (e.g. a maxContentLength guard failure) is never double-wrapped', async () => {
    const raw = Buffer.alloc(1_000, 'z');
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-encoding': 'gzip' },
      body: Readable.from([gzipSync(raw)]),
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ responseType: 'stream', maxContentLength: 10 }),
      undiciResponse,
    );
    let caught: any;
    try {
      for await (const _chunk of response.data as Readable) {
        // drain
      }
    } catch (error) {
      caught = error;
    }
    expect(caught?.code).toBe('ERR_BAD_RESPONSE');
    expect(caught?.message).toBe('maxContentLength size of 10 exceeded');
  });
});

/**
 * plan.md phase 2 "transitional.silentJSONParsing": matches axios' exact
 * condition (`strictJSONParsing = !silentJSONParsing && JSONRequested`,
 * `JSONRequested` requires `responseType: 'json'`) end to end through
 * `toAxiosLikeResponse`. The default (silent) behaviour must be completely
 * unaffected.
 */
describe('toAxiosLikeResponse: transitional.silentJSONParsing', () => {
  const fakeRequest = (
    options: Record<string, any> = {},
  ): HttpInterceptorRequest => ({
    url: 'http://localhost/test',
    options: { method: 'GET', responseType: 'json', ...options },
  });

  it('silentJSONParsing: false + responseType: json rejects invalid JSON with a real AxiosError, response.data the raw text', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: Readable.from([Buffer.from('not json{')]),
    };
    let caught: any;
    try {
      await toAxiosLikeResponse(
        fakeRequest({ transitional: { silentJSONParsing: false } }),
        undiciResponse,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeTruthy();
    expect(caught.isAxiosError).toBe(true);
    expect(caught.code).toBe('ERR_BAD_RESPONSE');
    expect(caught.config).toBeTruthy();
    expect(caught.response).toBeTruthy();
    expect(caught.response.data).toBe('not json{');
    expect(caught.response.status).toBe(200);
  });

  it('silentJSONParsing left at its default (true) stays silent - returns the raw text instead of throwing', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: Readable.from([Buffer.from('not json{')]),
    };
    const response = await toAxiosLikeResponse(fakeRequest(), undiciResponse);
    expect(response.data).toBe('not json{');
  });

  it('silentJSONParsing: false has no effect without responseType: "json" (matches axios: JSONRequested requires it)', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: Readable.from([Buffer.from('not json{')]),
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({
        responseType: 'text',
        transitional: { silentJSONParsing: false },
      }),
      undiciResponse,
    );
    expect(response.data).toBe('not json{');
  });

  it('valid JSON is unaffected by silentJSONParsing: false', async () => {
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: Readable.from([Buffer.from('{"a":1}')]),
    };
    const response = await toAxiosLikeResponse(
      fakeRequest({ transitional: { silentJSONParsing: false } }),
      undiciResponse,
    );
    expect(response.data).toEqual({ a: 1 });
  });
});

/**
 * plan.md phase 2 "cancel a responseType: 'stream' response when its
 * request stream is destroyed" / "abort a responseType: 'stream' response
 * when the caller's AbortSignal fires after emission". See
 * `wrapStreamCancellation`'s doc comment (`axios-response.adapter.ts`):
 * both triggers ultimately deliver undici's own abort-shaped error
 * (`code: 'UND_ERR_ABORTED'`/`name: 'AbortError'`) to the already-returned
 * stream, which must surface as a real `CanceledError`/`ERR_CANCELED`.
 */
describe('toAxiosLikeResponse: responseType stream cancellation (request-stream-destroy / AbortSignal-after-emission)', () => {
  const abortedError = (): any =>
    Object.assign(new Error('Request aborted'), {
      name: 'AbortError',
      code: 'UND_ERR_ABORTED',
    });

  it('a streamed upload body (options.body) triggers the wrap: an abort-shaped error becomes a CanceledError', async () => {
    const uploadBody = new Readable({ read() {} });
    const source = new Readable({ read() {} });
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: source,
    };
    const request: HttpInterceptorRequest = {
      url: 'http://localhost/test',
      options: { method: 'POST', responseType: 'stream', body: uploadBody },
    };
    const response = await toAxiosLikeResponse(request, undiciResponse);

    let caught: any;
    const drain = (async () => {
      try {
        for await (const _chunk of response.data as Readable) {
          // drain
        }
      } catch (error) {
        caught = error;
      }
    })();
    source.emit('error', abortedError());
    await drain;

    expect(caught).toBeTruthy();
    expect(caught.isAxiosError).toBe(true);
    expect(caught.name).toBe('CanceledError');
    expect(caught.code).toBe('ERR_CANCELED');
    expect(caught.__CANCEL__).toBe(true);
  });

  it('a config.signal triggers the wrap too, even with no streamed upload body', async () => {
    const source = new Readable({ read() {} });
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: source,
    };
    const controller = new AbortController();
    const request: HttpInterceptorRequest = {
      url: 'http://localhost/test',
      options: {
        method: 'GET',
        responseType: 'stream',
        signal: controller.signal,
      },
    };
    const response = await toAxiosLikeResponse(request, undiciResponse);

    let caught: any;
    const drain = (async () => {
      try {
        for await (const _chunk of response.data as Readable) {
          // drain
        }
      } catch (error) {
        caught = error;
      }
    })();
    source.emit('error', abortedError());
    await drain;

    expect(caught?.name).toBe('CanceledError');
    expect(caught?.code).toBe('ERR_CANCELED');
  });

  it('zero-cost: with neither a signal nor a streamed body, the stream is untouched (no wrapper) and a raw error passes through unwrapped', async () => {
    const source = new Readable({ read() {} });
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: source,
    };
    const request: HttpInterceptorRequest = {
      url: 'http://localhost/test',
      options: { method: 'GET', responseType: 'stream' },
    };
    const response = await toAxiosLikeResponse(request, undiciResponse);

    // No wrap applied at all: the caller gets back the exact same stream
    // object undici handed this library, not a `PassThrough` copy.
    expect(response.data).toBe(source);

    let caught: any;
    const drain = (async () => {
      try {
        for await (const _chunk of response.data as Readable) {
          // drain
        }
      } catch (error) {
        caught = error;
      }
    })();
    source.emit('error', abortedError());
    await drain;

    // Unwrapped: still the raw undici shape, not translated.
    expect(caught?.isAxiosError).toBeUndefined();
    expect(caught?.code).toBe('UND_ERR_ABORTED');
  });

  it('a non-abort-shaped error on a streamed upload scenario is not miscategorized as canceled', async () => {
    const uploadBody = new Readable({ read() {} });
    const source = new Readable({ read() {} });
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: source,
    };
    const request: HttpInterceptorRequest = {
      url: 'http://localhost/test',
      options: { method: 'POST', responseType: 'stream', body: uploadBody },
    };
    const response = await toAxiosLikeResponse(request, undiciResponse);

    let caught: any;
    const drain = (async () => {
      try {
        for await (const _chunk of response.data as Readable) {
          // drain
        }
      } catch (error) {
        caught = error;
      }
    })();
    source.emit(
      'error',
      Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
      }),
    );
    await drain;

    expect(caught?.name).not.toBe('CanceledError');
    expect(caught?.message).toBe('other side closed');
  });

  it('bidirectional destroy: a consumer destroying the wrapped stream early also destroys the raw source', async () => {
    const source = new Readable({ read() {} });
    const undiciResponse: any = {
      statusCode: 200,
      statusText: 'OK',
      headers: {},
      body: source,
    };
    const controller = new AbortController();
    const request: HttpInterceptorRequest = {
      url: 'http://localhost/test',
      options: {
        method: 'GET',
        responseType: 'stream',
        signal: controller.signal,
      },
    };
    const response = await toAxiosLikeResponse(request, undiciResponse);
    expect(response.data).not.toBe(source);

    (response.data as any).destroy();
    await new Promise<void>(resolve => {
      if (source.destroyed) {
        resolve();
        return;
      }
      source.once('close', () => resolve());
    });
    expect(source.destroyed).toBe(true);
  });
});
