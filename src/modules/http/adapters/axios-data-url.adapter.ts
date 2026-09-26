import { Readable } from 'node:stream';
import type { UrlObject } from 'node:url';
import { AxiosError, createStatusError } from '../errors/axios-error';
import { resolveIsValidStatus } from './axios-response.adapter';
import { buildLazyAxiosConfig } from './axios-request.adapter';
import type { AxiosResponseType } from '../interfaces/axios-compatible.interface';
import type { AxiosLikeResponse } from '../interfaces/axios-compatible.interface';
import type { HttpInterceptorRequest } from '../interfaces/http-interceptor.interface';

/**
 * `data:` URL support (plan.md phase 2: "fix: support data: URLs"). Real
 * axios decodes a `data:` URL entirely locally - no network request at all -
 * matching axios 1.20's `lib/adapters/http.js` `data:` branch plus
 * `lib/helpers/fromDataURI.js` exactly (checked against real axios 1.20;
 * axios' own test suite: `tests/unit/adapters/http.test.js`'s "Data URL"
 * block). `HttpService.executeRequest` calls `dataUrlString`/
 * `resolveDataUrlRequest` before ever resolving a dispatcher or touching
 * undici - a `data:` URL costs nothing beyond that one string check on every
 * other (http/https) request.
 */

