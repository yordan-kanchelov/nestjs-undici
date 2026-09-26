/**
 * Differential: request serialization (body encoding, default headers,
 * header values, auth) and URL/params building. See harness.ts.
 */
import NodeFormData from 'form-data';
import { Readable } from 'node:stream';
import { differential, Ctx } from './harness';

const routes = {
  '/echo': (req: any, res: any, body: string) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      }),
    );
  },
};

const echo = (ctx: Ctx) => `${ctx.base}/echo`;

/** What the server saw for the last request the case made. */
const lastRequest = (o: any) => o.requests[o.requests.length - 1];

// Both differ from axios by design, so only presence/overridability is
// compared here, not the exact string (see docs/axios-supported-options.md):
// - `user-agent`: axios sends `axios/<version>`, this library
//   `nestjs-axios-undici/<version>`.
// - `accept-encoding`: this library doesn't advertise `compress` (an old LZW
//   scheme neither it nor axios can decode), so the value is one token
//   shorter than axios'.
const PRESENCE_ONLY = new Set(['user-agent', 'accept-encoding']);
const pick = (h: Record<string, any>, names: string[]) =>
  Object.fromEntries(
    names
      .filter(n => h[n] !== undefined)
      .map(n => [n, PRESENCE_ONLY.has(n) ? true : h[n]]),
  );

const serverView = (names: string[]) => (o: any) => {
  const r = lastRequest(o);
  return (
    r && {
      method: r.method,
      url: r.url,
      headers: pick(r.headers, names),
      body: r.body,
    }
  );
};

const SERVER_HEADERS = [
  'content-type',
  'content-length',
  'transfer-encoding',
  'authorization',
];
const ALL_DEFAULT_HEADERS = [
  'accept',
  'user-agent',
  'accept-encoding',
  'content-type',
  'content-length',
];

