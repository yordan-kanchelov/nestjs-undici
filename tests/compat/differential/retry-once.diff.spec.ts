/**
 * Differential: the "retry once on 401" axiosRef interceptor pattern, and
 * the two most common third-party packages built on it. See harness.ts.
 *
 * These all depend on one axios-shaped config object surviving a round trip
 * through `error.config` with its custom fields, raw `data` and lower-case
 * `method` intact - the fix this item ("refactor(axiosRef): one config
 * object") makes. Before it: a retry-once interceptor loops forever (the
 * `_retry` flag never survives onto the replayed config), a POST replay
 * sends an empty body, axios-retry gives up after 1 attempt instead of
 * retrying, and axios-auth-refresh's replayed request never reaches the
 * server.
 */
import axiosRetry from 'axios-retry';
import { createAuthRefreshInterceptor } from 'axios-auth-refresh';
import { differential, Ctx } from './harness';

const routes = {
  '/raw': (req: any, res: any) => {
    const p = new URL(req.url, 'http://x').searchParams;
    const status = Number(p.get('status') || 200);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(p.get('body') ?? '{}');
  },
  '/echo': (req: any, res: any, body: string) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url, body }));
  },
  // 401 on the first hit (per case run - `ctx.seen` is reset before each
  // side's `exec()`), 200 afterwards: simulates an expired token that a
  // refresh call (which doesn't itself hit this route) fixes.
  '/auth-once': (_req: any, res: any, _body: string, ctx: Ctx) => {
    const hits = ctx.seen.filter(r => r.url.startsWith('/auth-once')).length;
    if (hits <= 1) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{}');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }
  },
};

/**
 * `axiosRef` isn't (yet) callable, unlike a real axios instance - see
 * plan.md phase 2 "feat(axiosRef): make it a real axios instance". Both
 * axios-retry and axios-auth-refresh need a callable to replay a request
 * through, so wrap ours the same way any consumer would in the meantime
 * (`(config) => axiosRef.request(config)`); a real axios instance is
 * already callable and is used as-is.
 */
function callableRef(s: any): any {
  const ref = s.axiosRef;
  if (typeof ref === 'function') return ref;
  const callable = (config: any) => ref.request(config);
  return Object.assign(callable, ref);
}

differential('Differential: retry-once interceptor pattern', routes, [
  {
    name: '_retry flag on error.config survives the replay (2 requests, not a loop)',
    run: (s: any, ctx: Ctx) => {
      const ref = s.axiosRef;
      let calls = 0;
      ref.interceptors.response.use(undefined, (error: any) => {
        const original = error.config;
        if (
          error.response?.status === 401 &&
          !original._retry &&
          ++calls < 20 // safety cap, in case the flag doesn't survive
        ) {
          original._retry = true;
          return ref.request(original);
        }
        return Promise.reject(error);
      });
      return s.get(`${ctx.base}/raw?status=401`);
    },
    normalize: (o: any) => o.requests.length, // axios: 2
  },
  {
    name: 'replaying a POST through error.config sends the original body',
    run: (s: any, ctx: Ctx) => {
      const ref = s.axiosRef;
      ref.interceptors.response.use(undefined, (error: any) => {
        const original = error.config;
        if (error.response?.status === 401 && !original._retry) {
          original._retry = true;
          return ref.request(original);
        }
        return Promise.reject(error);
      });
      return s.post(`${ctx.base}/raw?status=401`, { a: 1 });
    },
    normalize: (o: any) => o.requests.map((r: any) => r.body), // axios: ['{"a":1}', '{"a":1}']
  },
  {
    name: 'axios-retry sends 3 attempts',
    run: (s: any, ctx: Ctx) => {
      axiosRetry(callableRef(s), {
        retries: 2,
        retryCondition: () => true,
        retryDelay: () => 0,
      });
      return s.get(`${ctx.base}/raw?status=500`);
    },
    normalize: (o: any) => o.requests.length, // axios: 3
  },
  {
    name: 'axios-auth-refresh replays the request',
    run: (s: any, ctx: Ctx) => {
      const ref = s.axiosRef;
      createAuthRefreshInterceptor(ref, () => Promise.resolve(), {
        statusCodes: [401],
        retryInstance: callableRef(s),
        deduplicateRefresh: false,
      } as any);
      return s.get(`${ctx.base}/auth-once`);
    },
    normalize: (o: any) => ({
      requests: o.requests.length, // axios: 2 (401 then 200)
      ok: !!o.result,
    }),
  },
]);
