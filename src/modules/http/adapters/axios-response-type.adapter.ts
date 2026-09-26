import {
  brotliDecompressSync,
  constants as zlibConstants,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
  gunzipSync,
  inflateRawSync,
  inflateSync,
  zstdDecompressSync,
} from 'node:zlib';
import type { Readable } from 'node:stream';
import type { Dispatcher } from 'undici';
import type { AxiosResponseType } from '../interfaces/axios-compatible.interface';

/** axios: `ERR_BAD_RESPONSE`, `maxContentLength size of ${limit} exceeded` - checked against real axios 1.20 (`lib/adapters/http.js`). */
function assertMaxContentLength(size: number, maxContentLength?: number): void {
  if (maxContentLength && maxContentLength > -1 && size > maxContentLength) {
    const error: any = new Error(
      `maxContentLength size of ${maxContentLength} exceeded`,
    );
    error.code = 'ERR_BAD_RESPONSE';
    throw error;
  }
}

/**
 * `body.arrayBuffer()`, falling back to plain async iteration when `body`
 * doesn't have that method - true for undici's own response body (the common
 * case, and the only one this fallback costs anything to check for), but not
 * for a plain Node `Readable` (e.g. the `ByteMeterStream` a progress
 * callback/`maxRate` wraps the body in - see `axios-progress.adapter.ts`).
 */
