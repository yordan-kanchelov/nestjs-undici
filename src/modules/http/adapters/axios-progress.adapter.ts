import { Transform, pipeline, Readable } from 'node:stream';
import type { AxiosProgressEvent } from '../interfaces/axios-compatible.interface';

// ---------------------------------------------------------------------------
// `maxRate`/`onUploadProgress`/`onDownloadProgress` (plan.md phase 2:
// "Progress callbacks ... maxRate"). Ported from axios' own
// `lib/helpers/speedometer.js`/`throttle.js`/`progressEventReducer.js`/
// `AxiosTransformStream.js` so the event shape and throttling cadence match;
// trimmed to what this library needs (no `_read`-hook backpressure dance).
//
// Every entry point here is only ever called once a caller actually sets
// `onUploadProgress`/`onDownloadProgress`/`maxRate` - see the call sites in
// `http.service.ts` (`executeRequest`) and `axios-response.adapter.ts`
// (`toAxiosLikeResponse`), each gated behind a single `||`/`!== undefined`
// check so a plain request never allocates a reducer, a meter stream, or even
// enters this module's code.
// ---------------------------------------------------------------------------

/** axios' `utils.toFiniteNumber`: a finite number, or `undefined`. */
export function toFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = +(value as any);
  return Number.isFinite(n) ? n : undefined;
}

/** Splits `maxRate` (a single bytes/sec figure, or `[upload, download]`) the way axios does. */
export function resolveMaxRates(maxRate: unknown): {
  upload?: number;
  download?: number;
} {
  if (maxRate === undefined) return {};
  if (Array.isArray(maxRate)) {
    return {
      upload: toFiniteNumber(maxRate[0]),
      download: toFiniteNumber(maxRate[1]),
    };
  }
  const n = toFiniteNumber(maxRate);
  return { upload: n, download: n };
}

/**
 * axios' `speedometer`: a rolling bytes/sec estimate over the last
 * `samplesCount` chunks, `undefined` until at least `min` ms of samples have
 * accumulated.
 */
function speedometer(
  samplesCount: number,
  min: number,
): (chunkLength: number) => number | undefined {
  const bytes = new Array<number>(samplesCount);
  const timestamps = new Array<number>(samplesCount);
  let head = 0;
  let tail = 0;
  let firstSampleTS: number | undefined;

  return function push(chunkLength: number): number | undefined {
    const now = Date.now();
    const startedAt = timestamps[tail];
    if (!firstSampleTS) firstSampleTS = now;

    bytes[head] = chunkLength;
    timestamps[head] = now;

    let i = tail;
    let bytesCount = 0;
    while (i !== head) {
      bytesCount += bytes[i++];
      i = i % samplesCount;
    }
    head = (head + 1) % samplesCount;
    if (head === tail) tail = (tail + 1) % samplesCount;

    if (now - firstSampleTS < min) return undefined;
    const passed = startedAt && now - startedAt;
    return passed ? Math.round((bytesCount * 1000) / passed) : undefined;
  };
}

/** axios' `throttle`: at most one call per `1000/freq` ms, with a trailing call for the last, coalesced set of args - plus `flush()` to force it immediately (used on stream end so the final event is never lost mid-window). */
function throttle(
  fn: (...args: any[]) => void,
  freq: number,
): { call: (...args: any[]) => void; flush: () => void } {
  let timestamp = 0;
  const threshold = 1000 / freq;
  let lastArgs: any[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const invoke = (args: any[], now = Date.now()): void => {
    timestamp = now;
    lastArgs = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fn(...args);
  };

  return {
    call: (...args: any[]) => {
      const now = Date.now();
      const passed = now - timestamp;
      if (passed >= threshold) {
        invoke(args, now);
      } else {
        lastArgs = args;
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            invoke(lastArgs!);
          }, threshold - passed);
        }
      }
    },
    flush: () => {
      if (lastArgs) invoke(lastArgs);
    },
  };
}

/**
 * axios' `progressEventReducer` + `progressEventDecorator`: throttles raw
 * `(loaded, total)` updates into the public `AxiosProgressEvent` shape
 * (`loaded`/`total`/`progress`/`bytes`/`rate`/`estimated`/`lengthComputable`,
 * plus `upload`/`download`), calling `listener` at most every `1000/freq` ms
 * (axios: `freq = 3`) - `flush()` forces the last, still-throttled update
 * through immediately, called once the underlying stream ends so a fast
 * transfer's final `loaded === total` event is never dropped mid-window.
 */
