/**
 * Differential test harness (plan.md phase 1 item D).
 *
 * Every scenario below is one table entry (a `Case`). Each case runs the
 * same call through @nestjs/axios (real axios) and this package's
 * `HttpService`, against one local `node:http` server, and the harness
 * compares the *normalized* outcome: what the server received (method,
 * path, a selected subset of headers, body) and what the caller got back
 * (status/data/headers, or an error's code/status/message shape).
 *
 * - A plain case asserts the two outcomes are equal. A behavioural
 *   difference here is a real bug or a real gap.
 * - A case with `knownDifference` set asserts the outcomes DIFFER. It
 *   documents a gap that's already tracked in `plan.md` phase 2. Once the
 *   underlying fix lands, the outcomes become equal, the assertion flips,
 *   and the test fails with a message telling you to remove the marker and
 *   update `plan.md`'s per-item known-difference count.
 *
 * `HttpModule.register({})` is used for @nestjs/axios (never the plain,
 * import-only `HttpModule`): @nestjs/axios' plain `HttpModule` shares the
 * *global* axios instance, so interceptors registered by one test would
 * leak into the next. `register()` gives each test its own axios instance,
 * matching how this package's `HttpModule.register()` always scopes a
 * dedicated `undiciRef`/`axiosRef` per module.
 *
 * Started as a planning-phase prototype (plan.md phase 1).
 */
/* eslint-disable jest/no-export, jest/valid-title, jest/no-conditional-expect --
 * this is a reusable test-registration harness, not a spec: `differential()`
 * wraps `describe`/`it` for its callers, so titles and the equal/not-equal
 * branch are necessarily built from the `Case` table's data. */
import { Test, TestingModule } from '@nestjs/testing';
import {
  HttpModule as AxiosHttpModule,
  HttpService as AxiosHttpService,
} from '@nestjs/axios';
import axios from 'axios';
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { firstValueFrom, isObservable } from 'rxjs';
import {
  HttpModule as UndiciHttpModule,
  HttpService as UndiciHttpService,
} from '../../../src';

/** One request the local server saw. `aborted` is set once the connection closes without a finished response. */
export type Seen = {
  method: string;
  url: string;
  headers: Record<string, any>;
  body: string;
  aborted: boolean;
};

/** Per-suite state: the server's base URL(s) and the requests it has seen so far. */
export type Ctx = { base: string; other: string; seen: Seen[] };

/** Raw result of running one case: every request the server saw, plus the resolved value or thrown error. */
export type Outcome = { requests: Seen[]; result?: any; error?: any };

export type Case = {
  /** Short, unique description; shown as the Jest test name. */
  name: string;
  /**
   * Module options passed to both `HttpModule.register()` calls. Either a
   * plain object, or a function of `ctx` for cases that need the server's
   * base URL (e.g. a cross-origin redirect target).
   */
  options?: any | ((ctx: Ctx) => any);
  /** Runs the call under test against one service (axios or undici); returns an Observable or a Promise. */
  run: (service: any, ctx: Ctx) => any;
  /** Picks what to compare. Default: requests (method/url/body/selected headers) + response/error summary. May be async (e.g. to read a stream). */
  normalize?: (outcome: Outcome, ctx: Ctx) => any | Promise<any>;
  /** Marks a known, tracked gap: `'plan.md phase 2: <item>'`. The harness then asserts the two sides DIFFER. */
  knownDifference?: string;
  /** Skip the case when the reference service doesn't support it (e.g. `HttpService.query`, added in @nestjs/axios 12). */
  skipIf?: (ref: any) => boolean;
};

/** Route handler for the local test server: `(req, res, body, ctx) => void`. */
export type Route = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  ctx: Ctx,
) => void;

const HEADERS = [
  'content-type',
  'content-length',
  'authorization',
  'accept',
  'x-a',
  'x-b',
  'cookie',
];

/** Keeps only a fixed, deterministic subset of headers (drops `date`, `connection`, ports, etc). */
export const pickHeaders = (h: Record<string, any>) =>
  Object.fromEntries(
    HEADERS.filter(k => h[k] !== undefined).map(k => [k, h[k]]),
  );

export const summarizeResponse = (r: any) =>
  r && {
    status: r.status,
    statusText: r.statusText,
    data: Buffer.isBuffer(r.data) ? `<Buffer ${r.data.toString()}>` : r.data,
    headers: {
      'content-type': r.headers?.['content-type'],
      'set-cookie': r.headers?.['set-cookie'],
      location: r.headers?.location,
    },
  };

