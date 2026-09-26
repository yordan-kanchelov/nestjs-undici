/**
 * Axios / @nestjs/axios compatibility matrix.
 *
 * Every test runs the same call against @nestjs/axios (real axios) and this
 * library against a local HTTP server and compares what the server received
 * and what the caller got back. Tests named "documented difference: ..."
 * pin behaviour that intentionally or knowingly differs from axios (see
 * docs/axios-supported-options.md).
 */
import { Injectable, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  HttpModule as AxiosHttpModule,
  HttpService as AxiosHttpService,
} from '@nestjs/axios';
import axios from 'axios';
import NodeFormData from 'form-data';
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { firstValueFrom, lastValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  AxiosError,
  AxiosHeaders,
  CanceledError,
  HttpModule as UndiciHttpModule,
  HttpModuleOptionsFactory,
  HttpService as UndiciHttpService,
  isAxiosError,
  isCancel,
} from '../src';

type Echo = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

const routes: Record<
  string,
  (req: IncomingMessage, res: ServerResponse, body: string) => void
> = {
  '/echo': (req, res, body) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Custom-Header': 'Abc',
    });
    res.end(
      JSON.stringify({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body,
      }),
    );
  },
  '/status': (req, res) => {
    const status = Number(
      new URL(req.url!, 'http://x').searchParams.get('code'),
    );
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(status === 204 ? undefined : JSON.stringify({ status }));
  },
  '/invalid-json': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('not json{');
  },
  '/empty-json': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end();
  },
  '/text-json': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('{"a":1}');
  },
  '/octet': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end('hello');
  },
  '/gzip': (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    });
    res.end(gzipSync(JSON.stringify({ zipped: true })));
  },
  '/redirect': (_req, res) => {
    res.writeHead(302, { Location: '/echo/after-redirect' });
    res.end();
  },
  '/slow': (_req, res) => {
    const timer = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('late');
    }, 3000);
    res.on('close', () => clearTimeout(timer));
  },
};