export function createProgressReporter(
  listener: (event: AxiosProgressEvent) => void,
  isDownload: boolean,
  freq = 3,
): { report: (loaded: number, total?: number) => void; flush: () => void } {
  let bytesNotified = 0;
  const rate = speedometer(50, 250);
  const throttled = throttle((loaded: number, total?: number) => {
    const clampedLoaded = Math.max(
      0,
      total != null ? Math.min(loaded, total) : loaded,
    );
    const progressBytes = Math.max(0, clampedLoaded - bytesNotified);
    const currentRate = rate(progressBytes);
    bytesNotified = Math.max(bytesNotified, clampedLoaded);

    const event = {
      loaded: clampedLoaded,
      total,
      progress: total ? clampedLoaded / total : undefined,
      bytes: progressBytes,
      rate: currentRate || undefined,
      estimated:
        currentRate && total
          ? (total - clampedLoaded) / currentRate
          : undefined,
      lengthComputable: total != null,
    } as AxiosProgressEvent;
    (event as any)[isDownload ? 'download' : 'upload'] = true;
    listener(event);
  }, freq);

  return {
    report: (loaded, total) => throttled.call(loaded, total),
    flush: throttled.flush,
  };
}

const METER_CHUNK_SIZE = 64 * 1024;
const METER_MIN_CHUNK_SIZE = 100;
const METER_TIME_WINDOW = 500;

/**
 * Counts bytes passing through and, when `maxRate` (bytes/sec) is set,
 * throttles throughput to roughly that many bytes/sec - a trimmed port of
 * axios' `AxiosTransformStream` (`lib/helpers/AxiosTransformStream.js`):
 * same windowed-chunk-splitting algorithm, minus its `_read`-hook
 * backpressure bookkeeping (a plain `Transform`'s own highWaterMark handling
 * is enough for this opt-in feature). Emits `'progress'` with the cumulative
 * byte count on every chunk it lets through; a caller with no
 * `onUploadProgress`/`onDownloadProgress` never attaches a `'progress'`
 * listener, so the event is simply unobserved (still emitted - cheap, no
 * `newListener` gating like axios' own class bothers with, since building
 * this stream at all already means one of `onProgress`/`maxRate` was set).
 */
class ByteMeterStream extends Transform {
  private readonly maxRate: number;
  private _bytesSeen = 0;
  private windowStart = 0;
  private windowBytes = 0;

  constructor(maxRate?: number) {
    super({ readableHighWaterMark: METER_CHUNK_SIZE });
    this.maxRate = maxRate && maxRate > 0 ? maxRate : 0;
  }

  /** Cumulative byte count forwarded so far - read by `meterDownloadBody`'s undici slow-consumer mitigation below. */
  get bytesSeen(): number {
    return this._bytesSeen;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this.maxRate) {
      this._bytesSeen += buf.length;
      this.emit('progress', this._bytesSeen);
      callback(null, buf);
      return;
    }
    this.sendThrottled(buf, callback);
  }

  private sendThrottled(
    chunk: Buffer,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const divider = 1000 / METER_TIME_WINDOW;
    const bytesThreshold = this.maxRate / divider;
    const minChunkSize = Math.max(METER_MIN_CHUNK_SIZE, bytesThreshold * 0.01);

    const now = Date.now();
    let passed: number;
    if (
      !this.windowStart ||
      (passed = now - this.windowStart) >= METER_TIME_WINDOW
    ) {
      this.windowStart = now;
      const bytesLeftPrev = bytesThreshold - this.windowBytes;
      this.windowBytes = bytesLeftPrev < 0 ? -bytesLeftPrev : 0;
      passed = 0;
    }

    const bytesLeft = bytesThreshold - this.windowBytes;
    if (bytesLeft <= 0) {
      setTimeout(
        () => this.sendThrottled(chunk, callback),
        METER_TIME_WINDOW - passed,
      );
      return;
    }

    const maxChunkSize = Math.min(METER_CHUNK_SIZE, bytesLeft);
    let toSend = chunk;
    let remainder: Buffer | undefined;
    if (
      chunk.length > maxChunkSize &&
      chunk.length - maxChunkSize > minChunkSize
    ) {
      remainder = chunk.subarray(maxChunkSize);
      toSend = chunk.subarray(0, maxChunkSize);
    }

    this.windowBytes += toSend.length;
    this._bytesSeen += toSend.length;
    this.emit('progress', this._bytesSeen);
    this.push(toSend);

    if (remainder) {
      process.nextTick(() => this.sendThrottled(remainder!, callback));
    } else {
      callback();
    }
  }
}