export const summarizeError = (e: any) =>
  e && {
    name: e.name,
    message: e.message,
    code: e.code,
    status: e.status,
    isAxiosError: axios.isAxiosError(e),
    isCancel: axios.isCancel(e),
    response: summarizeResponse(e.response),
    hasConfig: !!e.config,
    hasRequest: !!e.request,
  };

const defaultNormalize = (o: Outcome) => ({
  requests: o.requests.map(r => ({
    method: r.method,
    url: r.url,
    body: r.body,
    headers: pickHeaders(r.headers),
  })),
  result: summarizeResponse(o.result),
  error: summarizeError(o.error),
});

async function readStream(s: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Normalizes a response/error `data` value that may be a Buffer,
 * ArrayBuffer, Blob or Node stream into something `toEqual`-comparable,
 * tagged by its shape so a Buffer-vs-string difference still shows up.
 */
export async function normData(data: any): Promise<any> {
  if (Buffer.isBuffer(data)) return { $buffer: data.toString('utf8') };
  if (data instanceof ArrayBuffer)
    return { $arraybuffer: Buffer.from(data).toString('utf8') };
  if (typeof Blob !== 'undefined' && data instanceof Blob)
    return { $blob: await data.text() };
  if (data && typeof data.pipe === 'function')
    return { $stream: await readStream(data) };
  return data;
}

export const IGNORED_HEADERS = new Set([
  'date',
  'connection',
  'keep-alive',
  'transfer-encoding',
]);

/** Full response-headers comparison (AxiosHeaders or plain object), sorted and with volatile headers dropped. */
export function normHeaders(h: any): Record<string, any> {
  const plain = h && typeof h.toJSON === 'function' ? h.toJSON() : { ...h };
  const out: Record<string, any> = {};
  for (const k of Object.keys(plain).sort())
    if (!IGNORED_HEADERS.has(k.toLowerCase())) out[k] = plain[k];
  return out;
}

/**
 * Registers one `describe` block: starts a two-origin local server, then
 * runs every case through both HttpModules.
 *
 * `routes` maps a path (matched exactly or as a prefix, longest first) to a
 * handler; anything unmatched gets `{ ok: true }` as JSON.
 */
export function differential(
  title: string,
  routes: Record<string, Route>,
  cases: Case[],
): void {
  describe(title, () => {
    const ctx: Ctx = { base: '', other: '', seen: [] };
    const servers: Server[] = [];
    const modules: TestingModule[] = [];

    const start = async (): Promise<string> => {
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          const seen: Seen = {
            method: req.method!,
            url: req.url!,
            headers: req.headers,
            body,
            aborted: false,
          };
          ctx.seen.push(seen);
          res.on('close', () => {
            if (!res.writableFinished) seen.aborted = true;
          });
          const path = new URL(req.url!, 'http://x').pathname;
          const key = Object.keys(routes)
            .sort((a, b) => b.length - a.length)
            .find(k => path === k || path.startsWith(`${k}/`));
          if (key) return routes[key](req, res, body, ctx);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      servers.push(server);
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };

    beforeAll(async () => {
      ctx.base = await start();
      // A second origin, for cross-origin redirect cases.
      ctx.other = (await start()).replace('127.0.0.1', 'localhost');
    });

    afterAll(async () => {
      await Promise.all(modules.map(m => m.close()));
      for (const s of servers) {
        s.closeAllConnections();
        await new Promise(r => s.close(r));
      }
    });

    const service = async (Mod: any, Svc: any, options: any) => {
      const m = await Test.createTestingModule({
        imports: [Mod.register(options ?? {})],
      }).compile();
      modules.push(m);
      return m.get(Svc);
    };

    const exec = async (s: any, c: Case): Promise<Outcome> => {
      ctx.seen = [];
      const o: Outcome = { requests: ctx.seen };
      try {
        const v = c.run(s, ctx);
        o.result = isObservable(v) ? await firstValueFrom(v) : await v;
      } catch (e) {
        o.error = e;
      }
      return o;
    };

    for (const c of cases) {
      it(
        c.knownDifference ? `known difference: ${c.name}` : c.name,
        async () => {
          const opts =
            typeof c.options === 'function' ? c.options(ctx) : c.options;
          const ref = await service(AxiosHttpModule, AxiosHttpService, opts);
          if (c.skipIf?.(ref)) return;
          const ours = await service(UndiciHttpModule, UndiciHttpService, opts);
          const norm = c.normalize ?? defaultNormalize;
          const a = await norm(await exec(ref, c), ctx);
          const u = await norm(await exec(ours, c), ctx);
          if (c.knownDifference) {
            expect(u).not.toEqual(a);
          } else {
            expect(u).toEqual(a);
          }
        },
      );
    }
  });
}
