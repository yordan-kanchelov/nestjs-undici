/**
 * Differential: `HttpModule.register()` / `registerAsync()` options. See harness.ts.
 */
import { Agent as HttpAgent, createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import axios from 'axios';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import {
  HttpModule as AxiosHttpModule,
  HttpService as AxiosHttpService,
} from '@nestjs/axios';
import {
  HttpModule as UndiciHttpModule,
  HttpService as UndiciHttpService,
} from '../../../src';
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
  '/redirect': (req: any, res: any) => {
    const p = new URL(req.url, 'http://x').searchParams;
    res.writeHead(302, { Location: p.get('to') || '/echo' });
    res.end();
  },
  '/raw': (req: any, res: any) => {
    const p = new URL(req.url, 'http://x').searchParams;
    const status = Number(p.get('status') || 200);
    const headers: Record<string, string> = {};
    if (p.has('ct')) headers['Content-Type'] = p.get('ct')!;
    res.writeHead(status, headers);
    res.end(p.get('body') ?? '');
  },
  '/slow': (req: any, res: any) => {
    const ms = Number(
      new URL(req.url, 'http://x').searchParams.get('ms') || 3000,
    );
    const t = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('late');
    }, ms);
    res.on('close', () => clearTimeout(t));
  },
  '/big': (req: any, res: any) => {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('n') || 500);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('x'.repeat(n));
  },
  '/set-cookie': (_req: any, res: any) => {
    res.setHeader('Set-Cookie', 'sid=abc; Path=/');
    res.end('ok');
  },
};

