/**
 * Differential: axiosRef interceptors, defaults/instance API, and
 * Observable semantics (cold, unsubscribe-aborts, retry). See harness.ts.
 *
 * These cases reach into `axiosRef` directly (rather than only `run(service, ctx)`
 * returning an Observable), since interceptor registration has to happen
 * before the call. `run` still does the one thing the harness cares about:
 * returns the Observable/Promise it awaits for the outcome.
 */
import {
  firstValueFrom,
  of,
  race,
  retry,
  switchMap,
  timer,
  timeout as rxTimeout,
} from 'rxjs';
import { differential, Ctx } from './harness';

const TYPES = 'plan.md phase 2: types: axios interop';

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
      new URL(req.url, 'http://x').searchParams.get('ms') || 1500,
    );
    const t = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('late');
    }, ms);
    res.on('close', () => clearTimeout(t));
  },
};

differential('Differential: axiosRef interceptors and instance API', routes, [
  {
    name: 'request/response interceptor order',
    run: (s: any, ctx: Ctx) => {
      const log: string[] = [];
      s.axiosRef.interceptors.request.use((c: any) => (log.push('req1'), c));
      s.axiosRef.interceptors.request.use((c: any) => (log.push('req2'), c));
      s.axiosRef.interceptors.response.use((x: any) => (log.push('res1'), x));
      s.axiosRef.interceptors.response.use((x: any) => (log.push('res2'), x));
      return firstValueFrom(s.get(`${ctx.base}/echo`)).then(() => log);
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'request interceptor config contents',
    run: (s: any, ctx: Ctx) => {
      let seen: any;
      s.axiosRef.interceptors.request.use((c: any) => {
        seen = {
          url: c.url,
          baseURL: c.baseURL,
          method: c.method,
          params: c.params,
          data: c.data,
          xreq: c.headers?.['X-Req'] ?? c.headers?.get?.('X-Req'),
          headersIsAxiosHeaders:
            typeof c.headers?.set === 'function' &&
            typeof c.headers?.setContentType === 'function',
        };
        return c;
      });
      return firstValueFrom(
        s.post(
          '/echo',
          { a: 1 },
          { baseURL: ctx.base, params: { q: 1 }, headers: { 'X-Req': 'r' } },
        ),
      ).then(() => seen);
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'request interceptor mutating config.data object',
    run: (s: any, ctx: Ctx) => {
      s.axiosRef.interceptors.request.use(
        (c: any) => ((c.data.added = true), c),
      );
      return s.post(`${ctx.base}/echo`, { a: 1 });
    },
    normalize: (o: any) => (o.result?.data ?? {}).body,
  },
  {
    name: 'request interceptor adding params',
    run: (s: any, ctx: Ctx) => {
      s.axiosRef.interceptors.request.use(
        (c: any) => ((c.params = { ...c.params, key: 'k' }), c),
      );
      return s.get(`${ctx.base}/echo`, { params: { q: 1 } });
    },
    normalize: (o: any) => (o.result?.data ?? {}).url,
  },
  {
    name: 'request interceptor setting header via headers.set / Authorization',
    run: (s: any, ctx: Ctx) => {
      s.axiosRef.interceptors.request.use((c: any) => {
        c.headers.set('X-Set', '1');
        c.headers.Authorization = 'Bearer t';
        return c;
      });
      return s.get(`${ctx.base}/echo`);
    },
    normalize: (o: any) => {
      const h = (o.result?.data ?? {}).headers ?? {};
      return { xSet: h['x-set'], auth: h.authorization };
    },
  },
  {
    name: 'request interceptor changing baseURL/url',
    run: (s: any, ctx: Ctx) => {
      s.axiosRef.interceptors.request.use(
        (c: any) => ((c.url = '/echo/rewritten'), c),
      );
      return s.get('/echo/orig', { baseURL: ctx.base });
    },
    normalize: (o: any) => (o.result ? o.result.data.url : o.error?.message),
  },
  {
    name: 'request interceptor throwing rejects the request (no network call)',
    run: (s: any, ctx: Ctx) => {
      s.axiosRef.interceptors.request.use(() => {
        throw new Error('nope');
      });
      return s.get(`${ctx.base}/echo`);
    },
    normalize: (o: any) => ({
      requests: o.requests.length,
      message: o.error?.message,
    }),
  },
  {
    name: 'response interceptor onRejected recovers',
    run: (s: any, ctx: Ctx) => {
      s.axiosRef.interceptors.response.use(undefined, (e: any) => ({
        status: 299,
        data: 'recovered:' + e.response.status,
      }));
      return s.get(`${ctx.base}/raw?status=404`);
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'response interceptor retry pattern: axiosRef.request(error.config)',
    run: (s: any, ctx: Ctx) => {
      s.axiosRef.interceptors.response.use(undefined, (e: any) => {
        if (e.config.__retried) throw e;
        e.config.__retried = true;
        e.config.url = e.config.url.replace('/raw?status=401', '/echo/retried');
        return s.axiosRef.request(e.config);
      });
      return s.get(`${ctx.base}/raw?status=401`);
    },
    normalize: (o: any) => (o.result ? o.result.data.url : o.error?.message),
  },
  {
    name: 'interceptor options: runWhen / synchronous',
    run: (s: any, ctx: Ctx) => {
      const log: string[] = [];
      s.axiosRef.interceptors.request.use(
        (c: any) => (log.push('skipped?'), c),
        null,
        { runWhen: () => false },
      );
      s.axiosRef.interceptors.request.use(
        (c: any) => (log.push('sync'), c),
        null,
        { synchronous: true },
      );
      return firstValueFrom(s.get(`${ctx.base}/echo`)).then(() => log);
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'interceptors.request.handlers / forEach exist',
    run: (s: any) => ({
      handlers: Array.isArray(s.axiosRef.interceptors.request.handlers),
      forEach: typeof s.axiosRef.interceptors.request.forEach,
    }),
    normalize: (o: any) => o.result,
    knownDifference: TYPES,
  },
  {
    name: 'axiosRef instance API surface',
    run: (s: any) => {
      const keys = [
        'request',
        'get',
        'delete',
        'head',
        'options',
        'post',
        'put',
        'patch',
        'postForm',
        'putForm',
        'patchForm',
        'getUri',
        'create',
      ];
      return {
        ...Object.fromEntries(keys.map(k => [k, typeof s.axiosRef[k]])),
        callable: typeof s.axiosRef,
      };
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'axiosRef.defaults runtime mutations',
    run: (s: any, ctx: Ctx) => {
      const d: any = s.axiosRef.defaults;
      d.baseURL = ctx.base;
      d.timeout = 5000;
      d.headers.common['X-Common'] = 'c';
      d.headers.post['X-Post'] = 'p';
      return firstValueFrom(s.post('/echo', { a: 1 })).then((r: any) => ({
        hc: r.data?.headers?.['x-common'],
        hp: r.data?.headers?.['x-post'],
      }));
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'axiosRef(config) - the instance is callable, like axios(config)',
    run: (s: any, ctx: Ctx) =>
      s.axiosRef({ url: `${ctx.base}/echo`, method: 'get' }).then((r: any) => ({
        status: r.status,
        method: r.data.method,
        url: r.data.url,
      })),
    normalize: (o: any) => o.result,
  },
  {
    name: 'axiosRef(url, config) - callable with the (url, config) shape',
    run: (s: any, ctx: Ctx) =>
      s.axiosRef(`${ctx.base}/echo`, { method: 'get' }).then((r: any) => ({
        status: r.status,
        method: r.data.method,
        url: r.data.url,
      })),
    normalize: (o: any) => o.result,
  },
  {
    name: 'axiosRef.getUri: baseURL + params, without sending the request',
    run: (s: any, ctx: Ctx) =>
      s.axiosRef.getUri({
        url: '/echo',
        baseURL: ctx.base,
        params: { a: 1, b: 'x y' },
      }),
    normalize: (o: any) => o.result,
  },
  {
    name: 'axiosRef.postForm sends a multipart form, like axios',
    run: (s: any, ctx: Ctx) =>
      s.axiosRef
        .postForm(`${ctx.base}/echo`, { a: '1', b: '2' })
        .then((r: any) => ({
          status: r.status,
          method: r.data.method,
          contentType: String(r.data.headers['content-type']).split(';')[0],
        })),
    normalize: (o: any) => o.result,
  },
  {
    name: 'axiosRef.create() inherits defaults and can override them',
    run: (s: any, ctx: Ctx) => {
      s.axiosRef.defaults.baseURL = ctx.base;
      s.axiosRef.defaults.headers.common['X-Parent'] = 'p';
      const child = s.axiosRef.create({
        headers: { 'X-Child': 'c' },
        baseURL: ctx.other,
      });
      // The child shares the parent's transport but has independent
      // defaults/interceptors: it keeps the inherited X-Parent header, adds
      // its own X-Child header, and overrides baseURL - none of which
      // affect the parent.
      return Promise.all([
        child.get('/echo'),
        s.axiosRef.get(`${ctx.base}/echo`),
      ]).then(([childRes, parentRes]: any[]) => ({
        childUrl: childRes.data.url,
        childHeaders: {
          xParent: childRes.data.headers['x-parent'],
          xChild: childRes.data.headers['x-child'],
        },
        parentHasChildHeader: 'x-child' in parentRes.data.headers,
      }));
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'runtime axiosRef.defaults.validateStatus is honoured on a plain request',
    run: (s: any, ctx: Ctx) => {
      s.axiosRef.defaults.validateStatus = (status: number) => status < 500;
      return firstValueFrom(s.get(`${ctx.base}/raw?status=404`)).then(
        (r: any) => r.status,
      );
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'runtime axiosRef.defaults.params is merged into a plain request, with request params winning',
    run: (s: any, ctx: Ctx) => {
      s.axiosRef.defaults.params = { a: 'default', shared: 'default' };
      return firstValueFrom(
        s.get(`${ctx.base}/echo`, { params: { shared: 'request' } }),
      ).then((r: any) => r.data.url);
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'runtime axiosRef.defaults.responseType is honoured on a plain request',
    run: (s: any, ctx: Ctx) => {
      s.axiosRef.defaults.responseType = 'arraybuffer';
      return firstValueFrom(s.get(`${ctx.base}/echo`)).then(
        (r: any) => r.data.constructor.name,
      );
    },
    normalize: (o: any) => o.result,
  },
  {
    name: 'header casing in response.config.headers.toJSON() matches what was set',
    run: (s: any, ctx: Ctx) =>
      firstValueFrom(
        s.get(`${ctx.base}/echo`, { headers: { 'X-Custom-Case': 'v' } }),
      ).then((r: any) => Object.keys(r.config.headers.toJSON())),
    normalize: (o: any) => o.result.includes('X-Custom-Case'),
  },
]);

differential(
  'Differential: Observable semantics',
  {
    '/echo': (req: any, res: any) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
    '/slow': (req: any, res: any) => {
      const ms = Number(
        new URL(req.url, 'http://x').searchParams.get('ms') || 1500,
      );
      const t = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('late');
      }, ms);
      res.on('close', () => clearTimeout(t));
    },
    '/status500': (_req: any, res: any) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
    },
  },
  [
    {
      name: 'cold: no request until subscribe; each subscription = one request',
      run: async (s: any, ctx: Ctx) => {
        const before = ctx.seen.length;
        const o = s.get(`${ctx.base}/echo`);
        const afterCreate = ctx.seen.length - before;
        await firstValueFrom(o);
        await firstValueFrom(o);
        return { afterCreate, total: ctx.seen.length - before };
      },
      normalize: (o: any) => o.result,
    },
    {
      name: 'unsubscribe aborts the in-flight request (rxjs timeout/race/switchMap)',
      run: async (s: any, ctx: Ctx) => {
        const before = ctx.seen.length;
        await firstValueFrom(
          s.get(`${ctx.base}/slow?ms=1500`).pipe(rxTimeout(100)),
        ).catch(() => 0);
        await firstValueFrom(
          race(s.get(`${ctx.base}/slow?ms=1500`), timer(100)),
        ).catch(() => 0);
        await firstValueFrom(
          of(1).pipe(
            switchMap(() => s.get(`${ctx.base}/slow?ms=1500`)),
            rxTimeout(100),
          ),
        ).catch(() => 0);
        // Give the server a beat to observe the socket close.
        await new Promise(r => setTimeout(r, 200));
        return ctx.seen.slice(before).map((r: any) => r.aborted);
      },
      normalize: (o: any) => o.result,
    },
    {
      name: 'interceptor side effects happen per subscription',
      run: async (s: any, ctx: Ctx) => {
        let n = 0;
        s.axiosRef.interceptors.request.use((c: any) => (n++, c));
        const o = s.get(`${ctx.base}/echo`);
        await firstValueFrom(o);
        await firstValueFrom(o);
        return n;
      },
      normalize: (o: any) => o.result,
    },
    {
      name: 'rxjs retry() re-runs axiosRef request interceptors per attempt',
      run: async (s: any, ctx: Ctx) => {
        let n = 0;
        s.axiosRef.interceptors.request.use(
          (c: any) => ((c.headers['X-N'] = String(++n)), c),
        );
        const before = ctx.seen.length;
        await firstValueFrom(
          s.get(`${ctx.base}/status500`).pipe(retry(2)),
        ).catch(() => 0);
        return ctx.seen.slice(before).map((r: any) => r.headers['x-n']);
      },
      normalize: (o: any) => o.result, // axios: ['1', '2', '3']
    },
  ],
);
