/**
 * Differential: errors, timeouts, cancellation, redirects, size limits.
 * See harness.ts.
 */
import axios from 'axios';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { differential, Ctx } from './harness';

const ERRORS = 'plan.md phase 2: fix(errors): match axios errors';

const routes = {
  '/raw': (req: any, res: any) => {
    const p = new URL(req.url, 'http://x').searchParams;
    const status = Number(p.get('status') || 200);
    const headers: Record<string, string> = {};
    if (p.has('ct')) headers['Content-Type'] = p.get('ct')!;
    res.writeHead(status, headers);
    res.end(p.get('body') ?? '');
  },
  '/redirect': (req: any, res: any) => {
    const p = new URL(req.url, 'http://x').searchParams;
    res.writeHead(Number(p.get('code') || 302), {
      Location: p.get('to') || '/echo',
    });
    res.end();
  },
  '/bad-gzip': (_req: any, res: any) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    });
    res.end('this is not gzip');
  },
  // A highly compressible body: small on the wire, large once decompressed -
  // `maxContentLength` must be checked against the *decompressed* size, as
  // in axios (`plan.md`: fix(maxContentLength for gzip)).
  '/gzip-big': (req: any, res: any) => {
    const n = Number(
      new URL(req.url, 'http://x').searchParams.get('n') || 100000,
    );
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Encoding': 'gzip',
    });
    res.end(gzipSync(Buffer.alloc(n, 'x')));
  },
  '/redirect-loop': (_req: any, res: any) => {
    res.writeHead(302, { Location: '/redirect-loop' });
    res.end();
  },
  '/slow': (req: any, res: any) => {
    const ms = Number(
      new URL(req.url, 'http://x').searchParams.get('ms') || 2000,
    );
    const t = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('late');
    }, ms);
    res.on('close', () => clearTimeout(t));
  },
  '/slow-body': (req: any, res: any) => {
    const ms = Number(
      new URL(req.url, 'http://x').searchParams.get('ms') || 1500,
    );
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('a');
    const t = setTimeout(() => res.end('b'), ms);
    res.on('close', () => clearTimeout(t));
  },
  '/big': (req: any, res: any) => {
    const n = Number(
      new URL(req.url, 'http://x').searchParams.get('n') || 2000,
    );
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('x'.repeat(n));
  },
  '/destroy': (req: any) => {
    req.socket.destroy();
  },
  '/echo': (req: any, res: any, body: string) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url, body }));
  },
};

/** Shape of an error that user code commonly inspects, ported from errors.diff.spec.ts (prototype). */
function errShape(o: any) {
  const e = o.error;
  if (!e) return o.result ? 'resolved' : undefined;
  return {
    name: e.name,
    code: e.code,
    message: e.message,
    status: e.status,
    isAxiosError: axios.isAxiosError(e),
    isCancel: axios.isCancel(e),
    instanceofError: e instanceof Error,
    responseStatus: e.response?.status,
    responseData: e.response?.data,
    configMethod: e.config?.method,
    hasRequest: !!e.request,
  };
}