differential('Differential: HttpModule.register() options', routes, [
  {
    name: 'headers with axios method keys (common/post) in register()',
    options: {
      headers: { common: { 'X-C': 'c' }, post: { 'X-P': 'p' }, 'X-Flat': 'f' },
    },
    run: (s, ctx: Ctx) => s.post(`${ctx.base}/echo`, { a: 1 }),
    normalize: (o: any) => {
      const r = o.requests[o.requests.length - 1];
      return (
        r && {
          xc: r.headers['x-c'],
          xp: r.headers['x-p'],
          xf: r.headers['x-flat'],
          common: r.headers.common,
          post: r.headers.post,
        }
      );
    },
  },
  {
    name: 'timeout module-level',
    options: { timeout: 300 },
    run: (s, ctx: Ctx) => s.get(`${ctx.base}/slow?ms=3000`),
    normalize: (o: any) => ({ code: o.error?.code, resolved: !!o.result }),
  },
  {
    name: 'maxRedirects module-level (5)',
    options: { maxRedirects: 5 },
    run: (s, ctx: Ctx) => s.get(`${ctx.base}/redirect?to=/echo/x`),
    normalize: (o: any) => o.requests.map((r: any) => r.url),
  },
  {
    name: 'validateStatus module-level + per-request override',
    options: { validateStatus: () => true },
    run: async (s: any, ctx: Ctx) => {
      const r1 = await firstValueFrom(
        s.get(`${ctx.base}/raw?status=500&ct=text/plain&body=x`),
      );
      let e2: any;
      try {
        await firstValueFrom(
          s.get(`${ctx.base}/raw?status=500&ct=text/plain&body=x`, {
            validateStatus: (st: number) => st < 400,
          }),
        );
      } catch (e) {
        e2 = e;
      }
      return { ok1: !!r1, ok2: !e2 };
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'maxContentLength module-level; per-request override wins',
    options: { maxContentLength: 100 },
    run: (s, ctx: Ctx) =>
      s.get(`${ctx.base}/big?n=500`, { maxContentLength: 10000 }),
    normalize: (o: any) => ({ ok: !!o.result }),
  },
  {
    name: 'maxBodyLength module-level with a stream body',
    options: { maxBodyLength: 100, maxRedirects: 5 },
    run: (s, ctx: Ctx) =>
      s.post(`${ctx.base}/echo`, Readable.from([Buffer.alloc(500, 'x')])),
    normalize: (o: any) => ({ ok: !!o.result }),
  },
  {
    name: 'maxBodyLength module-level; per-request override wins',
    options: { maxBodyLength: 100 },
    run: (s, ctx: Ctx) =>
      s.post(`${ctx.base}/echo`, 'x'.repeat(500), { maxBodyLength: 10000 }),
    normalize: (o: any) => ({ ok: !!o.result }),
  },
  {
    name: 'timeoutErrorMessage module-level',
    options: { timeout: 300, timeoutErrorMessage: 'custom module message!' },
    run: (s, ctx: Ctx) => s.get(`${ctx.base}/slow?ms=3000`),
    normalize: (o: any) => o.error?.message,
  },
  {
    name: 'transformResponse (custom, replaces default parsing)',
    options: {
      transformResponse: [(data: any) => ({ raw: data, type: typeof data })],
    },
    run: (s, ctx: Ctx) =>
      s.get(
        `${ctx.base}/raw?ct=application/json&body={"big":12345678901234567890}`,
      ),
    normalize: (o: any) => o.result?.data,
    // module-level transformResponse should replace default parsing and receive the raw
    // string; here the default JSON parse already ran, so it receives an object instead.
  },
  {
    name: 'transformResponse receives headers and status',
    options: {
      transformResponse: [
        (data: any, headers: any, status: number) => ({
          ct: headers?.['content-type'] ?? headers?.get?.('content-type'),
          status,
        }),
      ],
    },
    run: (s, ctx: Ctx) => s.get(`${ctx.base}/raw?ct=application/json&body={}`),
    normalize: (o: any) => o.result?.data,
  },
  {
    name: 'transformResponse chained after axios defaults',
    options: {
      transformResponse: [
        ...(axios.defaults.transformResponse as any[]),
        (d: any) => ({ wrapped: d }),
      ],
    },
    run: (s, ctx: Ctx) =>
      s.get(`${ctx.base}/raw?ct=application/json&body={"a":1}`),
    normalize: (o: any) => o.result?.data,
  },
  {
    name: 'transformRequest (custom, receives raw data, must return string)',
    options: {
      transformRequest: [
        (data: any, headers: any) => {
          headers['Content-Type'] = 'text/x-custom';
          return `custom:${typeof data}:${JSON.stringify(data)}`;
        },
      ],
    },
    run: (s, ctx: Ctx) => s.post(`${ctx.base}/echo`, { a: 1 }),
    normalize: (o: any) => {
      const r = o.requests[o.requests.length - 1];
      return r && { ct: r.headers['content-type'], body: r.body };
    },
  },
  {
    name: 'transformRequest per request',
    run: (s, ctx: Ctx) =>
      s.post(
        `${ctx.base}/echo`,
        { a: 1 },
        { transformRequest: [(d: any) => 'x=' + d.a] },
      ),
    normalize: (o: any) => o.requests[o.requests.length - 1]?.body,
  },
  {
    name: 'transformResponse per request',
    run: (s, ctx: Ctx) =>
      s.get(`${ctx.base}/raw?ct=application/json&body={"a":1}`, {
        transformResponse: [(d: any) => 'raw:' + d],
      }),
    normalize: (o: any) => o.result?.data,
  },
  {
    name: 'httpAgent keepAlive:false still works (maps to pipelining 0)',
    options: { httpAgent: new HttpAgent({ keepAlive: false }) },
    run: (s, ctx: Ctx) => s.get(`${ctx.base}/echo`),
    normalize: (o: any) => !!o.result,
  },
  {
    name: 'withCredentials: cookies are NOT persisted by axios in Node',
    options: { withCredentials: true },
    run: async (s: any, ctx: Ctx) => {
      await firstValueFrom(s.get(`${ctx.base}/set-cookie`));
      const r: any = await firstValueFrom(s.get(`${ctx.base}/echo`));
      return r.data.headers.cookie;
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'params module-level merged with request params',
    options: { params: { k: 1 } },
    run: (s, ctx: Ctx) => s.get(`${ctx.base}/echo`, { params: { q: 2 } }),
    normalize: (o: any) => o.requests[o.requests.length - 1]?.url,
  },
  {
    name: 'socketPath',
    options: { socketPath: '/tmp/does-not-exist.sock' },
    run: (s: any) => s.get('http://localhost/echo'),
    normalize: (o: any) => ({ ok: !!o.result, code: o.error?.code }),
  },
]);

// `registerAsync` builds its options through a factory, so it needs its own
// module wiring instead of `differential()`'s `Mod.register(options)`.
describe('Differential: HttpModule.registerAsync()', () => {
  let base = '';
  let server: Server;
  const modules: TestingModule[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (new URL(req.url!, 'http://x').pathname === '/redirect') {
        res.writeHead(302, { Location: '/echo/async' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, headers: req.headers }));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await Promise.all(modules.map(m => m.close()));
    await new Promise(r => server.close(r));
  });

  it('registerAsync with options behaves like register (headers, maxRedirects, params)', async () => {
    const opts = {
      headers: { 'X-Async': '1' },
      timeout: 2000,
      maxRedirects: 5,
      params: { k: 1 },
    };
    const ma = await Test.createTestingModule({
      imports: [
        AxiosHttpModule.registerAsync({ useFactory: async () => opts }),
      ],
    }).compile();
    const mu = await Test.createTestingModule({
      imports: [
        UndiciHttpModule.registerAsync({ useFactory: async () => opts }),
      ],
    }).compile();
    modules.push(ma, mu);
    const a: any = await firstValueFrom(
      ma.get(AxiosHttpService).get(`${base}/redirect`),
    );
    const u: any = await firstValueFrom(
      mu.get(UndiciHttpService).get(`${base}/redirect`),
    );
    const shape = (r: any) => ({
      url: r.data.url,
      xAsync: r.data.headers['x-async'],
    });
    expect(shape(u)).toEqual(shape(a));
  });
});