describe('Axios compatibility matrix (@nestjs/axios vs nestjs-axios-undici)', () => {
  let server: Server;
  let base: string;
  const modules: TestingModule[] = [];
  let axiosService: AxiosHttpService;
  let undiciService: UndiciHttpService;

  const compile = async (imports: any[], providers: any[] = []) => {
    const module = await Test.createTestingModule({
      imports,
      providers,
    }).compile();
    modules.push(module);
    return module;
  };

  const first = (source: any): Promise<any> => firstValueFrom(source);

  /** Runs the same call against @nestjs/axios and this library. */
  const both = <R>(fn: (service: any) => Promise<R>) =>
    Promise.all([fn(axiosService), fn(undiciService)]);

  const echo = (response: { data: Echo }) => ({
    url: response.data.url,
    method: response.data.method,
    contentType: response.data.headers['content-type'],
    authorization: response.data.headers.authorization,
    xa: response.data.headers['x-a'],
    xb: response.data.headers['x-b'],
    body: response.data.body,
  });

  const errorOf = async (promise: Promise<unknown>): Promise<any> => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('Expected the request to fail');
  };

  const describeError = (error: any) => ({
    message: error.message,
    code: error.code,
    isAxiosError: axios.isAxiosError(error),
    isCancel: axios.isCancel(error),
    status: error.status,
    responseStatus: error.response?.status,
    responseData: error.response?.data,
    hasConfig: !!error.config,
    toJSON: typeof error.toJSON,
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        const path = new URL(req.url!, 'http://x').pathname;
        const route = Object.keys(routes).find(
          key => path === key || path.startsWith(`${key}/`),
        );
        if (route) return routes[route](req, res, body);
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    axiosService = (await compile([AxiosHttpModule.register({})])).get(
      AxiosHttpService,
    );
    undiciService = (await compile([UndiciHttpModule.register({})])).get(
      UndiciHttpService,
    );
  });

  afterAll(async () => {
    await Promise.all(modules.map(module => module.close()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  describe('HttpService methods', () => {
    it('request(config) with url/method/params/data', async () => {
      const [a, u] = await both(async s =>
        echo(
          await first(
            s.request({
              url: `${base}/echo`,
              method: 'post',
              params: { q: 1 },
              data: { a: 1 },
            }),
          ),
        ),
      );
      expect(u).toEqual(a);
      expect(u).toMatchObject({
        url: '/echo?q=1',
        method: 'POST',
        body: '{"a":1}',
      });
    });

    it('request(url, options) keeps working (undici-style call)', async () => {
      const response = await first(
        undiciService.request<Echo>(`${base}/echo`, {
          method: 'PUT',
          body: 'raw',
        }),
      );
      expect(response.data).toMatchObject({ method: 'PUT', body: 'raw' });
    });

    it.each(['get', 'delete', 'head'])('%s(url, config)', async method => {
      const [a, u] = await both(async s => {
        const response = await first(
          s[method](`${base}/echo`, { headers: { 'X-A': '1' } }),
        );
        return {
          status: response.status,
          method: method === 'head' ? 'HEAD' : response.data.method,
        };
      });
      expect(u).toEqual(a);
    });

    it.each(['post', 'put', 'patch'])('%s(url, data, config)', async method => {
      const [a, u] = await both(async s =>
        echo(
          await first(
            s[method](`${base}/echo`, { a: 1 }, { headers: { 'X-A': '1' } }),
          ),
        ),
      );
      expect(u).toEqual(a);
    });

    it('delete(url, { data }) sends a body', async () => {
      const [a, u] = await both(async s =>
        echo(await first(s.delete(`${base}/echo`, { data: { a: 1 } }))),
      );
      expect(u).toEqual(a);
    });

    it('postForm with a FormData instance sends multipart', async () => {
      const [a, u] = await both(async s => {
        const form = new FormData();
        form.append('field', 'value');
        const result = echo(await first(s.postForm(`${base}/echo`, form)));
        return {
          contentType: result.contentType.split(';')[0],
          hasField: result.body.includes('name="field"'),
        };
      });
      expect(u).toEqual(a);
    });

    it('postForm(url, object) is multipart, matching axios (fixed: plan.md phase 2 "feat(axiosRef): make it a real axios instance")', async () => {
      const [a, u] = await both(async s => {
        const result = echo(
          await first(s.postForm(`${base}/echo`, { a: 1, b: 'x y' })),
        );
        return {
          contentType: result.contentType.split(';')[0],
          hasA: result.body.includes('name="a"'),
          hasB: result.body.includes('name="b"'),
        };
      });
      expect(u).toEqual(a);
    });
  });

  describe('Request config', () => {
    it.each([
      ['simple', { a: 1, b: 'x y', skipped: undefined, empty: null }],
      [
        'arrays, nested objects and dates',
        {
          arr: [1, 2],
          obj: { k: 'v', n: { m: 1 } },
          dt: new Date(0),
          s: 'a:b,c$[]',
          list: [{ x: 1 }],
        },
      ],
      ['URLSearchParams', new URLSearchParams({ q: 'x' })],
    ])('params: %s', async (_label, params) => {
      const [a, u] = await both(async s =>
        echo(await first(s.get(`${base}/echo?pre=1`, { params }))),
      );
      expect(u.url).toBe(a.url);
    });

    it.each([
      ['function', (p: any) => `custom=${p.a}`],
      ['{ indexes: true }', { indexes: true }],
      ['{ indexes: null }', { indexes: null }],
    ])('paramsSerializer: %s', async (_label, paramsSerializer) => {
      const [a, u] = await both(async s =>
        echo(
          await first(
            s.get(`${base}/echo`, { params: { a: [1, 2] }, paramsSerializer }),
          ),
        ),
      );
      expect(u.url).toBe(a.url);
    });

    it('baseURL with a path prefix (axios concatenates, it does not resolve)', async () => {
      const [a, u] = await both(async s =>
        echo(await first(s.get('users', { baseURL: `${base}/echo/v1/` }))),
      );
      expect(u).toEqual(a);
      expect(u.url).toBe('/echo/v1/users');
    });

    it('headers: plain object and AxiosHeaders instance', async () => {
      const [a, u] = await both(async s =>
        echo(
          await first(
            s.get(`${base}/echo`, {
              headers:
                s === axiosService
                  ? { 'X-A': '1', 'X-B': '2' }
                  : new AxiosHeaders({ 'X-A': '1', 'X-B': '2' }),
            }),
          ),
        ),
      );
      expect(u).toEqual(a);
    });

    it('auth becomes a Basic Authorization header', async () => {
      const [a, u] = await both(async s =>
        echo(
          await first(
            s.get(`${base}/echo`, { auth: { username: 'u', password: 'p' } }),
          ),
        ),
      );
      expect(u).toEqual(a);
    });

    it.each([
      ['object => JSON', { a: 1 }, undefined],
      ['string', 'raw=string', undefined],
      ['URLSearchParams', new URLSearchParams({ a: '1', b: '2' }), undefined],
      ['Buffer', Buffer.from('buffer body'), undefined],
      [
        'object with urlencoded Content-Type',
        { a: 1, b: 'x' },
        { 'Content-Type': 'application/x-www-form-urlencoded' },
      ],
    ])('data serialization: %s', async (_label, data, headers) => {
      const [a, u] = await both(async s =>
        echo(await first(s.post(`${base}/echo`, data, { headers }))),
      );
      expect(u).toEqual(a);
    });

    it('data serialization: FormData => multipart', async () => {
      const [a, u] = await both(async s => {
        const form = new FormData();
        form.append('k', 'v');
        const result = echo(await first(s.post(`${base}/echo`, form)));
        return {
          contentType: result.contentType.split(';')[0],
          hasField: result.body.includes('name="k"'),
        };
      });
      expect(u).toEqual(a);
    });

    it('data serialization: `form-data` package => multipart with its boundary', async () => {
      const [a, u] = await both(async s => {
        const form = new NodeFormData();
        form.append('k', 'v');
        const result = echo(await first(s.post(`${base}/echo`, form)));
        return {
          contentType:
            result.contentType ===
            `multipart/form-data; boundary=${form.getBoundary()}`,
          hasField: result.body.includes('name="k"'),
        };
      });
      expect(u).toEqual(a);
      expect(u).toEqual({ contentType: true, hasField: true });
    });

    it('validateStatus per request', async () => {
      const [a, u] = await both(
        async s =>
          (
            await first(
              s.get(`${base}/status?code=404`, { validateStatus: () => true }),
            )
          ).status,
      );
      expect(u).toBe(a);
    });

    it('maxRedirects: 0 surfaces the 3xx response', async () => {
      const [a, u] = await both(async s =>
        describeError(
          await errorOf(first(s.get(`${base}/redirect`, { maxRedirects: 0 }))),
        ),
      );
      expect(u).toEqual(a);
    });

    it('maxRedirects per request follows redirects', async () => {
      const [a, u] = await both(async s =>
        echo(await first(s.get(`${base}/redirect`, { maxRedirects: 5 }))),
      );
      expect(u).toEqual(a);
    });

    it('redirects are followed by default, like axios (up to 21)', async () => {
      const [a, u] = await both(async s =>
        echo(await first(s.get(`${base}/redirect`))),
      );
      expect(u).toEqual(a);
    });

    it.each(['text', 'arraybuffer', 'json'] as const)(
      'responseType: %s',
      async responseType => {
        const [a, u] = await both(async s => {
          const { data } = await first(
            s.get(`${base}/text-json`, { responseType }),
          );
          return {
            isBuffer: Buffer.isBuffer(data),
            value: Buffer.isBuffer(data) ? data.toString() : data,
          };
        });
        expect(u).toEqual(a);
      },
    );

    it('responseType: stream returns a readable stream', async () => {
      const [a, u] = await both(async s => {
        const { data } = await first(
          s.get(`${base}/echo`, { responseType: 'stream' }),
        );
        let text = '';
        for await (const chunk of data) text += chunk;
        return JSON.parse(text).method;
      });
      expect(u).toEqual(a);
    });

    it('signal (AbortController) cancels with ERR_CANCELED', async () => {
      const [a, u] = await both(async s => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 50);
        return describeError(
          await errorOf(
            first(s.get(`${base}/slow`, { signal: controller.signal })),
          ),
        );
      });
      expect(u).toEqual(a);
      expect(u).toMatchObject({
        code: 'ERR_CANCELED',
        message: 'canceled',
        isCancel: true,
      });
    });

    it('cancelToken cancels with the cancel message', async () => {
      const [a, u] = await both(async s => {
        const source = axios.CancelToken.source();
        setTimeout(() => source.cancel('stop'), 50);
        const error = await errorOf(
          first(s.get(`${base}/slow`, { cancelToken: source.token })),
        );
        return {
          code: error.code,
          message: error.message,
          isCancel: axios.isCancel(error),
        };
      });
      expect(u).toEqual(a);
    });

    /**
     * plan.md phase 2 (investigate: axios' "should able to cancel multiple
     * requests with CancelToken" upstream test) - root-caused: that upstream
     * test fails deterministically, in every environment including real CI
     * (confirmed against a GitHub Actions job log), because it calls
     * `axios.CancelToken.source()` where `axios` is *this library's own*
     * `axiosRef` (the upstream harness's strategy-(a) shim) - and
     * `axiosRef.CancelToken` (the legacy top-level class) was deliberately
     * dropped in the API trim (axios itself deprecates it in favour of
     * `AbortSignal`; the *shape*-level `config.cancelToken` support this
     * test actually exercises was never touched). Not a cancellation bug -
     * this test pins the real scenario (5 concurrent requests sharing one
     * `cancelToken`, cancelled synchronously right after they start) using
     * the real `axios` package's `CancelToken` (this file's own top-level
     * import) as the token source, which both services accept.
     */
    it('cancels multiple in-flight requests sharing one cancelToken', async () => {
      const [a, u] = await both(async s => {
        const source = axios.CancelToken.source();
        const canceled: number[] = [];
        const requests = [1, 2, 3, 4, 5].map(async id => {
          try {
            await first(s.get(`${base}/slow`, { cancelToken: source.token }));
          } catch (error: any) {
            if (!axios.isCancel(error)) throw error;
            canceled.push(id);
          }
        });
        source.cancel('Aborted by user');
        await Promise.all(requests);
        return canceled.sort();
      });
      expect(u).toEqual([1, 2, 3, 4, 5]);
      expect(u).toEqual(a);
    });

    it('timeout rejects with ECONNABORTED and the axios message', async () => {
      const error = await errorOf(
        firstValueFrom(undiciService.get(`${base}/slow`, { timeout: 200 })),
      );
      const axiosError = await errorOf(
        firstValueFrom(axiosService.get(`${base}/slow`, { timeout: 200 })),
      );
      expect(describeError(error)).toEqual(describeError(axiosError));
      expect(error.code).toBe('ECONNABORTED');
      expect(error.message).toBe('timeout of 200ms exceeded');
    });
  });

  describe('Response', () => {
    it('status, statusText and header access', async () => {
      const [a, u] = await both(async s => {
        const response = await first(s.get(`${base}/echo`));
        return {
          status: response.status,
          statusText: response.statusText,
          custom: response.headers['x-custom-header'],
          contentType: response.headers['content-type'],
        };
      });
      expect(u).toEqual(a);
    });

    it.each([
      ['invalid JSON => raw string', '/invalid-json'],
      ['empty JSON body => ""', '/empty-json'],
      ['204 => ""', '/status?code=204'],
    ])('data parsing: %s', async (_label, path) => {
      const [a, u] = await both(
        async s => (await first(s.get(`${base}${path}`))).data,
      );
      expect(u).toEqual(a);
    });

    it('JSON-looking strings are parsed regardless of content type, like axios', async () => {
      const [a, u] = await both(
        async s => (await first(s.get(`${base}/text-json`))).data,
      );
      expect(u).toEqual(a);
      expect(u).toEqual({ a: 1 });
    });

    it('unknown/text-ish content types decode to a UTF-8 string, like axios', async () => {
      const [a, u] = await both(
        async s => (await first(s.get(`${base}/octet`))).data,
      );
      expect(u).toEqual(a);
      expect(u).toBe('hello');
    });

    it('gzip responses are decompressed, like axios', async () => {
      const [a, u] = await both(s =>
        first(s.get(`${base}/gzip`)).then(r => r.data),
      );
      expect(u).toEqual(a);
      expect(u).toEqual({ zipped: true });
    });

    it('documented difference: response.headers is a plain object (no .get())', async () => {
      const response = await firstValueFrom(undiciService.get(`${base}/echo`));
      expect((response.headers as any).get).toBeUndefined();
    });

    it('config exposes url, method and headers', async () => {
      const response = await firstValueFrom(
        undiciService.get(`${base}/echo`, { headers: { 'X-A': '1' } }),
      );
      expect(response.config.url).toBe(`${base}/echo`);
      // `config.method` is always lower-case, matching axios.
      expect(response.config.method).toBe('get');
      expect(response.config.headers).toMatchObject({ 'X-A': '1' });
    });
  });

  describe('Errors', () => {
    it.each([
      ['4xx => ERR_BAD_REQUEST', '/status?code=404'],
      ['5xx => ERR_BAD_RESPONSE', '/status?code=503'],
    ])('%s', async (_label, path) => {
      const [a, u] = await both(async s =>
        describeError(await errorOf(first(s.get(`${base}${path}`)))),
      );
      expect(u).toEqual(a);
    });

    it('ECONNREFUSED is an axios error with the network code', async () => {
      const [a, u] = await both(async s =>
        describeError(await errorOf(first(s.get('http://127.0.0.1:1/')))),
      );
      expect(u).toEqual(a);
      expect(u.code).toBe('ECONNREFUSED');
    });

    it('errors are instances of the exported AxiosError / CanceledError', async () => {
      const statusError = await errorOf(
        firstValueFrom(undiciService.get(`${base}/status?code=400`)),
      );
      expect(statusError).toBeInstanceOf(AxiosError);
      expect(statusError).toBeInstanceOf(Error);
      expect(statusError.name).toBe('AxiosError');
      expect(isAxiosError(statusError)).toBe(true);
      expect(statusError.toJSON()).toMatchObject({
        message: 'Request failed with status code 400',
        name: 'AxiosError',
        code: 'ERR_BAD_REQUEST',
        status: 400,
      });

      const controller = new AbortController();
      controller.abort();
      const canceled = await errorOf(
        firstValueFrom(
          undiciService.get(`${base}/slow`, { signal: controller.signal }),
        ),
      );
      expect(canceled).toBeInstanceOf(CanceledError);
      expect(isCancel(canceled)).toBe(true);
    });

    it('is an instance of the axios package AxiosError class when axios is installed (optional peer)', async () => {
      // Fixed by plan.md phase 2 "types: axios interop" - `axios` is now an
      // optional peer, and this package links its own AxiosError's
      // prototype onto axios' own AxiosError (lazily, at module load) when
      // axios is present, so `instanceof axios.AxiosError` holds too.
      const error = await errorOf(
        firstValueFrom(undiciService.get(`${base}/status?code=400`)),
      );
      expect(error instanceof axios.AxiosError).toBe(true);
      expect(axios.isAxiosError(error)).toBe(true);
    });
  });

  describe('axiosRef', () => {
    it('defaults.headers.common / per-method headers apply to requests', async () => {
      const [a, u] = await both(async s => {
        s.axiosRef.defaults.headers.common['X-A'] = 'common';
        s.axiosRef.defaults.headers.post['X-B'] = 'post-only';
        try {
          return [
            echo(await first(s.get(`${base}/echo`))),
            echo(await first(s.post(`${base}/echo`, { a: 1 }))),
          ];
        } finally {
          delete s.axiosRef.defaults.headers.common['X-A'];
          delete s.axiosRef.defaults.headers.post['X-B'];
        }
      });
      expect(u).toEqual(a);
    });

    it('default Accept/User-Agent headers can be overridden at runtime, the axios way', async () => {
      const [a, u] = await both(async s => {
        const beforeHeaders = (await first(s.get(`${base}/echo`))).data.headers;
        s.axiosRef.defaults.headers.common['User-Agent'] = 'my-test-agent/9.9';
        s.axiosRef.defaults.headers.common['Accept'] = 'application/xml';
        try {
          const afterHeaders = (await first(s.get(`${base}/echo`))).data
            .headers;
          return {
            hadDefaultsBefore: {
              accept: !!beforeHeaders.accept,
              userAgent: !!beforeHeaders['user-agent'],
            },
            userAgent: afterHeaders['user-agent'],
            accept: afterHeaders.accept,
          };
        } finally {
          delete s.axiosRef.defaults.headers.common['User-Agent'];
          delete s.axiosRef.defaults.headers.common['Accept'];
        }
      });
      expect(u).toEqual(a);
      expect(u.userAgent).toBe('my-test-agent/9.9');
      expect(u.accept).toBe('application/xml');
    });

    it('promise methods: get/post/request', async () => {
      const [a, u] = await both(async s => [
        echo(await s.axiosRef.get(`${base}/echo`)),
        echo(await s.axiosRef.post(`${base}/echo`, { a: 1 })),
        echo(
          await s.axiosRef.request({
            url: `${base}/echo`,
            method: 'put',
            data: 'x',
          }),
        ),
      ]);
      expect(u).toEqual(a);
    });

    /**
     * CodeRabbit review finding: `axiosRef(config)` overload detection used
     * to require a `url` key on `config` to recognise the `axiosRef(config)`
     * call form - a config with `baseURL` but no `url` (perfectly valid
     * axios usage) fell through to the "this is a raw URL" branch instead
     * and got stringified to `"[object Object]"`.
     */
    it('axiosRef({ baseURL, method }) with no url key hits baseURL directly, like real axios', async () => {
      const [a, u] = await both(async s =>
        echo(await s.axiosRef({ baseURL: `${base}/echo`, method: 'get' })),
      );
      expect(u).toEqual(a);
      expect(u.url).toBe('/echo');
      expect(u.method).toBe('GET');
    });

    it('axiosRef({ method }) with no url/baseURL at all: a request interceptor that sets config.url still works', async () => {
      const [a, u] = await both(async s => {
        const id = s.axiosRef.interceptors.request.use((config: any) => {
          config.url = `${base}/echo`;
          return config;
        });
        try {
          return echo(await s.axiosRef({ method: 'get' }));
        } finally {
          s.axiosRef.interceptors.request.eject(id);
        }
      });
      expect(u).toEqual(a);
      expect(u.url).toBe('/echo');
    });

    /**
     * CodeRabbit review finding: `axiosRef.create(config)` merged `config`
     * onto module options for `baseURL`/`timeout`/`maxRedirects`/headers/...
     * but silently dropped `auth`, `maxContentLength`, `maxBodyLength`,
     * `timeoutErrorMessage`, `decompress`, `socketPath`, `allowAbsoluteUrls`
     * and `beforeRedirect` - `create({ auth })` sent no credentials, and
     * `create({ maxContentLength })` enforced nothing, because
     * `normalizeAxiosRequest`/`buildAxiosConfig` only ever read those off
     * module/instance options, never off the child instance's own
     * `defaults`.
     */
    it('axiosRef.create({ auth }) sends Basic auth, like real axios', async () => {
      const [a, u] = await both(async s => {
        const child = s.axiosRef.create({
          auth: { username: 'alice', password: 'secret' },
        });
        return echo(await child.get(`${base}/echo`));
      });
      expect(u).toEqual(a);
      expect(u.authorization).toBe(
        `Basic ${Buffer.from('alice:secret').toString('base64')}`,
      );
    });

    it('axiosRef.create({ maxContentLength }) enforces the limit on that child instance', async () => {
      const [a, u] = await both(async s => {
        const child = s.axiosRef.create({ maxContentLength: 5 });
        return errorOf(child.get(`${base}/echo`));
      });
      expect(describeError(u)).toEqual(describeError(a));
      expect(u.code).toBe('ERR_BAD_RESPONSE');
      expect(u.message).toBe('maxContentLength size of 5 exceeded');
    });

    it('a runtime axiosRef.defaults.maxContentLength assignment (no create()) is also honoured', async () => {
      const [a, u] = await both(async s => {
        s.axiosRef.defaults.maxContentLength = 5;
        try {
          return await errorOf(s.axiosRef.get(`${base}/echo`));
        } finally {
          delete s.axiosRef.defaults.maxContentLength;
        }
      });
      expect(describeError(u)).toEqual(describeError(a));
      expect(u.code).toBe('ERR_BAD_RESPONSE');
    });

    it("axiosRef.create({ beforeRedirect }) is called on that child instance's redirects", async () => {
      const [a, u] = await both(async s => {
        const seen: string[] = [];
        const child = s.axiosRef.create({
          beforeRedirect: (options: any) => {
            seen.push(options.path);
          },
        });
        await child.get(`${base}/redirect`);
        return seen;
      });
      expect(u).toEqual(a);
      expect(u).toEqual(['/echo/after-redirect']);
    });

    it('interceptors.request.eject and clear remove interceptors', async () => {
      const [a, u] = await both(async s => {
        const id = s.axiosRef.interceptors.request.use((config: any) => {
          config.headers['X-A'] = 'ejected';
          return config;
        });
        s.axiosRef.interceptors.request.eject(id);
        s.axiosRef.interceptors.request.use((config: any) => {
          config.headers['X-B'] = 'cleared';
          return config;
        });
        s.axiosRef.interceptors.request.clear();
        const responseId = s.axiosRef.interceptors.response.use(() => {
          throw new Error('should have been ejected');
        });
        s.axiosRef.interceptors.response.eject(responseId);
        return echo(await first(s.get(`${base}/echo`)));
      });
      expect(u).toEqual(a);
      expect(u.xa).toBeUndefined();
    });

    it('request interceptors keep per-request options (validateStatus, responseType)', async () => {
      const service = (await compile([UndiciHttpModule.register({})])).get(
        UndiciHttpService,
      );
      service.axiosRef.interceptors.request.use(config => config);
      const response = await first(
        service.get(`${base}/status?code=404`, {
          validateStatus: () => true,
          responseType: 'text',
        }),
      );
      expect(response.status).toBe(404);
      expect(response.data).toBe('{"status":404}');
    });

    it('axiosRef interceptors run in axios order: request LIFO, response FIFO', async () => {
      const service = (await compile([UndiciHttpModule.register({})])).get(
        UndiciHttpService,
      );
      const order: string[] = [];
      service.axiosRef.interceptors.request.use(
        config => (order.push('req1'), config),
      );
      service.axiosRef.interceptors.request.use(
        config => (order.push('req2'), config),
      );
      service.axiosRef.interceptors.response.use(
        response => (order.push('res1'), response),
      );
      service.axiosRef.interceptors.response.use(
        response => (order.push('res2'), response),
      );
      await firstValueFrom(service.get(`${base}/echo`));
      expect(order).toEqual(['req2', 'req1', 'res1', 'res2']);
    });

    it('unsubscribing aborts the in-flight request (fixed: previously ran to completion)', async () => {
      let resolveClosed!: (finished: boolean) => void;
      const closed = new Promise<boolean>(resolve => {
        resolveClosed = resolve;
      });
      const slowServer = createServer((_req, res) => {
        res.on('close', () => resolveClosed(res.writableFinished));
        setTimeout(() => {
          if (!res.writableEnded && !res.destroyed) res.end('done');
        }, 300);
      });
      await new Promise<void>(resolve =>
        slowServer.listen(0, '127.0.0.1', resolve),
      );
      const url = `http://127.0.0.1:${(slowServer.address() as AddressInfo).port}/`;

      // Wait for the connection to actually reach the server before
      // unsubscribing, so the abort can't win the race against the socket
      // ever being opened.
      const started = new Promise<void>(resolve =>
        slowServer.once('request', () => resolve()),
      );
      const subscription = undiciService
        .get(url)
        .subscribe({ error: () => undefined });
      await started;
      subscription.unsubscribe();

      // Resolves once the server observes the connection close; the response
      // must not have been written, since the client aborted before it.
      expect(await closed).toBe(false);

      slowServer.closeAllConnections();
      await new Promise<void>(resolve => slowServer.close(() => resolve()));
    });
  });

  describe('HttpModule', () => {
    const moduleOptions = () => ({
      baseURL: `${base}/echo/api`,
      headers: { 'X-A': 'module' },
      auth: { username: 'm', password: 'p' },
      params: { apiKey: 'k' },
    });

    it('register(): baseURL with path, headers merged with per-request headers, auth, params', async () => {
      const axiosModuleService = (
        await compile([AxiosHttpModule.register(moduleOptions())])
      ).get(AxiosHttpService);
      const undiciModuleService = (
        await compile([UndiciHttpModule.register(moduleOptions())])
      ).get(UndiciHttpService);
      const call = async (s: any) => [
        echo(await first(s.get('/users', { headers: { 'X-B': 'request' } }))),
        echo(await first(s.post('users', { a: 1 }))),
      ];
      expect(await call(undiciModuleService)).toEqual(
        await call(axiosModuleService),
      );
    });

    it('registerAsync(useFactory) applies axios options (baseURL, headers, timeout)', async () => {
      const factory = () => ({ ...moduleOptions(), timeout: 200 });
      const axiosModuleService = (
        await compile([AxiosHttpModule.registerAsync({ useFactory: factory })])
      ).get(AxiosHttpService);
      const undiciModuleService = (
        await compile([UndiciHttpModule.registerAsync({ useFactory: factory })])
      ).get(UndiciHttpService);
      const call = async (s: any) => [
        echo(await first(s.get('/users'))),
        (await errorOf(first(s.get(`${base}/slow`)))).code,
      ];
      expect(await call(undiciModuleService)).toEqual(
        await call(axiosModuleService),
      );
    });

    it('registerAsync(useClass / useExisting + extraProviders + global)', async () => {
      @Injectable()
      class OptionsFactory implements HttpModuleOptionsFactory {
        createHttpOptions() {
          return { baseURL: `${base}/echo/from-class` };
        }
      }

      @Module({ providers: [OptionsFactory], exports: [OptionsFactory] })
      class OptionsModule {}

      const withClass = (
        await compile([
          UndiciHttpModule.registerAsync({
            useClass: OptionsFactory,
            extraProviders: [{ provide: 'EXTRA', useValue: 'extra' }],
          }),
        ])
      ).get(UndiciHttpService);
      expect(echo(await firstValueFrom(withClass.get('/x'))).url).toBe(
        '/echo/from-class/x',
      );

      const withExisting = (
        await compile([
          UndiciHttpModule.registerAsync({
            imports: [OptionsModule],
            useExisting: OptionsFactory,
            global: true,
          }),
        ])
      ).get(UndiciHttpService);
      expect(echo(await firstValueFrom(withExisting.get('/y'))).url).toBe(
        '/echo/from-class/y',
      );
      expect(
        UndiciHttpModule.registerAsync({
          useClass: OptionsFactory,
          global: true,
        }).global,
      ).toBe(true);
      expect(UndiciHttpModule.register({ global: true }).global).toBe(true);
    });

    it('transformRequest/transformResponse see raw data/raw string, like axios', async () => {
      const seen: Record<string, unknown[]> = { axios: [], undici: [] };
      const options = (key: string) => ({
        transformRequest: [
          (data: unknown) => (
            seen[key].push(data),
            typeof data === 'string' ? data : JSON.stringify(data)
          ),
        ],
        transformResponse: [(data: unknown) => (seen[key].push(data), data)],
      });
      const axiosModuleService = (
        await compile([AxiosHttpModule.register(options('axios'))])
      ).get(AxiosHttpService);
      const undiciModuleService = (
        await compile([UndiciHttpModule.register(options('undici'))])
      ).get(UndiciHttpService);
      await firstValueFrom(axiosModuleService.post(`${base}/echo`, { a: 1 }));
      await firstValueFrom(undiciModuleService.post(`${base}/echo`, { a: 1 }));
      // transformRequest gets the raw, unserialised data (an object)...
      expect(seen.axios[0]).toEqual({ a: 1 });
      expect(seen.undici[0]).toEqual({ a: 1 });
      // ...and transformResponse gets the raw, unparsed body (a string).
      expect(typeof seen.axios[1]).toBe('string');
      expect(typeof seen.undici[1]).toBe('string');
    });

    it('options(url, config) (not available in @nestjs/axios)', async () => {
      const response = await firstValueFrom(
        undiciService.options<Echo>(`${base}/echo`),
      );
      expect(response.data.method).toBe('OPTIONS');
    });

    it('HttpModule imported without register()', async () => {
      const service = (await compile([UndiciHttpModule])).get(
        UndiciHttpService,
      );
      const response = await firstValueFrom(service.get<Echo>(`${base}/echo`));
      expect(response.status).toBe(200);
    });

    it('maxContentLength keeps the emitted value a response (rxjs map works)', async () => {
      const service = (
        await compile([UndiciHttpModule.register({ maxContentLength: 10_000 })])
      ).get(UndiciHttpService);
      const method = await lastValueFrom(
        service
          .get<Echo>(`${base}/echo`)
          .pipe(map(response => response.data.method)),
      );
      expect(method).toBe('GET');
    });
  });
});