export interface MeterOptions {
  onProgress?: (event: AxiosProgressEvent) => void;
  maxRate?: number;
  /** Known total size (from `Content-Length`, or the body's own byte length), when available. */
  total?: number;
  /**
   * `meterDownloadBody` only: true when the response is going to be fully
   * buffered in memory regardless of this meter's own behaviour - every
   * `responseType` except `'stream'`. Only then is it safe to drain the raw
   * body ahead of a slow `maxRate`/consumer (see that function's doc
   * comment) - unset/`false` (the default, and always the right value for
   * `meterUploadBody`, which never reads this field) keeps the body
   * properly backpressured, as `'stream'` callers rely on.
   */
  buffered?: boolean;
  /**
   * `meterDownloadBody` only: the request's `maxContentLength`, if set
   * (`undefined`/`0`/`-1` all mean "no limit", matching
   * `axios-response-type.adapter.ts`'s own `hasContentLengthLimit`). Read
   * only to decide whether draining ahead of a slow consumer is still safe
   * when `buffered` is true - see that function's doc comment; never
   * enforced here (the buffered read path's own streamed check still owns
   * that).
   */
  maxContentLength?: number;
  /**
   * `meterDownloadBody` only: this request's abort signal
   * (`HttpService.executeRequest`'s `RequestAbortSignal`), so a still-paced
   * buffered read can be rejected on an abort/deadline-timeout even once
   * the eager drain above has already finished reading the raw body -
   * without this, the caller's own abort (or a `timeout`) would have
   * nothing left to interrupt at the transport layer and the read would
   * just complete successfully, late. See that function's doc comment.
   */
  signal?: AbortableSignal;
}

/** Just enough of an abort signal for `meterDownloadBody` to react to it: `RequestAbortSignal` (`http.service.ts`) satisfies this directly. */
export interface AbortableSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** axios' own `scheduleProgress`: `process.nextTick` when available, `setImmediate` otherwise. */
const scheduleProgress: (callback: () => void) => void =
  typeof process !== 'undefined' && typeof process.nextTick === 'function'
    ? callback => process.nextTick(callback)
    : callback => setImmediate(callback);

/**
 * axios' own `asyncDecorator`: calls `fn` on a later tick instead of
 * synchronously. Review fix: the caller's `onUploadProgress`/
 * `onDownloadProgress` must run fully decoupled from the meter stream's own
 * `_transform`/`emit('progress', ...)` call - axios does the same
 * (`asyncDecorator(onDownloadProgress, scheduleProgress)` in
 * `lib/adapters/http.js`, wrapping the raw callback *before* it ever reaches
 * `progressEventReducer`). Without this, a synchronous throw inside the
 * user's callback propagates straight up through the stream machinery,
 * erroring/destroying the meter stream mid-response and - before this fix -
 * silently replacing the real payload with `''` (see
 * `axios-response.adapter.ts`'s `isMetered` handling). With it, the callback
 * runs on its own tick, entirely outside the response pipeline: a throw
 * there becomes an uncaught exception (or an `'unhandledRejection'`-shaped
 * problem for the app to handle), exactly as it does for real axios -
 * verified directly against axios 1.20 (a throwing `onDownloadProgress`
 * still resolves the response with the full, correct body; the throw itself
 * surfaces as a separate `uncaughtException`).
 */
function asyncDecorator(
  fn: (event: AxiosProgressEvent) => void,
): (event: AxiosProgressEvent) => void {
  return event => scheduleProgress(() => fn(event));
}

function attachReporter(
  meter: ByteMeterStream,
  isDownload: boolean,
  options: MeterOptions,
): void {
  if (!options.onProgress) return;
  const reporter = createProgressReporter(
    asyncDecorator(options.onProgress),
    isDownload,
    3,
  );
  meter.on('progress', (loaded: number) =>
    reporter.report(loaded, options.total),
  );
  meter.on('end', reporter.flush);
  meter.on('error', reporter.flush);
}

/**
 * Wraps a request body in a `ByteMeterStream` for `onUploadProgress`/upload
 * `maxRate` - only called when at least one of those is actually set (see
 * `http.service.ts`'s `executeRequest`). A string/Buffer body is converted to
 * a `Readable` first, exactly like axios' own upload path
 * (`stream.Readable.from(data, { objectMode: false })`); an existing stream
 * (a `form-data` package body, or this library's own
 * `globalFormDataToStream` output) is metered directly.
 *
 * **Not supported**: a raw `FormData` from the `undici` package (as opposed
 * to Node's global `FormData`, always converted to a stream upstream, or the
 * `form-data` package, already a stream) - undici encodes it internally, with
 * nothing for this library to pipe through first. Returned unchanged
 * (documented in `docs/axios-supported-options.md`).
 */