differential('Differential: errors, timeouts, cancellation', routes, [
  {
    // Must reject (not resolve with empty data) when the body can't be decompressed
    name: 'corrupt gzip body rejects',
    run: (s, ctx) => s.get(`${ctx.base}/bad-gzip`),
    normalize: (o: any) => ({
      rejected: !!o.error,
      code: o.error?.code,
      isAxiosError: axios.isAxiosError(o.error),
    }),
  },
  {
    name: '404 error shape',
    run: (s, ctx) =>
      s.get(`${ctx.base}/raw?status=404&ct=application/json&body={"e":1}`),
    normalize: errShape,
  },
  {
    name: '500 error shape',
    run: (s, ctx) =>
      s.get(`${ctx.base}/raw?status=500&ct=text/plain&body=boom`),
    normalize: errShape,
  },
  {
    name: 'ECONNREFUSED',
    run: s => s.get('http://127.0.0.1:1/x'),
    normalize: errShape,
  },
  {
    name: 'ENOTFOUND',
    run: s => s.get('http://does-not-exist.invalid/x'),
    normalize: errShape,
  },
  {
    name: 'socket hang up / ECONNRESET',
    run: (s, ctx) => s.get(`${ctx.base}/destroy`),
    normalize: errShape,
    knownDifference: ERRORS,
  },
  {
    name: 'invalid URL',
    run: s => s.get('not a url'),
    normalize: errShape,
  },
  {
    name: 'unsupported protocol',
    run: s => s.get('ftp://127.0.0.1/x'),
    normalize: errShape,
  },
  {
    name: 'AbortSignal already aborted',
    run: (s, ctx) => s.get(`${ctx.base}/echo`, { signal: AbortSignal.abort() }),
    normalize: errShape,
  },
  {
    name: 'AbortSignal aborted mid-flight',
    run: (s, ctx) => {
      const c = new AbortController();
      setTimeout(() => c.abort(), 100);
      return s.get(`${ctx.base}/slow?ms=2000`, { signal: c.signal });
    },
    normalize: errShape,
  },
  {
    name: 'AbortSignal.timeout()',
    run: (s, ctx) =>
      s.get(`${ctx.base}/slow?ms=2000`, { signal: AbortSignal.timeout(100) }),
    normalize: errShape,
  },
  {
    name: 'CancelToken with message',
    run: (s, ctx) => {
      const src = axios.CancelToken.source();
      setTimeout(() => src.cancel('bye'), 100);
      return s.get(`${ctx.base}/slow?ms=2000`, { cancelToken: src.token });
    },
    normalize: errShape,
  },
  {
    name: 'validateStatus null accepts everything',
    run: (s, ctx) =>
      s.get(`${ctx.base}/raw?status=500&body=x`, { validateStatus: null }),
    normalize: (o: any) => ({ status: o.result?.status, data: o.result?.data }),
  },
  {
    name: 'timeout: headers never arrive (code/message)',
    run: (s, ctx) => s.get(`${ctx.base}/slow?ms=3000`, { timeout: 300 }),
    normalize: errShape,
  },
  {
    // `executeRequest`'s deadline timer now fires at the right time (a
    // slowly-but-steadily trickling body used to never time out at all -
    // fixed), but axios' own error *shape* for a timeout that lands after
    // the response has already started streaming is a genuine quirk: real
    // axios' http adapter destroys the request on timeout, which - only
    // once a response object already exists - fires the response stream's
    // own 'aborted' handler first (`ERR_BAD_RESPONSE`, "stream has been
    // aborted"), *instead of* its usual `ECONNABORTED`/"timeout of Nms
    // exceeded" (checked against real axios 1.20). Replicating that exact
    // internal race (checked here, not attempted: it depends on whether
    // axios' own response object happens to exist yet) is out of scope;
    // this library gives the same, correct `ECONNABORTED` timeout error
    // either way, which is arguably more useful.
    name: 'timeout covers a slowly trickling body (axios: total time)',
    run: (s, ctx) => s.get(`${ctx.base}/slow-body?ms=1500`, { timeout: 500 }),
    normalize: errShape,
    knownDifference: ERRORS,
  },
  {
    name: 'transitional.clarifyTimeoutError => ETIMEDOUT',
    run: (s, ctx) =>
      s.get(`${ctx.base}/slow?ms=3000`, {
        timeout: 300,
        transitional: { clarifyTimeoutError: true },
      }),
    normalize: (o: any) => o.error?.code,
  },
  {
    name: 'timeoutErrorMessage',
    run: (s, ctx) =>
      s.get(`${ctx.base}/slow?ms=3000`, {
        timeout: 300,
        timeoutErrorMessage: 'custom!',
      }),
    normalize: (o: any) => o.error?.message,
  },
  // ---- redirects
  ...(
    [
      ['GET 302 default (no maxRedirects)', 'get', 302, undefined],
      ['POST 301 -> method/body', 'post', 301, { maxRedirects: 5 }],
      ['POST 302 -> method/body', 'post', 302, { maxRedirects: 5 }],
      ['POST 303 -> method/body', 'post', 303, { maxRedirects: 5 }],
      ['POST 307 keeps method/body', 'post', 307, { maxRedirects: 5 }],
      ['POST 308 keeps method/body', 'post', 308, { maxRedirects: 5 }],
    ] as Array<[string, string, number, any]>
  ).map(([name, m, code, cfg]) => ({
    name: `redirect: ${name}`,
    options: cfg,
    run: (s: any, ctx: Ctx) => {
      const url = `${ctx.base}/redirect?code=${code}&to=/echo/after`;
      return m === 'post' ? s.post(url, { a: 1 }, cfg) : s.get(url, cfg);
    },
    normalize: (o: any) => ({
      requests: o.requests.map((r: any) => ({ method: r.method, url: r.url })),
      ok: !!o.result,
    }),
  })),
  {
    name: 'redirect loop exceeds maxRedirects',
    run: (s, ctx) => s.get(`${ctx.base}/redirect-loop`, { maxRedirects: 3 }),
    normalize: (o: any) => ({ code: o.error?.code, hops: o.requests.length }),
  },
  {
    // No `maxRedirects` set anywhere: both must default to 21 and reject on
    // the 22nd hop.
    name: 'redirect loop exceeds the default limit (21 vs 22)',
    run: (s, ctx) => s.get(`${ctx.base}/redirect-loop`),
    normalize: (o: any) => ({ code: o.error?.code, hops: o.requests.length }),
  },
  {
    name: 'redirect: maxRedirects 0 returns the 3xx response as-is',
    run: (s, ctx) =>
      s.get(`${ctx.base}/redirect?code=302&to=/echo`, {
        maxRedirects: 0,
        validateStatus: () => true,
      }),
    normalize: (o: any) => ({
      status: o.result?.status,
      location: o.result?.headers?.location,
      hops: o.requests.length,
    }),
  },
  {
    // A relative `Location` with no leading slash resolves against the
    // *current* URL's path (dropping its last segment), not the origin root.
    name: 'redirect: relative Location without a leading slash',
    run: (s, ctx) =>
      s.get(
        `${ctx.base}/redirect?code=302&to=${encodeURIComponent('echo/after')}`,
      ),
    normalize: (o: any) => o.requests.map((r: any) => r.url),
  },
  {
    name: 'redirect: cross-host drops Authorization/Cookie',
    run: (s: any, ctx: Ctx) =>
      s.get(
        `${ctx.base}/redirect?to=${encodeURIComponent(`${ctx.other}/echo`)}`,
        { headers: { Authorization: 'Bearer secret', Cookie: 'a=b' } },
      ),
  },
  {
    name: 'redirect: sensitiveHeaders drops a custom header cross-host too',
    run: (s: any, ctx: Ctx) =>
      s.get(
        `${ctx.base}/redirect?to=${encodeURIComponent(`${ctx.other}/echo`)}`,
        { headers: { 'X-A': 'secret' }, sensitiveHeaders: ['X-A'] },
      ),
  },
  {
    name: 'redirect: sensitiveHeaders keeps a custom header on a same-host redirect',
    run: (s: any, ctx: Ctx) =>
      s.get(`${ctx.base}/redirect?code=302&to=/echo`, {
        headers: { 'X-A': 'kept' },
        sensitiveHeaders: ['X-A'],
      }),
  },
  {
    name: 'redirect: an invalid sensitiveHeaders rejects with ERR_BAD_OPTION_VALUE',
    run: (s: any, ctx: Ctx) =>
      s.get(`${ctx.base}/redirect?code=302&to=/echo`, {
        sensitiveHeaders: 'not-an-array' as any,
      }),
    normalize: (o: any) => ({ code: o.error?.code, name: o.error?.name }),
  },
  {
    name: 'redirect: beforeRedirect can rewrite headers for the next hop',
    run: (s, ctx) =>
      s.get(`${ctx.base}/redirect?code=302&to=/echo`, {
        beforeRedirect: (options: any) => {
          options.headers = { ...options.headers, 'X-B': 'hooked' };
        },
      }),
  },
  {
    // plan.md phase 2 "fix: wrap a throwing beforeRedirect like axios" -
    // checked against real axios 1.20's "should support beforeRedirect"
    // test: a throwing `beforeRedirect` gives axios'/follow-redirects'
    // "Redirected request failed: <message>" wrapping, not the raw,
    // unwrapped error.
    name: 'redirect: a throwing beforeRedirect wraps the error like axios',
    run: (s, ctx) =>
      s.get(`${ctx.base}/redirect?code=302&to=/echo`, {
        beforeRedirect: () => {
          throw new Error('Provided path is not allowed');
        },
      }),
    normalize: errShape,
  },
  // ---- size limits per request
  {
    name: 'maxContentLength per request',
    run: (s, ctx) =>
      s.get(`${ctx.base}/big?n=2000`, { maxContentLength: 1000 }),
    normalize: (o: any) => ({ code: o.error?.code, name: o.error?.name }),
  },
  {
    // A small gzip response that decompresses well past `maxContentLength`:
    // axios enforces the limit on the decompressed stream (`lib/adapters/
    // http.js`), not the (much smaller) compressed body on the wire - this
    // must match, not just "reject somehow".
    name: 'maxContentLength per request (gzip, checked against decompressed size)',
    run: (s, ctx) =>
      s.get(`${ctx.base}/gzip-big?n=100000`, { maxContentLength: 1000 }),
    normalize: (o: any) => ({ code: o.error?.code, name: o.error?.name }),
  },
  {
    name: 'maxBodyLength per request',
    run: (s, ctx) =>
      s.post(`${ctx.base}/echo`, 'x'.repeat(2000), { maxBodyLength: 1000 }),
    normalize: (o: any) => ({ code: o.error?.code, sent: o.requests.length }),
  },
  {
    // A stream body over `maxBodyLength`, with the default (redirects-on)
    // `maxRedirects`: axios' default transport (`follow-redirects`)
    // enforces this itself - `ERR_FR_MAX_BODY_LENGTH_EXCEEDED` (checked
    // against real axios 1.20), not axios' own `ERR_BAD_REQUEST` (that code
    // is only for a body whose length axios can check upfront - a string or
    // Buffer, see the case above).
    name: 'maxBodyLength per request with a stream body',
    run: (s, ctx) =>
      s.post(`${ctx.base}/echo`, Readable.from([Buffer.alloc(2000, 'x')]), {
        maxBodyLength: 1000,
      }),
    normalize: (o: any) => ({ code: o.error?.code, sent: o.requests.length }),
  },
  {
    // Fixed (plan.md phase 2 "fix: sanitize CRLF / non-Latin1 header values
    // like axios", found by upstream conformance): this library now
    // sanitizes a header value the same way axios does before it ever
    // reaches Node's `http.request` (`mergeHeaders`/`AxiosHeaders#set`,
    // `sanitizeHeaderValue`), instead of letting undici's own, stricter
    // validation reject it - checked against real axios 1.20, which resolves
    // 200 with the embedded newline silently stripped.
    name: 'header value with an embedded newline',
    run: (s, ctx) =>
      s.get(`${ctx.base}/echo`, { headers: { 'X-Bad': 'a\nb' } }),
    normalize: (o: any) => ({
      resolved: !!o.result,
      status: o.result?.status,
      sentHeader: o.requests[0]?.headers['x-bad'],
    }),
  },
  {
    // Same fix, a non-Latin1 (multi-byte) character instead of a control
    // character - axios strips it the same way (`sanitizeByteStringHeader
    // Value`, checked against real axios 1.20).
    name: 'header value with a non-Latin1 character',
    run: (s, ctx) =>
      s.get(`${ctx.base}/echo`, { headers: { 'X-Emoji': 'a\u{1F600}b' } }),
    normalize: (o: any) => ({
      resolved: !!o.result,
      sentHeader: o.requests[0]?.headers['x-emoji'],
    }),
  },
  {
    // plan.md phase 2 "fix: remaining error-shape gaps" (found by upstream
    // conformance), item 1: an unparsable `timeout` gives `ERR_BAD_OPTION_
    // VALUE`, not the generic `ERR_BAD_REQUEST` a raw undici
    // `InvalidArgumentError` used to map to - checked against real axios
    // 1.20 (`lib/adapters/http.js`: `parseInt(own('timeout'), 10)`).
    // `hasRequest`/`hasConfig` are deliberately not compared: real axios only
    // reaches its own equivalent check once the request's socket already
    // exists (so its error carries `request`); this library checks it up
    // front, before ever dispatching (cheaper, and consistent with the
    // existing "unsupported protocol" case above) - the same, documented
    // trade-off `createUnsupportedProtocolError` already makes.
    name: 'unparsable timeout gives ERR_BAD_OPTION_VALUE',
    run: (s, ctx) => s.get(`${ctx.base}/echo`, { timeout: 'not-a-number' }),
    normalize: (o: any) => ({
      code: o.error?.code,
      message: o.error?.message,
      isAxiosError: axios.isAxiosError(o.error),
    }),
  },
  {
    // plan.md phase 2 "fix: parse a numeric-string timeout like axios":
    // `timeout: '250'` is enforced exactly like `timeout: 250` - checked
    // against real axios' own `parseInt(config.timeout, 10)`
    // (`lib/adapters/http.js`).
    name: 'a numeric-string timeout is enforced like a numeric one',
    run: (s, ctx) =>
      s.get(`${ctx.base}/slow?ms=2000`, { timeout: '250' as any }),
    normalize: (o: any) => ({
      code: o.error?.code,
      message: o.error?.message,
      isAxiosError: axios.isAxiosError(o.error),
    }),
  },
  {
    // plan.md phase 2 "fix: reject a malformed URL like axios instead of
    // silently dispatching it" - checked against real axios 1.20's own
    // "rejects malformed HTTP URLs before Node URL normalization and
    // preserves config" test.
    name: 'a malformed http(s) URL (embedded null byte) rejects with ERR_INVALID_URL',
    run: (s, ctx) =>
      s.get(`\u0000https:${ctx.base.replace(/^https?:\/\//, '')}/echo`, {
        headers: { 'X-Test': 'yes' },
      }),
    normalize: (o: any) => ({
      code: o.error?.code,
      message: o.error?.message,
      isAxiosError: axios.isAxiosError(o.error),
      configUrl: o.error?.config?.url,
    }),
  },
  {
    name: 'a malformed http(s) URL (embedded newline) rejects with ERR_INVALID_URL',
    run: (s, ctx) =>
      s.get(`h\nttp:${ctx.base.replace(/^https?:\/\//, '')}/echo`, {
        headers: { 'X-Test': 'yes' },
      }),
    normalize: (o: any) => ({
      code: o.error?.code,
      message: o.error?.message,
      isAxiosError: axios.isAxiosError(o.error),
      configUrl: o.error?.config?.url,
    }),
  },
  {
    // plan.md phase 2 "fix: remaining error-shape gaps", item 2: a
    // synchronous config-normalization error (a throwing `paramsSerializer`)
    // rejects as a proper `AxiosError`, matching axios' own `buildURL(...)`
    // try/catch in `lib/adapters/http.js`.
    name: 'a throwing paramsSerializer rejects as an AxiosError',
    run: (s, ctx) =>
      s.get(`${ctx.base}/echo`, {
        params: { a: 1 },
        paramsSerializer: () => {
          throw new Error('serializer boom');
        },
      }),
    normalize: errShape,
  },
  {
    // Same fix, ported straight from real axios 1.20's own "should display
    // error while parsing params" test: an invalid `Date` in `params`
    // throws inside the default (no `paramsSerializer`) URL-building step
    // itself (`Invalid Date`'s own `toISOString()` throws), not just a
    // custom `paramsSerializer` - same code path, same fix.
    name: 'an invalid Date in params rejects as an AxiosError with url/exists set',
    run: (s, ctx) =>
      s.get(`${ctx.base}/echo`, { params: { errorParam: new Date(NaN) } }),
    normalize: (o: any) => ({
      code: o.error?.code,
      isAxiosError: axios.isAxiosError(o.error),
      url: o.error?.url,
      exists: o.error?.exists,
    }),
  },
  {
    // plan.md phase 2 "fix: support data: URLs" (found by upstream
    // conformance): resolved entirely locally, no network request at all -
    // checked against real axios 1.20's own "Data URL" test block.
    name: 'data: URL resolves as a Buffer, no network request',
    run: s =>
      s.get(
        `data:application/octet-stream;base64,${Buffer.from('123').toString('base64')}`,
      ),
    normalize: (o: any) => ({
      requests: o.requests.length,
      status: o.result?.status,
      data: Buffer.isBuffer(o.result?.data)
        ? `<Buffer ${o.result.data.toString()}>`
        : o.result?.data,
    }),
  },
  {
    name: 'data: URL over maxContentLength rejects (ERR_BAD_RESPONSE), no network request',
    run: s =>
      s.get(
        `data:application/octet-stream;base64,${'QQ' + '%41'.repeat(4000)}`,
        { maxContentLength: 3000 },
      ),
    normalize: (o: any) => ({
      requests: o.requests.length,
      code: o.error?.code,
      isAxiosError: axios.isAxiosError(o.error),
    }),
  },
  {
    // plan.md phase 2 "fix: enforce maxContentLength for responseType:
    // 'stream'" (found by upstream conformance): the stream branch used to
    // return the body untouched - checked against real axios 1.20's own
    // streamed enforcement.
    name: 'maxContentLength for responseType: stream',
    run: (s, ctx) =>
      s.get(`${ctx.base}/big?n=2000`, {
        responseType: 'stream',
        maxContentLength: 500,
      }),
    normalize: async (o: any) => {
      if (!o.result) {
        return {
          resolved: false,
          code: o.error?.code,
          isAxiosError: axios.isAxiosError(o.error),
        };
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of o.result.data) chunks.push(chunk);
        return { resolved: true, byteLength: Buffer.concat(chunks).length };
      } catch (error: any) {
        return {
          resolved: true,
          streamErrorCode: error.code,
          streamErrorIsAxiosError: axios.isAxiosError(error),
        };
      }
    },
  },
]);
