import { Readable } from 'node:stream';
import {
  createProgressReporter,
  meterDownloadBody,
  meterUploadBody,
  resolveMaxRates,
  resolveUploadTotal,
  toFiniteNumber,
} from '../axios-progress.adapter';

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('axios-progress.adapter', () => {
  describe('toFiniteNumber / resolveMaxRates', () => {
    it('is undefined for non-finite/absent values', () => {
      expect(toFiniteNumber(undefined)).toBeUndefined();
      expect(toFiniteNumber(null)).toBeUndefined();
      expect(toFiniteNumber(NaN)).toBeUndefined();
      expect(toFiniteNumber('not a number')).toBeUndefined();
    });

    it('parses a numeric string', () => {
      expect(toFiniteNumber('42')).toBe(42);
    });

    it('a single maxRate applies to both directions', () => {
      expect(resolveMaxRates(1000)).toEqual({ upload: 1000, download: 1000 });
    });

    it('a [upload, download] pair is split', () => {
      expect(resolveMaxRates([100, 200])).toEqual({
        upload: 100,
        download: 200,
      });
    });

    it('is {} when maxRate is unset', () => {
      expect(resolveMaxRates(undefined)).toEqual({});
    });
  });

  describe('resolveUploadTotal', () => {
    it("a string body's own byte length", () => {
      expect(resolveUploadTotal('hello', undefined)).toBe(5);
    });

    it("a Buffer body's own length", () => {
      expect(resolveUploadTotal(Buffer.from('hello'), undefined)).toBe(5);
    });

    it('a Content-Length header, case-insensitively, for anything else', () => {
      expect(
        resolveUploadTotal(Readable.from(['x']), { 'content-length': '123' }),
      ).toBe(123);
      expect(
        resolveUploadTotal(Readable.from(['x']), { 'Content-Length': '7' }),
      ).toBe(7);
    });

    it('is undefined with no known length', () => {
      expect(
        resolveUploadTotal(Readable.from(['x']), undefined),
      ).toBeUndefined();
      expect(resolveUploadTotal(Readable.from(['x']), {})).toBeUndefined();
    });
  });

  describe('createProgressReporter', () => {
    it('reports loaded/total/progress/flags, throttled to one call in a burst', () => {
      const events: any[] = [];
      const reporter = createProgressReporter(e => events.push(e), true, 3);
      reporter.report(10, 100);
      reporter.report(20, 100);
      reporter.report(30, 100);
      // All three calls land inside the same throttle window - only the
      // first fires synchronously (the rest are coalesced/dropped until the
      // window elapses or flush() is called).
      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({
        loaded: 10,
        total: 100,
        progress: 0.1,
        download: true,
        lengthComputable: true,
      });
      expect(events[0].upload).toBeUndefined();
    });

    it('flush() delivers the last, still-throttled update immediately', () => {
      const events: any[] = [];
      const reporter = createProgressReporter(e => events.push(e), false, 3);
      reporter.report(50, 200);
      reporter.report(200, 200);
      expect(events.length).toBe(1);
      reporter.flush();
      expect(events.length).toBe(2);
      expect(events[1]).toMatchObject({
        loaded: 200,
        total: 200,
        progress: 1,
        upload: true,
      });
    });

    it('loaded is clamped to total, and never decreases across reports', () => {
      const events: any[] = [];
      const reporter = createProgressReporter(e => events.push(e), true, 3);
      reporter.report(150, 100); // over-reported loaded is clamped to total
      reporter.flush();
      expect(events[0].loaded).toBe(100);
      expect(events[0].progress).toBe(1);
    });

    it('lengthComputable is false and progress is undefined with no known total', () => {
      const events: any[] = [];
      const reporter = createProgressReporter(e => events.push(e), true, 3);
      reporter.report(10, undefined);
      expect(events[0]).toMatchObject({
        loaded: 10,
        total: undefined,
        progress: undefined,
        lengthComputable: false,
      });
    });
  });

  describe('meterUploadBody', () => {
    it('is a no-op when body is undefined/null', () => {
      expect(meterUploadBody(undefined, {})).toBeUndefined();
      expect(meterUploadBody(null, {})).toBeNull();
    });

    it('converts a string/Buffer body to a metered stream, preserving the bytes', async () => {
      const wrappedString = meterUploadBody('hello world', {}) as Readable;
      expect(typeof (wrappedString as any).pipe).toBe('function');
      expect((await drain(wrappedString)).toString()).toBe('hello world');

      const wrappedBuffer = meterUploadBody(Buffer.from('abc'), {}) as Readable;
      expect((await drain(wrappedBuffer)).toString()).toBe('abc');
    });

    it('meters an existing stream body directly', async () => {
      const source = Readable.from([Buffer.from('a'), Buffer.from('b')]);
      const events: any[] = [];
      const wrapped = meterUploadBody(source, {
        onProgress: e => events.push(e),
        total: 2,
      }) as Readable;
      expect((await drain(wrapped)).toString()).toBe('ab');
      // Give the throttled reporter's trailing flush (on 'end') a tick.
      await new Promise(r => setImmediate(r));
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]).toMatchObject({
        loaded: 2,
        total: 2,
        progress: 1,
        upload: true,
      });
    });

    it('returns a non-stream/non-buffer/non-string body unchanged (e.g. an undici-native FormData)', () => {
      const body = { [Symbol.toStringTag]: 'FormData' } as any;
      expect(meterUploadBody(body, { onProgress: () => undefined })).toBe(body);
    });

    it('throttles throughput when maxRate is set (functional check, generous timing budget)', async () => {
      const payload = Buffer.alloc(4000, 'x');
      const started = Date.now();
      const wrapped = meterUploadBody(payload, { maxRate: 2000 }) as Readable;
      const out = await drain(wrapped);
      const elapsed = Date.now() - started;
      expect(out.length).toBe(4000);
      // At ~2000 bytes/sec, 4000 bytes takes at least one full 500ms window
      // beyond the first burst - a generous floor to avoid CI flakiness.
      expect(elapsed).toBeGreaterThanOrEqual(300);
    });
  });

  describe('meterDownloadBody', () => {
    it('meters a response body stream, reporting download:true', async () => {
      const source = Readable.from([Buffer.from('x'.repeat(10))]);
      const events: any[] = [];
      const wrapped = meterDownloadBody(source, {
        onProgress: e => events.push(e),
        total: 10,
      });
      expect((await drain(wrapped)).length).toBe(10);
      await new Promise(r => setImmediate(r));
      expect(events[events.length - 1]).toMatchObject({
        loaded: 10,
        total: 10,
        progress: 1,
        download: true,
      });
    });

    // Review fix (PR #30): a throwing `onDownloadProgress`/`onUploadProgress`
    // callback used to propagate synchronously through the meter's own
    // `_transform`/`emit('progress', ...)` call, erroring and destroying the
    // stream mid-response - silently swallowed further up into an
    // HTTP-200-looking response with an empty body (see
    // `axios-response.adapter.spec.ts`). axios decouples the raw callback via
    // `process.nextTick` (`lib/adapters/http.js`'s `asyncDecorator`) before it
    // ever reaches the stream/throttle machinery; this ports the same
    // mechanism (`asyncDecorator`/`scheduleProgress` above).
    it('a throwing onProgress callback never reaches the meter stream itself - it stays decoupled (process.nextTick), so the stream still ends normally with the full body', async () => {
      // Intercepts the real `process.nextTick` so the deferred callback's
      // throw can be observed and safely caught directly by this test,
      // instead of letting it actually escape as a real, process-wide
      // uncaught exception (which jest-circus would attribute to whatever
      // test happens to still be running).
      const scheduled: Array<() => void> = [];
      const realNextTick = process.nextTick;
      (process as any).nextTick = (cb: () => void) => scheduled.push(cb);
      try {
        const source = Readable.from([Buffer.from('hello world')]);
        let sawStreamError = false;
        const wrapped = meterDownloadBody(source, {
          onProgress: () => {
            throw new Error('user callback boom');
          },
          total: 11,
        });
        wrapped.on('error', () => {
          sawStreamError = true;
        });
        const data = await drain(wrapped);
        expect(data.toString()).toBe('hello world');
        expect(sawStreamError).toBe(false);
        // The callback was scheduled (via the real mechanism, `process.nextTick`)
        // but never actually invoked yet - proving it never ran on the
        // stream's own call stack.
        expect(scheduled.length).toBeGreaterThan(0);
        // Running it now (as the real event loop would) does throw - which
        // is exactly what becomes an uncaught exception in a real process -
        // but the stream above already finished cleanly regardless.
        expect(() => scheduled.forEach(fn => fn())).toThrow(
          'user callback boom',
        );
        expect(sawStreamError).toBe(false);
      } finally {
        process.nextTick = realNextTick;
      }
    });

    // plan.md phase 2 / plan/reports/undici-slow-consumer.md: undici's h1
    // client can error a fully-delivered body with `UND_ERR_SOCKET: other
    // side closed` if the server closes the (already fully-drained)
    // keep-alive socket while a slow consumer left the parser paused on
    // backpressure. Since maxRate/onDownloadProgress is what makes this
    // package the slow consumer, meterDownloadBody swallows exactly that
    // false positive - but only once every `Content-Length` byte has
    // actually reached the caller.
    describe('undici slow-consumer mitigation (UND_ERR_SOCKET)', () => {
      it('a fully-delivered body that errors with UND_ERR_SOCKET after Content-Length is satisfied ends normally instead of erroring', async () => {
        const source = new Readable({ read() {} });
        const wrapped = meterDownloadBody(source, { total: 5 });

        const chunks: Buffer[] = [];
        const errors: unknown[] = [];
        wrapped.on('data', c => chunks.push(c));
        wrapped.on('error', e => errors.push(e));
        const ended = new Promise(resolve => wrapped.on('end', resolve));

        source.push(Buffer.from('hello'));
        await new Promise(r => setImmediate(r));

        const err = new Error('other side closed') as NodeJS.ErrnoException;
        err.code = 'UND_ERR_SOCKET';
        source.emit('error', err);

        await ended;
        expect(Buffer.concat(chunks).toString()).toBe('hello');
        expect(errors).toEqual([]);
      });

      it('a genuinely premature UND_ERR_SOCKET (fewer bytes than Content-Length) still errors', async () => {
        const source = new Readable({ read() {} });
        const wrapped = meterDownloadBody(source, { total: 10 });

        const errors: unknown[] = [];
        wrapped.on('data', () => undefined);
        wrapped.on('error', e => errors.push(e));

        source.push(Buffer.from('hello')); // only 5 of the promised 10 bytes
        await new Promise(r => setImmediate(r));

        const err = new Error('other side closed') as NodeJS.ErrnoException;
        err.code = 'UND_ERR_SOCKET';
        source.emit('error', err);

        await new Promise(r => setImmediate(r));
        expect(errors).toHaveLength(1);
        expect((errors[0] as NodeJS.ErrnoException).code).toBe(
          'UND_ERR_SOCKET',
        );
      });

      it('a different error is never swallowed, even with the full body already delivered', async () => {
        const source = new Readable({ read() {} });
        const wrapped = meterDownloadBody(source, { total: 5 });

        const errors: unknown[] = [];
        wrapped.on('data', () => undefined);
        wrapped.on('error', e => errors.push(e));

        source.push(Buffer.from('hello'));
        await new Promise(r => setImmediate(r));

        source.emit('error', new Error('boom'));

        await new Promise(r => setImmediate(r));
        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).message).toBe('boom');
      });

      it('with no Content-Length (chunked/unknown length), UND_ERR_SOCKET is never swallowed', async () => {
        const source = new Readable({ read() {} });
        const wrapped = meterDownloadBody(source, {});

        const errors: unknown[] = [];
        wrapped.on('data', () => undefined);
        wrapped.on('error', e => errors.push(e));

        source.push(Buffer.from('hello'));
        await new Promise(r => setImmediate(r));

        const err = new Error('other side closed') as NodeJS.ErrnoException;
        err.code = 'UND_ERR_SOCKET';
        source.emit('error', err);

        await new Promise(r => setImmediate(r));
        expect(errors).toHaveLength(1);
      });
    });

    // Coordinator review fix on PR #33: the first version of the mitigation
    // eagerly drained `body` (ignoring `meter.write()`'s own backpressure)
    // whenever `Content-Length` was known, for *every* responseType -
    // including `'stream'`. For `responseType: 'stream'` with
    // `onDownloadProgress`/`maxRate` set (a progress bar on a large
    // download - exactly why a caller picks `'stream'` at all), that meant a
    // multi-GB response could sit fully in memory ahead of a slow consumer,
    // the opposite of what streaming is for. `buffered` (only ever `true`
    // for a responseType that's going to be fully buffered anyway - see
    // `axios-response.adapter.ts`'s call site) now gates that eager drain;
    // these tests fail against that first version (drop `buffered` from
    // either call below and both this describe block's tests fail: the
    // 'stream' one because `source` never pauses, the `maxContentLength` one
    // because `source` fully drains despite exceeding the limit).
    describe('buffered vs stream backpressure (coordinator review fix, PR #33)', () => {
      // A pull-based source: `_read` only ever produces one chunk per call,
      // so `.pipe()`'s own flow control is what would make it pause - never
      // draining without a consumer requesting more proves nothing pulled
      // it eagerly.
      function makeLargeSource(
        totalBytes: number,
        chunkSize = 64 * 1024,
      ): Readable {
        let sent = 0;
        return new Readable({
          read() {
            if (sent >= totalBytes) {
              this.push(null);
              return;
            }
            const size = Math.min(chunkSize, totalBytes - sent);
            sent += size;
            this.push(Buffer.alloc(size, 'x'));
          },
        });
      }

      it("responseType: 'stream' (buffered: false/unset) keeps the raw body backpressured - never drained ahead of an unread consumer, even with a known Content-Length", async () => {
        const total = 4 * 1024 * 1024; // 4MB, several highWaterMarks
        const source = makeLargeSource(total);
        const wrapped = meterDownloadBody(source, { total }); // buffered unset

        // Nothing ever reads `wrapped` - a stalled/very slow stream consumer.
        await new Promise(r => setTimeout(r, 50));

        expect(source.isPaused()).toBe(true);
        expect(source.readableEnded).toBe(false);
        // Bounded to a handful of highWaterMarks, not anywhere near `total`.
        expect((wrapped as any).writableLength).toBeLessThan(1024 * 1024);

        source.destroy();
        wrapped.destroy();
      });

      it('a buffered responseType (buffered: true) drains the raw body eagerly - even with a stalled consumer, bounded by Content-Length', async () => {
        const total = 4 * 1024 * 1024; // 4MB
        const source = makeLargeSource(total);
        const wrapped = meterDownloadBody(source, { total, buffered: true });

        // Same stalled consumer as above - the difference is `buffered`.
        await new Promise(r => setTimeout(r, 50));

        expect(source.readableEnded).toBe(true); // fully drained already
        expect(source.isPaused()).toBe(false); // never backpressured

        wrapped.destroy();
      });

      it('a buffered responseType whose Content-Length already exceeds maxContentLength is NOT drained ahead of time - the streamed maxContentLength check still gets to reject it promptly, without reading the whole oversized body first', async () => {
        const total = 4 * 1024 * 1024; // 4MB, well over the limit below
        const source = makeLargeSource(total);
        const wrapped = meterDownloadBody(source, {
          total,
          buffered: true,
          maxContentLength: 1000, // far under `total`
        });

        await new Promise(r => setTimeout(r, 50));

        // Falls back to the plain, backpressured pipe: not eagerly drained.
        expect(source.isPaused()).toBe(true);
        expect(source.readableEnded).toBe(false);

        source.destroy();
        wrapped.destroy();
      });

      it('a buffered responseType whose Content-Length is within maxContentLength is still drained ahead of time', async () => {
        const total = 4 * 1024 * 1024;
        const source = makeLargeSource(total);
        const wrapped = meterDownloadBody(source, {
          total,
          buffered: true,
          maxContentLength: total + 1, // just over `total` - within the limit
        });

        await new Promise(r => setTimeout(r, 50));

        expect(source.readableEnded).toBe(true);
        expect(source.isPaused()).toBe(false);

        wrapped.destroy();
      });
    });
  });
});