/** True (and the URL as a string) when `url` names a `data:` URL - checked case-insensitively, matching axios' own `parseProtocol`. Only a string or `URL` is supported (matches what axios' own test suite exercises); a `UrlObject` with `protocol: 'data:'` is vanishingly rare and not handled specially. */
export function dataUrlString(
  url: string | URL | UrlObject,
): string | undefined {
  if (typeof url === 'string') {
    return /^data:/i.test(url) ? url : undefined;
  }
  if (url instanceof URL) {
    return url.protocol.toLowerCase() === 'data:' ? url.toString() : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// `maxContentLength` for a `data:` URL: axios estimates the Buffer allocation
// Node's own base64 decoder would make *without* allocating it, so an
// oversized `data:` URL is rejected before ever decoding it - ported from
// axios 1.20's `lib/helpers/estimateDataURLDecodedBytes.js`
// (`estimateDataURLBufferAllocation`, the variant its own `http.js` adapter
// uses - not the percent-decoded `estimateDataURLDecodedBytes` fetch/xhr use,
// which this library's single, http-based adapter has no equivalent for).
// ---------------------------------------------------------------------------

const isHexDigit = (charCode: number): boolean =>
  (charCode >= 48 && charCode <= 57) ||
  (charCode >= 65 && charCode <= 70) ||
  (charCode >= 97 && charCode <= 102);

const isPercentEncodedByte = (str: string, i: number, len: number): boolean =>
  i + 2 < len &&
  isHexDigit(str.charCodeAt(i + 1)) &&
  isHexDigit(str.charCodeAt(i + 2));

/**
 * `Buffer.byteLength(body, 'base64')`'s own allocation bound: Node's base64
 * decoder sizes its backing buffer from the raw string length (minus
 * trailing `=` padding), even for input it will otherwise ignore or stop at
 * - matching axios' `estimateBase64BufferAllocation` exactly, so a
 * would-be-DoS `data:` URL (e.g. `TQ==` followed by megabytes of ignored
 * `%`-characters - see axios' own "should count ignored input after base64
 * padding toward the Buffer allocation limit" test) is still rejected by
 * its *allocation* size, not its actually-decoded size.
 */
function estimateBase64BufferAllocation(body: string): number {
  const len = body.length;
  let padding = 0;
  if (len > 0 && body.charCodeAt(len - 1) === 0x3d /* '=' */) {
    padding++;
    if (len > 1 && body.charCodeAt(len - 2) === 0x3d) {
      padding++;
    }
  }
  return Math.floor(((len - padding) * 3) / 4);
}

/**
 * The UTF-8 byte length `decodeURIComponent(body)` would produce, computed
 * directly from UTF-16 code units without allocating a byte buffer -
 * matching axios' own inline loop in `estimateDataURLBytes`.
 */
function estimatePercentDecodedUtf8Bytes(body: string): number {
  let bytes = 0;
  for (let i = 0, len = body.length; i < len; i++) {
    const c = body.charCodeAt(i);
    if (c === 0x25 /* '%' */ && isPercentEncodedByte(body, i, len)) {
      bytes += 1;
      i += 2;
    } else if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
      const next = body.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Estimates the Buffer allocation Node's base64 decoder (or, for a
 * non-base64 `data:` URL, `decodeURIComponent`) would use for `url`, without
 * actually decoding it - axios' `estimateDataURLBufferAllocation`. `url` must
 * already be known to start with `data:` (case-sensitively, matching axios'
 * own `url.startsWith('data:')` check exactly - see `dataUrlString`'s doc
 * comment for why this is checked case-insensitively one level up).
 */
export function estimateDataURLBufferAllocation(url: string): number {
  if (!url.startsWith('data:')) return 0;
  const comma = url.indexOf(',');
  if (comma < 0) return 0;
  const meta = url.slice(5, comma);
  const body = url.slice(comma + 1);
  return /;base64/i.test(meta)
    ? estimateBase64BufferAllocation(body)
    : estimatePercentDecodedUtf8Bytes(body);
}

// ---------------------------------------------------------------------------
// Decoding a `data:` URL's body - axios' `fromDataURI`
// ---------------------------------------------------------------------------

/** RFC 2397: `data:[<mediatype>][;base64],<data>` - axios' own `DATA_URL_PATTERN` (`lib/helpers/fromDataURI.js`). */
const DATA_URL_PATTERN =
  /^([^,;/]+\/[^,;/]+)?((?:;[^,;=]+=[^,;]+)*)(;base64)?,([\s\S]*)$/;

/**
 * Decodes a `data:` URL's body into the shape `responseType` asks for -
 * axios' `fromDataURI` plus the `data:` branch's own post-processing in
 * `http.js`, ported together since this library has only the one (http-based)
 * adapter: a Buffer by default/`arraybuffer`, a real `Blob` for `blob` (only
 * when the platform's global `Blob` exists, matching axios - `asBlob` is
 * only ever passed as `true` when `responseType === 'blob'`, so the
 * `asBlob === undefined` default-to-`true` branch in axios' own
 * `fromDataURI` never applies here), a UTF-8 string (BOM stripped) for
 * `text`/`document`, and a one-shot `Readable` for `stream`.
 */
function convertDataUrl(uri: string, responseType?: AxiosResponseType): any {
  const body = uri.slice('data:'.length);
  const match = DATA_URL_PATTERN.exec(body);
  if (!match) {
    throw new AxiosError('Invalid URL', AxiosError.ERR_INVALID_URL);
  }
  const type = match[1];
  const params = match[2];
  const isBase64 = !!match[3];
  const rawBody = match[4];

  // RFC 2397 section 3: default mediatype is text/plain;charset=US-ASCII.
  // Bare `data:,` leaves mime empty, matching axios.
  let mime = '';
  if (type) mime = params ? type + params : type;
  else if (params) mime = 'text/plain' + params;

  const buffer = isBase64
    ? Buffer.from(rawBody, 'base64')
    : Buffer.from(decodeURIComponent(rawBody), 'utf8');

  if (responseType === 'blob') {
    const BlobCtor = (globalThis as { Blob?: typeof Blob }).Blob;
    if (!BlobCtor) {
      throw new AxiosError('Blob is not supported', AxiosError.ERR_NOT_SUPPORT);
    }
    return new BlobCtor([buffer], { type: mime });
  }
  if (responseType === 'text' || responseType === 'document') {
    const text = buffer.toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
  if (responseType === 'stream') {
    return Readable.from(buffer);
  }
  return buffer;
}

/**
 * Resolves a `data:` URL request entirely locally, the way axios does: no
 * network request, `maxContentLength` checked against the *allocation*
 * estimate above, a non-GET method resolving a synthetic `405` (then
 * subject to the same `validateStatus` as any other response, exactly like
 * axios' own `settle()`), and the decoded body shaped per `responseType` -
 * see `convertDataUrl`. Called from `HttpService.executeRequest` in place of
 * ever calling undici's `request()`.
 */
export async function resolveDataUrlRequest(
  request: HttpInterceptorRequest,
  uri: string,
): Promise<AxiosLikeResponse> {
  const options: Record<string, any> = request.options || {};
  const maxContentLength = options.maxContentLength as number | undefined;

  // "Apply the same semantics as HTTP: only enforce if a finite,
  // non-negative cap is set" - axios' own comment, `lib/adapters/http.js`.
  if (maxContentLength !== undefined && maxContentLength > -1) {
    const estimated = estimateDataURLBufferAllocation(uri);
    if (estimated > maxContentLength) {
      const error = new AxiosError(
        `maxContentLength size of ${maxContentLength} exceeded`,
        AxiosError.ERR_BAD_RESPONSE,
      );
      error._setLazyConfig(request);
      throw error;
    }
  }

  const respond = (
    status: number,
    statusText: string,
    data: any,
  ): AxiosLikeResponse => ({
    data,
    status,
    statusText,
    headers: {},
    config: buildLazyAxiosConfig(request) as any,
    // axios never sets `response.request` for a `data:` URL either (no real
    // request object was ever created) - matched deliberately.
    request: undefined,
  });

  const method = String(options.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    const response = respond(405, 'method not allowed', undefined);
    if (!resolveIsValidStatus(options, 405)) {
      throw createStatusError(response, request);
    }
    return response;
  }

  let data: any;
  try {
    data = convertDataUrl(uri, options.responseType as AxiosResponseType);
  } catch (err) {
    const error = AxiosError.from(err, AxiosError.ERR_BAD_REQUEST);
    error._setLazyConfig(request);
    throw error;
  }

  return respond(200, 'OK', data);
}