export function meterUploadBody(body: unknown, options: MeterOptions): unknown {
  if (body === undefined || body === null) return body;
  let source: Readable;
  if (typeof (body as any).pipe === 'function') {
    source = body as Readable;
  } else if (Buffer.isBuffer(body)) {
    source = Readable.from(body, { objectMode: false });
  } else if (typeof body === 'string') {
    source = Readable.from(Buffer.from(body), { objectMode: false });
  } else {
    return body;
  }
  const meter = new ByteMeterStream(options.maxRate);
  attachReporter(meter, false, options);
  return pipeline(source, meter, () => undefined);
}

/**
 * Wraps a response body in a `ByteMeterStream` for `onDownloadProgress`/
 * download `maxRate` - only called when at least one of those is actually
 * set (see `axios-response.adapter.ts`'s `toAxiosLikeResponse`), for every
 * `responseType` including `'stream'` (the meter is transparent to
 * `.pipe()`/async iteration, which is all the decode paths and a caller
 * consuming a `stream` response ever need).
 *
 * **Undici slow-consumer mitigation** (plan.md phase 2,
 * `plan/reports/undici-slow-consumer.md`): throttling this stream is exactly
 * what trips an undici h1-client bug. In `lib/dispatcher/client-h1.js`, a
 * response body that has already delivered every `Content-Length` byte can
 * still fail with `UND_ERR_SOCKET: other side closed`: if the server's
 * `keepAliveTimeout` (5s by default in Node, 1s in axios' own upstream test
 * fixture) closes the socket while undici's parser is paused on
 * backpressure - which throttling (or a slow `onDownloadProgress` consumer)
 * leaves it in for most of the transfer - the socket's `'end'` event can run
 * before the parser has resumed to process its own `onMessageComplete`, so
 * it still sees `parser.statusCode` set and `shouldKeepAlive` true and
 * treats a fully-delivered body as a premature close.
 *
 * We don't control undici's parser state, so this takes two steps - the
 * second alone for every caller, the first only when it's actually safe:
 *
 * 1. **Root cause, not just the symptom - `options.buffered` only.** `body`
 *    (the raw undici stream) is drained as fast as undici delivers it - via
 *    a `'data'` listener, never `.pipe()`d - so it is never left paused on
 *    *our own* backpressure long enough to race the server's
 *    `keepAliveTimeout` in the first place. Only `meter`'s own
 *    throttled/paced *output* stays backpressured, exactly as before. This
 *    means a `Content-Length`-known download drained this way can sit fully
 *    in `meter`'s internal buffer ahead of a slow `maxRate`/consumer, up to
 *    `total` bytes - **only acceptable when the response is going to be
 *    fully buffered in memory anyway**, i.e. `options.buffered` (every
 *    `responseType` except `'stream'` - a `'stream'` caller picked streaming
 *    specifically to avoid exactly that, so this step is skipped for it: a
 *    `'stream'` response keeps today's plain, backpressured pipe, and stays
 *    exposed to the race - documented as a known limitation in
 *    `docs/axios-supported-options.md`). Even for a buffered response, this
 *    is skipped whenever `maxContentLength` is set below the response's own
 *    `Content-Length` (`options.maxContentLength`): draining ahead of the
 *    buffered read path's own streamed check would read the *whole*,
 *    over-limit body before that check ever gets to reject it promptly -
 *    exactly the "download it all first" cost that check exists to avoid.
 *    Without a known `Content-Length` (`total`) at all (chunked, unknown
 *    length), there's no bound to drain ahead of, so this is skipped too,
 *    for every `responseType`.
 * 2. **Belt-and-suspenders - every caller, `'stream'` included.** Draining
 *    ahead of time makes the race far less likely for a buffered response,
 *    but can't make it impossible (e.g. a single, final chunk large enough
 *    to satisfy `Content-Length` and race the socket's `'end'` before this
 *    code even gets to call `meter.write()`); for `'stream'`, unable to
 *    drain ahead of time at all, it's the only defence. So `body`'s
 *    `'error'` is always checked directly: when it is exactly
 *    `UND_ERR_SOCKET` *and* every promised byte was already handed to
 *    `meter` (`meter.bytesSeen >= total`), it's this false positive, not a
 *    real failure, and is turned into a normal end instead of an error.
 *    This is safe unconditionally - `meter.bytesSeen` only ever counts real
 *    bytes actually forwarded from `body`, so reaching `total` is genuine
 *    proof the full body arrived, regardless of how it was paced getting
 *    there - and never buffers anything beyond what would already be
 *    sitting in `meter` at that point.
 *
 * `pipeline()` would auto-destroy `meter` with `body`'s error before we get
 * a chance to inspect it, so this wires both steps manually and mirrors
 * `pipeline`'s source cleanup (destroying `body` if the caller abandons
 * `meter` first).
 */