const bodyCases: Array<[string, () => any, any?]> = [
  ['object', () => ({ a: 1, b: [1, 2], d: new Date(0) })],
  ['array', () => [1, 2]],
  ['string', () => 'plain'],
  [
    'json string w/ json ct',
    () => '{"a":1}',
    { headers: { 'Content-Type': 'application/json' } },
  ],
  [
    'object w/ urlencoded ct',
    () => ({ a: 1, n: { b: 2 }, arr: [1, 2] }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  ],
  [
    'object w/ text/plain ct',
    () => ({ a: 1 }),
    { headers: { 'Content-Type': 'text/plain' } },
  ],
  ['URLSearchParams', () => new URLSearchParams({ a: '1', b: 'x y' })],
  ['Buffer', () => Buffer.from('buf')],
  ['Uint8Array', () => new Uint8Array([104, 105])],
  ['ArrayBuffer', () => new Uint8Array([104, 105]).buffer],
  [
    'Readable stream',
    () => Readable.from([Buffer.from('st'), Buffer.from('ream')]),
  ],
  ['number 0', () => 0],
  ['number 5', () => 5],
  ['boolean true', () => true],
  ['null', () => null],
  ['undefined', () => undefined],
  ['empty string', () => ''],
  ['empty object', () => ({})],
  ['Blob', () => new Blob(['blob'], { type: 'text/x-blob' })],
];

const ERRORS = 'plan.md phase 2: fix(errors): match axios errors';

// axios rejects some non-plain-object bodies (number, boolean) with a config
// TypeError; this library's dispatcher forwards them as-is, so what the server
// sees on the wire differs. A POST with no body/a Blob body also gets a
// default Content-Type here that axios doesn't send / doesn't preserve.
const bodyKnownDifference = new Map<string, string>([
  ['number 5', ERRORS],
  ['boolean true', ERRORS],
]);

const paramsCases: Array<[string, any, any?]> = [
  ['array', { a: [1, 2] }],
  ['nested', { a: { b: { c: 1 } } }],
  ['array of objects', { a: [{ b: 1 }, { b: 2 }] }],
  ['date', { d: new Date(0) }],
  ['null/undefined', { n: null, u: undefined, z: 0, f: false, e: '' }],
  ['special chars', { q: 'a b&c=d/é:$,@[]*' }],
  ['URLSearchParams', new URLSearchParams({ a: '1 2', b: 'x' })],
  ['indexes true', { a: [1, 2] }, { paramsSerializer: { indexes: true } }],
  ['indexes null', { a: [1, 2] }, { paramsSerializer: { indexes: null } }],
  [
    'serializer fn',
    { a: 1 },
    { paramsSerializer: (x: any) => `custom=${x.a}` },
  ],
  ['dots', { a: { b: 1 } }, { paramsSerializer: { dots: true } }],
  ['key with brackets', { 'a[]': [1, 2] }],
];

const joinCases: Array<[string, string, string]> = [
  ['base no slash + rel no slash', '/api', 'users'],
  ['base slash + rel slash', '/api/', '/users'],
  ['base with query', '/api?k=1', 'users'],
  ['empty url', '/api', ''],
  ['url with query', '/api', 'users?x=1'],
  ['url dot segments', '/api/v1', '../v2/users'],
  ['url with double slash path', '/api', '//evil/users'],
];

differential('Differential: request serialization', routes, [
  ...bodyCases.map(([name, make, cfg]) => ({
    name: `POST body: ${name}`,
    run: (s: any, ctx: Ctx) => s.post(echo(ctx), make(), cfg),
    normalize: serverView(SERVER_HEADERS),
    knownDifference: bodyKnownDifference.get(name),
  })),
  {
    name: 'POST global FormData',
    run: (s, ctx) =>
      s.post(
        echo(ctx),
        (() => {
          const f = new FormData();
          f.append('a', '1');
          f.append('file', new Blob(['hi'], { type: 'text/plain' }), 'x.txt');
          return f;
        })(),
      ),
    normalize: (o: any) => {
      const r = lastRequest(o);
      return {
        ct: String(r?.headers['content-type']).split(';')[0],
        hasFile: r?.body.includes('filename="x.txt"'),
      };
    },
  },
  {
    name: 'POST form-data package',
    run: (s, ctx) =>
      s.post(
        echo(ctx),
        (() => {
          const f = new NodeFormData();
          f.append('a', '1');
          return f;
        })(),
      ),
    normalize: (o: any) => {
      const r = lastRequest(o);
      return {
        ct: String(r?.headers['content-type']).split(';')[0],
        cl: !!r?.headers['content-length'],
        te: r?.headers['transfer-encoding'],
      };
    },
  },
  {
    // Fixed by plan.md phase 2 "feat(axiosRef): make it a real axios
    // instance": postForm with a plain object is now multipart, matching
    // axios (previously sent url-encoded). The exact boundary is random on
    // both sides, so only the `Content-Type` prefix is compared.
    name: 'postForm with a plain object is multipart',
    run: (s, ctx) => s.postForm(echo(ctx), { a: '1', b: [1, 2] }),
    normalize: (o: any) =>
      String(lastRequest(o)?.headers['content-type']).split(';')[0],
  },
  {
    // Also fixed: an explicit Content-Type header does NOT override
    // postForm's own multipart default - confirmed against real axios
    // (`generateHTTPMethod(isForm=true)`'s own `headers` always win in its
    // `mergeConfig` call).
    name: "postForm's multipart default isn't overridden by an explicit Content-Type header",
    run: (s, ctx) =>
      s.postForm(
        echo(ctx),
        { a: '1', b: { c: 2 } },
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      ),
    normalize: (o: any) =>
      String(lastRequest(o)?.headers['content-type']).split(';')[0],
  },
  ...['get', 'delete', 'head', 'options'].map(m => ({
    name: `${m} without body: default headers`,
    run: (s: any, ctx: Ctx) =>
      m === 'options' && !s.options
        ? s.request({ url: echo(ctx), method: 'OPTIONS' })
        : s[m](echo(ctx)),
    normalize: serverView(ALL_DEFAULT_HEADERS),
  })),
  ...['post', 'put', 'patch'].map(m => ({
    name: `${m} without body: default headers`,
    run: (s: any, ctx: Ctx) => s[m](echo(ctx)),
    normalize: serverView(ALL_DEFAULT_HEADERS),
  })),
  {
    name: 'delete with data',
    run: (s, ctx) => s.delete(echo(ctx), { data: { a: 1 } }),
    normalize: serverView(SERVER_HEADERS),
  },
  {
    name: 'get with data (axios sends a body)',
    run: (s, ctx) =>
      s.request({ url: echo(ctx), method: 'get', data: { a: 1 } }),
    normalize: serverView(SERVER_HEADERS),
  },
  {
    name: 'headers: null/undefined/false/number values, array values',
    run: (s, ctx) =>
      s.get(echo(ctx), {
        headers: {
          'X-Null': null,
          'X-Undef': undefined,
          'X-False': false,
          'X-Num': 5,
          'X-Arr': ['a', 'b'],
          'X-Empty': '',
        },
      }),
    normalize: serverView([
      'x-null',
      'x-undef',
      'x-false',
      'x-num',
      'x-arr',
      'x-empty',
    ]),
  },
  {
    name: 'auth + Authorization header',
    run: (s, ctx) =>
      s.get(echo(ctx), {
        auth: { username: 'u', password: 'p:ß' },
        headers: { Authorization: 'Bearer x' },
      }),
    normalize: serverView(SERVER_HEADERS),
  },
  {
    name: 'credentials in URL',
    run: (s, ctx) =>
      s.get(ctx.base.replace('http://', 'http://user:pa%20ss@') + '/echo'),
    normalize: (o: any) => ({
      server: serverView(SERVER_HEADERS)(o),
      ok: !!o.result,
    }),
  },
  {
    // `config.auth` wins over credentials embedded in the URL, as in axios.
    name: 'credentials in URL; config.auth wins',
    run: (s, ctx) =>
      s.get(ctx.base.replace('http://', 'http://user:pass@') + '/echo', {
        auth: { username: 'other', password: 'secret' },
      }),
    normalize: (o: any) => ({
      server: serverView(SERVER_HEADERS)(o),
      ok: !!o.result,
    }),
  },
  ...paramsCases.map(([name, prm, cfg]) => ({
    name: `params: ${name}`,
    run: (s: any, ctx: Ctx) => s.get(echo(ctx), { params: prm, ...cfg }),
    normalize: (o: any) => lastRequest(o)?.url,
  })),
  {
    name: 'params: existing query + hash',
    run: (s, ctx) => s.get(`${echo(ctx)}?x=1#frag`, { params: { a: 1 } }),
    normalize: (o: any) => lastRequest(o)?.url,
  },
  {
    // axios' own query encoder (`encodeURIComponent`, which leaves `'`
    // unescaped) matches what this library's `buildURL`/`encodeParam`
    // already produce - but undici always dispatches through a WHATWG
    // `new URL()` parse (`parseURL` in `undici/lib/core/util.js`, with no
    // way to opt out), and the URL Standard's *special-query* percent-encode
    // set adds `'` specifically for http(s) - so it comes out as `%27`
    // regardless of what string this library handed it. Not fixable without
    // bypassing undici's own URL parsing (out of scope).
    name: "params: '' encodes as %27 (WHATWG URL parsing)",
    run: (s, ctx) => s.get(echo(ctx), { params: { q: "a'b" } }),
    normalize: (o: any) => lastRequest(o)?.url,
    knownDifference: 'plan.md phase 2: fix(errors): match axios errors',
  },
  ...joinCases.map(([name, b, u]) => ({
    name: `baseURL join: ${name}`,
    run: (s: any, ctx: Ctx) => s.get(u, { baseURL: ctx.base + b }),
    normalize: (o: any) => lastRequest(o)?.url,
  })),
  {
    name: 'absolute URL ignores baseURL; allowAbsoluteUrls false',
    run: (s, ctx) =>
      s.get(`${echo(ctx)}/abs`, {
        baseURL: `${ctx.base}/api`,
        allowAbsoluteUrls: false,
      }),
    normalize: (o: any) => lastRequest(o)?.url,
  },
  {
    name: 'URL object as url',
    run: (s, ctx) => s.get(new URL(`${echo(ctx)}/obj`), { params: { a: 1 } }),
    normalize: (o: any) => lastRequest(o)?.url,
  },
  {
    name: 'method casing lower in request(config)',
    run: (s, ctx) =>
      s.request({ url: echo(ctx), method: 'post', data: { a: 1 } }),
    normalize: serverView(SERVER_HEADERS),
  },
  {
    name: 'request(config) without method defaults to GET; with baseURL only',
    run: (s, ctx) => s.request({ url: '/echo/x', baseURL: ctx.base }),
    normalize: (o: any) => lastRequest(o)?.url,
  },
]);