async function bodyArrayBuffer(
  body: Dispatcher.ResponseData['body'],
): Promise<ArrayBuffer> {
  if (typeof (body as any).arrayBuffer === 'function') {
    return body.arrayBuffer();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

/** `body.text()`, with the same fallback as `bodyArrayBuffer` above. */
async function bodyText(
  body: Dispatcher.ResponseData['body'],
): Promise<string> {
  if (typeof (body as any).text === 'function') {
    return body.text();
  }
  return Buffer.from(await bodyArrayBuffer(body)).toString('utf8');
}

/**
 * Reads a body stream into a `Buffer`, enforcing `maxContentLength` as bytes
 * arrive (axios does the same - see `lib/adapters/http.js`'s streamed
 * `maxContentLength` enforcement) rather than after buffering the whole
 * response: a body that exceeds the limit is rejected, and the underlying
 * stream released (via the `for await` loop's own `return()` call on an
 * abrupt completion), as soon as the limit is crossed - not after reading
 * however much more of a possibly-huge response follows. Only used when a
 * limit is actually set; an unset/`-1` `maxContentLength` (the common case)
 * defers to undici's own `.arrayBuffer()`, unchanged.
 */
async function readBufferWithLimit(
  body: Dispatcher.ResponseData['body'],
  maxContentLength?: number,
): Promise<Buffer> {
  if (!maxContentLength || maxContentLength <= -1) {
    return Buffer.from(await bodyArrayBuffer(body));
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as unknown as AsyncIterable<Buffer>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxContentLength) {
      const error: any = new Error(
        `maxContentLength size of ${maxContentLength} exceeded`,
      );
      error.code = 'ERR_BAD_RESPONSE';
      throw error;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// JSON parsing (axios' `transitional.forcedJSONParsing` / `silentJSONParsing`)
// ---------------------------------------------------------------------------

/** axios' `config.parseReviver`: the same signature `JSON.parse`'s own `reviver` accepts. */
export type JsonReviver = (this: any, key: string, value: any) => any;

/**
 * Parses JSON like axios' default `transformResponse` with
 * `silentJSONParsing: true`: invalid JSON yields the raw string instead of
 * throwing. `reviver` is axios' `parseReviver` config option, passed straight
 * through to `JSON.parse` - `own(this, 'parseReviver')` in axios' own
 * `lib/defaults/index.js`.
 */
export function parseJsonOrText(text: string, reviver?: JsonReviver): any {
  if (!text) return text;
  try {
    return JSON.parse(text, reviver);
  } catch {
    return text;
  }
}

/**
 * Tags a `JSON.parse` failure (a native `SyntaxError`) with the raw,
 * unparsed text, so `toAxiosLikeResponse`'s catch block
 * (`axios-response.adapter.ts`) - which never sees `text`, local to
 * `readBodyAsResponseType` below - can attach it as `response.data` on the
 * `AxiosError` it throws, matching axios' own JSON-parse-failure response
 * exactly (`response.data` stays the raw string, never the [would-be]
 * parsed value - checked against real axios 1.20). A plain own property on
 * the *original* error object (never a new wrapper), so `AxiosError.from`
 * still reads its real `message`/`name`/`code`, exactly as it would for any
 * other wrapped error.
 */
export const STRICT_JSON_RAW_TEXT = Symbol('strictJsonRawText');

/**
 * axios' `transitional.silentJSONParsing: false` (`strictJSONParsing =
 * !silentJSONParsing && JSONRequested` in `lib/defaults/index.js`;
 * `JSONRequested` requires `responseType === 'json'`, so this is only ever
 * reached from `readBodyAsResponseType`'s `'json'` branch below -
 * `silentJSONParsing` never affects the *default*, no-`responseType`
 * parsing path (`parseJsonOrText`/`parseTextMaybeJson` above stay
 * unconditionally silent and zero-cost regardless of `silentJSONParsing`,
 * matching axios' own `JSONRequested` gate exactly): a `JSON.parse` failure
 * throws its native `SyntaxError` straight through (tagged via
 * `STRICT_JSON_RAW_TEXT`) instead of falling back to the raw string.
 */
export function parseJsonStrict(text: string, reviver?: JsonReviver): any {
  if (!text) return text;
  try {
    return JSON.parse(text, reviver);
  } catch (error) {
    (error as any)[STRICT_JSON_RAW_TEXT] = text;
    throw error;
  }
}

/**
 * True when the first non-whitespace character of `text` starts a JSON
 * value (`{`, `[`, a string, a number, or `true`/`false`/`null`). Used to
 * gate the JSON-parse attempt on non-JSON content types, the same
 * optimisation `forcedJSONParsing` needs since it otherwise tries to parse
 * every string response.
 */
function isJsonStart(text: string): boolean {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    // space, tab, CR, LF
    if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) {
      i++;
      continue;
    }
    break;
  }
  if (i >= n) return false;
  const c = text.charCodeAt(i);
  if (c === 0x7b /* { */ || c === 0x5b /* [ */ || c === 0x22 /* " */) {
    return true;
  }
  if (c === 0x2d /* - */ || (c >= 0x30 && c <= 0x39) /* 0-9 */) return true;
  const rest = text.slice(i, i + 5);
  return (
    rest.startsWith('true') ||
    rest.startsWith('false') ||
    rest.startsWith('null')
  );
}

/**
 * Parses JSON only when the text looks like it starts a JSON value; falls
 * back to the raw string silently otherwise. Avoids a wasted `JSON.parse`
 * try/catch for ordinary text responses.
 */
export function parseTextMaybeJson(text: string, reviver?: JsonReviver): any {
  if (!text || !isJsonStart(text)) return text;
  return parseJsonOrText(text, reviver);
}

// ---------------------------------------------------------------------------
// Content-type classification (axios decodes every non-`arraybuffer` /
// non-`stream` response to a UTF-8 string; this narrows that to the content
// types axios projects realistically send as text, so genuine binary
// downloads without an explicit `responseType` still come back as a Buffer)
// ---------------------------------------------------------------------------

const JSON_CONTENT_TYPE_RE = /^application\/(?:[\w!#$%^&*_.-]*\+)?json\b/i;
const TEXT_DECODABLE_RE =
  /^(?:text\/|application\/xml\b|application\/(?:x-)?javascript\b|application\/x-www-form-urlencoded\b|image\/svg\+xml\b|application\/octet-stream\b)/i;

export type BodyContentKind = 'json' | 'text' | 'binary';

/**
 * Classifies a `Content-Type` for the default (no explicit `responseType`)
 * decoding path. Empty/missing content type is treated as text, matching
 * axios (which decodes to a string regardless of content type).
 */
export function classifyContentType(contentType: string): BodyContentKind {
  const ct = contentType.trim();
  if (!ct) return 'text';
  if (JSON_CONTENT_TYPE_RE.test(ct)) return 'json';
  if (TEXT_DECODABLE_RE.test(ct)) return 'text';
  return 'binary';
}

// ---------------------------------------------------------------------------
// Decompression (gzip / br / deflate), honouring `decompress: false`
// ---------------------------------------------------------------------------

/**
 * axios' Node `http` transport aliases `compress`/`x-compress` onto the same
 * `zlib.createUnzip()`/`gunzipSync` decoder it uses for `gzip`/`x-gzip`
 * (`lib/adapters/http.js`: `case 'gzip': case 'x-gzip': case 'compress':
 * case 'x-compress': streams.push(zlib.createUnzip(zlibOptions));` - checked
 * against real axios 1.20) - it doesn't actually implement the old
 * Lempel-Ziv-Welch "compress" scheme, it just treats the name as another
 * spelling of gzip. This library does the same: `compress`/`x-compress`
 * decode via the exact same `createGunzip`/`gunzipSync` calls as `gzip`
 * below, so a server that sends genuinely LZW-compressed `compress` data
 * fails to decompress here exactly as it would against axios.
 */
const GZIP_ENCODINGS = new Set(['gzip', 'x-gzip', 'compress', 'x-compress']);

/**
 * True when this Node build's `zlib` supports Zstandard (`zstd`) - added in
 * Node 22.15.0 / 23.8.0 (every Node this package's `engines.node`,
 * `>=22.17.0`, allows already has it). Feature-detected the same way axios
 * does (`isZstdSupported` in `lib/adapters/http.js`) rather than assumed: the
 * check runs once, at module load, and lets `decompressBuffer`/
 * `decompressStream` fall through to their existing "unknown encoding, pass
 * the raw bytes through untouched" branch on a hypothetical older/patched
 * Node that lacks it - exactly what axios itself does (its own `switch` on
 * `content-encoding: zstd` is a no-op, leaving the header and the body both
 * unchanged, when `zlib.createZstdDecompress` isn't a function).
 */
export const isZstdSupported = typeof createZstdDecompress === 'function';

/**
 * `Content-Encoding` values `decompressBuffer`/`decompressStream` can
 * actually decode. Used to build the default `Accept-Encoding` request
 * header - matches axios' own `ACCEPT_ENCODING` (`lib/adapters/http.js`)
 * exactly, `compress` included: axios advertises it (and, per
 * `GZIP_ENCODINGS`'s doc comment above, so does this library now that it
 * decodes `compress`/`x-compress` the same way as `gzip`).
 *
 * `zstd` is deliberately left out here even though it's decoded (see
 * `decompressBuffer`/`decompressStream` below): axios 1.20 only advertises
 * it when `transitional.advertiseZstdAcceptEncoding === true` is explicitly
 * set (`ACCEPT_ENCODING_WITH_ZSTD` vs. the plain `ACCEPT_ENCODING` axios
 * sends by default - `lib/adapters/http.js`), i.e. axios' own default
 * `Accept-Encoding` doesn't include it either. A server sending `zstd`
 * without being asked (or one that always compresses that way) still gets
 * decoded either way - decoding never depends on what was advertised. A
 * caller who wants to advertise it can already do so like any other default
 * header override: `axiosRef.defaults.headers.common['Accept-Encoding'] =
 * 'gzip, compress, deflate, br, zstd'` (or a per-request header), so this
 * library adds no separate `advertiseZstdAcceptEncoding`-equivalent option
 * for it.
 */
export const SUPPORTED_CONTENT_ENCODINGS = 'gzip, compress, deflate, br';

function normalizeEncoding(encoding: string): string {
  return encoding.trim().toLowerCase();
}

/**
 * axios' own `zlibOptions`/`brotliOptions`/`zstdOptions` (`lib/adapters
 * /http.js`, checked against real axios 1.20): `flush`/`finishFlush: <the
 * codec's own SYNC/FLUSH constant>`, passed to every decompressor
 * (`zlib.createUnzip(zlibOptions)`, `createBrotliDecompress
 * (brotliOptions)`, `createZstdDecompress(zstdOptions)`) - never the plain,
 * `finishFlush`-less default. Without this, a decompressor that reaches the
 * end of its INPUT without a complete internal decode state (an empty body,
 * or one truncated mid-stream) throws `Z_BUF_ERROR`/"unexpected end of
 * file" instead of resolving with whatever could actually be decoded (`''`
 * for a genuinely empty body, or the partial bytes for a truncated one) -
 * confirmed directly (`gunzipSync(Buffer.alloc(0))` throws without this,
 * succeeds with `''` with it; a truncated-but-structurally-valid gzip
 * stream decodes its partial bytes either way, never throwing, once this is
 * set) - matching real axios 1.20's own upstream conformance tests ("should
 * not fail with an empty response (with|without) content-length header
 * (Z_BUF_ERROR)"). A stream that's corrupt in a way no flush setting can
 * paper over (the wrong format entirely, e.g. plain text sent as
 * `Content-Encoding: gzip`) still throws either way (`Z_DATA_ERROR` -
 * "incorrect header check") - that's what `toAxiosLikeResponse`'s
 * corrupt-body wrapping (`axios-response.adapter.ts`) is actually for.
 */
const GZIP_FLUSH_OPTIONS = {
  flush: zlibConstants.Z_SYNC_FLUSH,
  finishFlush: zlibConstants.Z_SYNC_FLUSH,
} as const;
const BROTLI_FLUSH_OPTIONS = {
  flush: zlibConstants.BROTLI_OPERATION_FLUSH,
  finishFlush: zlibConstants.BROTLI_OPERATION_FLUSH,
} as const;
/**
 * Only referenced when `isZstdSupported` (Node 22.15.0/23.8.0+, where
 * `zlib.constants.ZSTD_e_flush` also exists) - `as any` sidesteps a
 * `@types/node` version lag on the exact constant name/shape without
 * affecting anything at runtime on a Node that actually has it.
 */
const ZSTD_FLUSH_OPTIONS = {
  flush: (zlibConstants as any).ZSTD_e_flush,
  finishFlush: (zlibConstants as any).ZSTD_e_flush,
} as const;

/**
 * Tags an error as an actual decode failure - thrown by zlib/brotli/zstd
 * itself, decoding already-fully-read bytes - as opposed to a network-level
 * error (a dropped socket, an abort, ...) that happens to reach the same
 * catch block while decompression was configured. `toAxiosLikeResponse`'s
 * catch block and `wrapStreamCancellation` (`axios-response.adapter.ts`)
 * check for this tag, rather than the error's `code`/`name` shape: brotli
 * and zstd don't raise `Z_*`-prefixed codes the way zlib (gzip/deflate)
 * does, so a shape check alone under-wraps them (found in PR #38 review) -
 * this instead marks the error at its actual origin, uniformly across every
 * codec and both the buffered (`decompressBuffer`, below) and streamed
 * (`decompressStream`) decode paths.
 */
export const DECODE_ERROR = Symbol('decodeError');

/** Synchronously decompresses a full body buffer per `Content-Encoding`. */
export function decompressBuffer(buffer: Buffer, encoding: string): Buffer {
  const e = normalizeEncoding(encoding);
  try {
    if (GZIP_ENCODINGS.has(e)) return gunzipSync(buffer, GZIP_FLUSH_OPTIONS);
    if (e === 'br') return brotliDecompressSync(buffer, BROTLI_FLUSH_OPTIONS);
    if (e === 'deflate') {
      try {
        return inflateSync(buffer, GZIP_FLUSH_OPTIONS);
      } catch {
        // Some servers send raw (headerless) deflate under the same
        // Content-Encoding; axios falls back to it the same way.
        return inflateRawSync(buffer, GZIP_FLUSH_OPTIONS);
      }
    }
    if (e === 'zstd' && isZstdSupported) {
      return zstdDecompressSync(buffer, ZSTD_FLUSH_OPTIONS);
    }
    return buffer;
  } catch (error) {
    if (error && typeof error === 'object') (error as any)[DECODE_ERROR] = true;
    throw error;
  }
}

/**
 * True when `decompressBuffer`/`decompressStream` above actually decode
 * `encoding` (case-insensitive/whitespace-trimmed, matching axios' own
 * `.toLowerCase()` header read) - used by `toAxiosLikeResponse`
 * (`axios-response.adapter.ts`) to decide whether to delete a decoded
 * `Content-Encoding` response header, matching axios exactly (`lib/adapters
 * /http.js`'s per-case `delete res.headers['content-encoding']`: unconditional
 * for `gzip`/`x-gzip`/`compress`/`x-compress`/`deflate`, gated on
 * `isBrotliSupported`/`isZstdSupported` for `br`/`zstd` - never for an
 * encoding it doesn't recognize at all, and never with `decompress: false`,
 * which the caller checks separately).
 */
export function isDecodableEncoding(encoding: string): boolean {
  const e = normalizeEncoding(encoding);
  return (
    GZIP_ENCODINGS.has(e) ||
    e === 'deflate' ||
    e === 'br' ||
    (e === 'zstd' && isZstdSupported)
  );
}

/**
 * Pipes a response body stream through the matching zlib decompressor, with
 * bidirectional destroy propagation so the raw (undici) body/socket is never
 * left dangling once the decompressed side stops being read:
 *
 * - if `body` errors, the decompressor is destroyed with the same error;
 * - if the decompressor is destroyed or errors - whether by a caller's own
 *   `.destroy()` on the stream this function returns (a `responseType:
 *   'stream'` consumer that stops reading early), or by `axios-response
 *   .adapter.ts`'s `guardStreamMaxContentLength` throwing inside a `for
 *   await` loop over it (which destroys it via the async iterator
 *   protocol's own `return()` call on early exit) - `body` is destroyed too.
 *
 * `.pipe()`'s own forwarding is one-directional (source -> destination
 * only, and only for data, never destruction in either direction - see the
 * Node docs' own caveat on `Readable#pipe`), so without this, the upstream
 * stream would otherwise keep flowing under backpressure - a real,
 * DoS-relevant socket leak - until the producer itself notices nobody's
 * reading: checked against a real server, an oversized gzip'd body left the
 * connection open well past 2s where the uncompressed equivalent (which
 * never goes through this function - see `readBodyAsResponseType`'s stream
 * branch) closed in under 0.5s. `readDecompressedBufferWithLimit`'s own
 * explicit `destroy()` calls on both streams (below) still fire too; they're
 * synchronous and race harmlessly against this function's listeners (both
 * check `!stream.destroyed` first), so nothing double-destroys.
 *
 * Also tags a genuine decode failure with `DECODE_ERROR` (see its own doc
 * comment): the decompressor's `'error'` event fires for two different
 * reasons - its own internal decode failure (corrupt/wrong-format input),
 * or `body` erroring first (a network-level failure, forwarded here purely
 * so the decompressor itself gets cleaned up too) - and only the first one
 * is an actual decode error. `bodyErroredFirst` distinguishes them: it's set
 * (synchronously, before the forwarding `.destroy()` call below ever runs)
 * the moment `body` itself errors, so by the time the decompressor's own
 * `'error'` listener runs, it can tell whether this is that same,
 * already-network-attributed failure arriving secondhand.
 */
export function decompressStream(body: Readable, encoding: string): Readable {
  const e = normalizeEncoding(encoding);
  let decompressor: NodeJS.ReadWriteStream & {
    destroyed?: boolean;
    destroy(error?: Error): void;
  };
  if (GZIP_ENCODINGS.has(e)) decompressor = createGunzip(GZIP_FLUSH_OPTIONS);
  else if (e === 'br')
    decompressor = createBrotliDecompress(BROTLI_FLUSH_OPTIONS);
  else if (e === 'deflate') decompressor = createInflate(GZIP_FLUSH_OPTIONS);
  else if (e === 'zstd' && isZstdSupported)
    decompressor = createZstdDecompress(ZSTD_FLUSH_OPTIONS);
  else return body;

  body.pipe(decompressor);
  let bodyErroredFirst = false;
  const destroyBody = (err?: Error): void => {
    if (!body.destroyed) body.destroy(err);
  };
  const destroyDecompressor = (err?: Error): void => {
    bodyErroredFirst = true;
    if (!decompressor.destroyed) decompressor.destroy(err);
  };
  body.once('error', destroyDecompressor);
  decompressor.once('error', (err?: any) => {
    if (!bodyErroredFirst && err && typeof err === 'object') {
      err[DECODE_ERROR] = true;
    }
    destroyBody(err);
  });
  decompressor.once('close', destroyBody);
  return decompressor as unknown as Readable;
}

/** True when a `maxContentLength` is actually set (matches `assertMaxContentLength`/`readBufferWithLimit`'s own guard: 0/`undefined`/`-1` all mean "no limit"). */
export function hasContentLengthLimit(maxContentLength?: number): boolean {
  return !!maxContentLength && maxContentLength > -1;
}

/**
 * Streams a compressed body through the matching zlib decompressor,
 * enforcing `maxContentLength` on the DECOMPRESSED bytes as they arrive -
 * matching axios 1.20 (`lib/adapters/http.js`'s streamed `maxContentLength`
 * enforcement, applied to the decompression pipeline's own output) - so a
 * small, highly compressible body (a "gzip bomb") can't blow memory up fully
 * decompressing before the limit is ever checked. Both the compressed body
 * stream and the decompression stream are destroyed the moment the limit is
 * crossed (rather than relying only on `for await`'s own `return()` call on
 * an abrupt completion, which unpipes/destroys the decompression stream but
 * never its `.pipe()` source - so the compressed body/socket would otherwise
 * keep flowing until the producer itself notices nobody's reading), with the
 * same `ERR_BAD_RESPONSE` error `readBufferWithLimit` throws for the
 * uncompressed case.
 *
 * Only called when a limit is actually set (see `readBuffer`/`readText`):
 * decompressing a *compressed* body this way measures slower than
 * `decompressBuffer`'s single sync call for a normal, unlimited body, so the
 * common case keeps using that instead.
 */
async function readDecompressedBufferWithLimit(
  body: Readable,
  encoding: string,
  maxContentLength: number,
): Promise<Buffer> {
  const decompressed = decompressStream(body, encoding);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of decompressed) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxContentLength) {
      const error: any = new Error(
        `maxContentLength size of ${maxContentLength} exceeded`,
      );
      error.code = 'ERR_BAD_RESPONSE';
      decompressed.destroy(error);
      body.destroy(error);
      throw error;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

const BOM = 0xfeff;

/** axios' `stripBOM`: drops a leading UTF-8 BOM character. */
function stripBOM(text: string): string {
  return text.charCodeAt(0) === BOM ? text.slice(1) : text;
}

export interface BodyDecodeOptions {
  maxContentLength?: number;
  /** The response's `Content-Encoding` header, when present. */
  contentEncoding?: string;
  /** `false` disables decompression, as in axios. Default: decompress. */
  decompress?: boolean;
  /** axios' `parseReviver`, forwarded to every default `JSON.parse` call. */
  parseReviver?: JsonReviver;
  /**
   * axios' `transitional.silentJSONParsing === false` (see
   * `parseJsonStrict`'s doc comment): only ever read by
   * `readBodyAsResponseType`'s `responseType === 'json'` branch - `undefined`/
   * `false` (the default) costs nothing beyond this one property read.
   */
  strictJsonParsing?: boolean;
}

function shouldDecompress(options: BodyDecodeOptions): boolean {
  return !!options.contentEncoding && options.decompress !== false;
}

async function readBuffer(
  body: Dispatcher.ResponseData['body'],
  options: BodyDecodeOptions,
): Promise<Buffer> {
  // `maxContentLength` applies to the *decoded* bytes, as in axios. When a
  // limit is actually set, the decompression itself is streamed and the
  // limit enforced on the decompressed bytes as they arrive
  // (`readDecompressedBufferWithLimit`), so a gzip bomb can't fully
  // decompress in memory before being rejected. The common, unlimited case
  // keeps buffering the (usually much smaller) compressed body fully first
  // and decompressing it in one synchronous call - measurably faster than
  // streaming through zlib for a normal-sized body.
  if (shouldDecompress(options)) {
    if (hasContentLengthLimit(options.maxContentLength)) {
      return readDecompressedBufferWithLimit(
        body as unknown as Readable,
        options.contentEncoding!,
        options.maxContentLength!,
      );
    }
    return decompressBuffer(
      Buffer.from(await bodyArrayBuffer(body)),
      options.contentEncoding!,
    );
  }
  return readBufferWithLimit(body, options.maxContentLength);
}

/**
 * Reads the body as a UTF-8 string. When nothing needs decompressing or
 * limiting this defers to undici's own `.text()` (which already strips a
 * BOM), so the common, unlimited/uncompressed path costs nothing extra.
 */
export async function readText(
  body: Dispatcher.ResponseData['body'],
  options: BodyDecodeOptions,
): Promise<string> {
  if (shouldDecompress(options)) {
    // Same split as `readBuffer`: stream-and-enforce only when a limit is
    // actually set, otherwise the fast, fully-buffered sync decompress.
    if (hasContentLengthLimit(options.maxContentLength)) {
      const buffer = await readDecompressedBufferWithLimit(
        body as unknown as Readable,
        options.contentEncoding!,
        options.maxContentLength!,
      );
      return stripBOM(buffer.toString('utf8'));
    }
    const buffer = decompressBuffer(
      Buffer.from(await bodyArrayBuffer(body)),
      options.contentEncoding!,
    );
    return stripBOM(buffer.toString('utf8'));
  }
  if (!options.maxContentLength || options.maxContentLength <= -1) {
    return bodyText(body);
  }
  const buffer = await readBufferWithLimit(body, options.maxContentLength);
  return stripBOM(buffer.toString('utf8'));
}

// ---------------------------------------------------------------------------
// Default (no explicit `responseType`) body decoding
// ---------------------------------------------------------------------------

/**
 * Decodes a response body the way axios does when no `responseType` is set:
 * JSON (`application/json` and any `+json` suffix) is always parsed;
 * everything text-decodable (see `classifyContentType`) is decoded to a
 * UTF-8 string and JSON-parsed only when it looks like JSON
 * (`forcedJSONParsing` gated on the first character, `silentJSONParsing` on
 * failure); anything else stays a Buffer.
 */
export async function readDefaultBody(
  body: Dispatcher.ResponseData['body'],
  contentType: string,
  options: BodyDecodeOptions,
): Promise<any> {
  const kind = classifyContentType(contentType);

  if (kind === 'binary') {
    const buffer = await readBuffer(body, options);
    assertMaxContentLength(buffer.byteLength, options.maxContentLength);
    return buffer;
  }

  const text = await readText(body, options);
  if (options.maxContentLength) {
    assertMaxContentLength(Buffer.byteLength(text), options.maxContentLength);
  }
  return kind === 'json'
    ? parseJsonOrText(text, options.parseReviver)
    : parseTextMaybeJson(text, options.parseReviver);
}

// ---------------------------------------------------------------------------
// Explicit `responseType` body decoding
// ---------------------------------------------------------------------------

/**
 * Reads an undici response body according to an explicit axios
 * `responseType`:
 * - `stream`: the (optionally decompressed) undici body, a Node.js Readable
 * - `arraybuffer`: a Buffer (what axios returns in Node.js)
 * - `blob`/`text`/`document`: a UTF-8 string, never JSON-parsed (what axios
 *   returns for `blob` in Node.js, which has no native Blob decoding there)
 * - `json`: JSON-parsed regardless of Content-Type, raw string if invalid
 */
export async function readBodyAsResponseType(
  body: Dispatcher.ResponseData['body'],
  responseType: AxiosResponseType,
  maxContentLength?: number,
  decodeOptions?: Omit<BodyDecodeOptions, 'maxContentLength'>,
): Promise<any> {
  const options: BodyDecodeOptions = { maxContentLength, ...decodeOptions };

  if (responseType === 'stream') {
    return shouldDecompress(options)
      ? decompressStream(body, options.contentEncoding!)
      : body;
  }

  if (responseType === 'arraybuffer') {
    const buffer = await readBuffer(body, options);
    assertMaxContentLength(buffer.byteLength, maxContentLength);
    return buffer;
  }

  const text = await readText(body, options);
  if (maxContentLength) {
    assertMaxContentLength(Buffer.byteLength(text), maxContentLength);
  }
  if (responseType !== 'json') return text;
  return options.strictJsonParsing
    ? parseJsonStrict(text, options.parseReviver)
    : parseJsonOrText(text, options.parseReviver);
}