export function meterDownloadBody(
  body: Readable,
  options: MeterOptions,
): Readable {
  const meter = new ByteMeterStream(options.maxRate);
  attachReporter(meter, true, options);

  const { total, buffered, maxContentLength, signal } = options;
  const onBodyError = (err: NodeJS.ErrnoException): void => {
    // Step 2 (belt-and-suspenders): safe for every caller, including
    // `'stream'` - see the doc comment.
    if (
      total !== undefined &&
      meter.bytesSeen >= total &&
      err?.code === 'UND_ERR_SOCKET'
    ) {
      meter.end();
      return;
    }
    meter.destroy(err);
  };

  // Review fix (PR #33): the eager drain below (step 1) can mean the raw
  // undici transfer this request's `abortSignal` would otherwise interrupt
  // has *already finished* well before a caller's abort (or `timeout`)
  // fires - undici itself then has nothing left to abort, and without this,
  // a still-paced buffered read would just complete successfully, late,
  // instead of rejecting (confirmed directly: axios' own "an abort
  // mid-download still rejects with ERR_CANCELED" e2e case, run under Node
  // 24 via jest's `require(esm)`, failed against the eager-drain-only
  // version of this fix). So this reacts to the *same* signal
  // `HttpService.executeRequest` already tracks, independent of whichever
  // step above is (or isn't) draining `body` ahead of time - covers
  // `'stream'` too, though `settled` there flips almost immediately (right
  // after headers), before this would ever have a chance to fire for a real
  // caller abort.
  let onAbort: (() => void) | undefined;
  if (signal && !signal.aborted) {
    onAbort = () => {
      // `stream.destroy()` with no error (e.g. `signal.reason` itself being
      // `undefined` - `HttpService.executeRequest`'s own teardown aborts
      // with no reason at all) just closes cleanly instead of rejecting -
      // fall back to a proper AbortError-shaped one so a still-pending read
      // always rejects, never silently "succeeds" short.
      const reason: any =
        signal!.reason ??
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
        });
      meter.destroy(reason);
    };
    signal.addEventListener('abort', onAbort);
  }
  meter.on('close', () => {
    if (!body.destroyed) body.destroy();
    if (onAbort) signal!.removeEventListener('abort', onAbort);
  });

  const withinContentLengthLimit =
    !maxContentLength ||
    maxContentLength <= -1 ||
    (total !== undefined && total <= maxContentLength);
  const canDrainAheadOfTime =
    buffered === true && total !== undefined && withinContentLengthLimit;

  if (!canDrainAheadOfTime) {
    // `'stream'`, unknown length, or a response whose own `Content-Length`
    // already exceeds `maxContentLength` - keep today's plain,
    // backpressured pipe (still covered by step 2 above).
    body.on('error', onBodyError);
    body.pipe(meter);
    return meter;
  }

  // Step 1: a buffered response with a known, maxContentLength-safe length -
  // drain `body` eagerly (never backpressured by our own throttle/a slow
  // consumer) so undici's parser isn't left paused on it. `meter.write()`'s
  // own backpressure (its return value) is deliberately ignored here: that
  // backpressure is exactly what this step avoids propagating back onto
  // `body`; `meter`'s writable buffer holds the (bounded, `<= total` bytes)
  // backlog instead. `meter.destroyed` is checked before every write/end
  // call: an abort (above) destroys `meter` synchronously and `body`
  // asynchronously (once 'close' fires), so a `'data'`/`'end'` event
  // already queued on `body` in that gap must not write/end an
  // already-destroyed `meter` - Node would emit a second, listener-less
  // 'error' for that, an uncaught exception.
  body.on('data', (chunk: Buffer) => {
    if (!meter.destroyed) meter.write(chunk);
  });
  body.on('end', () => {
    if (!meter.destroyed) meter.end();
  });
  body.on('error', onBodyError);
  return meter;
}

/** Known upload body length: a string/Buffer's own byte length, or an already-set `Content-Length` header. Otherwise `undefined` (unknown length - `lengthComputable: false`, matching axios for a body without one). */
export function resolveUploadTotal(
  body: unknown,
  headers: Record<string, any> | undefined,
): number | undefined {
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.length;
  if (headers) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-length') {
        return toFiniteNumber(headers[key]);
      }
    }
  }
  return undefined;
}
