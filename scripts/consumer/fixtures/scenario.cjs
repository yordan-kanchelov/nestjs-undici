'use strict';
// Consumer smoke scenario, shared by smoke.cjs (require) and smoke.mjs (import).
// Plain JS on purpose: decorators are applied by hand, so no build step is needed.
const assert = require('node:assert/strict');
const http = require('node:http');

module.exports = async function run({ lib, common, core, rxjs, label }) {
  const { HttpModule, HttpService, AxiosError, isAxiosError } = lib;
  const { Injectable, Inject, Module } = common;
  const { NestFactory } = core;
  const { firstValueFrom, Observable } = rxjs;
  for (const [name, value] of Object.entries({
    HttpModule,
    HttpService,
    AxiosError,
    isAxiosError,
  }))
    assert.ok(value, `${label}: named export ${name} is missing`);

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/redirect') {
        res.writeHead(302, { Location: '/echo?redirected=1' });
        return res.end();
      }
      if (url.pathname === '/login') {
        res.writeHead(200, { 'Set-Cookie': 'sid=abc; Path=/' });
        return res.end('ok');
      }
      if (url.pathname.startsWith('/status/')) {
        res.writeHead(Number(url.pathname.slice(8)), {
          'Content-Type': 'application/json',
        });
        return res.end('{"err":true}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        }),
      );
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // A class interceptor with a DI dependency, decorated by hand
  const TOKEN = 'TOKEN';
  class TokenService {
    get() {
      return 'di-token';
    }
  }
  Injectable()(TokenService);
  class TokenModule {}
  Module({
    providers: [TokenService, { provide: TOKEN, useValue: 'cfg' }],
    exports: [TokenService, TOKEN],
  })(TokenModule);
  class AuthInterceptor {
    constructor(tokens) {
      this.tokens = tokens;
    }
    intercept(request, next) {
      request.options.headers = {
        ...request.options.headers,
        authorization: `Bearer ${this.tokens.get()}`,
      };
      return next.handle(request);
    }
  }
  Inject(TokenService)(AuthInterceptor, undefined, 0);
  Injectable()(AuthInterceptor);

  const fnInterceptor = (request, next) => {
    request.options.headers = { ...request.options.headers, 'x-fn': '1' };
    return next.handle(request);
  };

  class SyncHttp {}
  Module({
    imports: [
      HttpModule.register({
        baseURL: base,
        headers: { 'X-Module': 'm' },
        maxRedirects: 5,
        withCredentials: true,
        interceptors: [fnInterceptor],
      }),
    ],
    exports: [HttpModule],
  })(SyncHttp);
  class AsyncHttp {}
  Module({
    imports: [
      HttpModule.registerAsync({
        imports: [TokenModule],
        inject: [TOKEN],
        useFactory: cfg => ({
          baseURL: `${base}/async-${cfg}`,
          interceptors: [AuthInterceptor],
        }),
      }),
    ],
    exports: [HttpModule],
  })(AsyncHttp);

  // Two consumers, each injecting HttpService from its own module
  class SyncClient {
    constructor(http) {
      this.http = http;
    }
  }
  Inject(HttpService)(SyncClient, undefined, 0);
  Injectable()(SyncClient);
  class AsyncClient {
    constructor(http) {
      this.http = http;
    }
  }
  Inject(HttpService)(AsyncClient, undefined, 0);
  Injectable()(AsyncClient);
  class SyncFeature {}
  Module({
    imports: [SyncHttp],
    providers: [SyncClient],
    exports: [SyncClient],
  })(SyncFeature);
  class AsyncFeature {}
  Module({
    imports: [AsyncHttp],
    providers: [AsyncClient],
    exports: [AsyncClient],
  })(AsyncFeature);
  class AppModule {}
  Module({ imports: [SyncFeature, AsyncFeature] })(AppModule);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const sync = app.get(SyncClient).http;
    const asyncSvc = app.get(AsyncClient).http;

    // register(): get with baseURL + module headers + function interceptor
    let r = await firstValueFrom(sync.get('/echo', { params: { q: 1 } }));
    assert.equal(r.status, 200);
    assert.equal(r.data.url, '/echo?q=1');
    assert.equal(r.data.headers['x-module'], 'm');
    assert.equal(r.data.headers['x-fn'], '1');

    // post JSON
    r = await firstValueFrom(sync.post('/echo', { a: 1 }));
    assert.equal(r.data.body, '{"a":1}');
    assert.match(r.data.headers['content-type'], /application\/json/);

    // axiosRef interceptors (axios-style)
    const id = sync.axiosRef.interceptors.request.use(c => {
      c.headers['X-Axios-Ref'] = 'yes';
      return c;
    });
    r = await sync.axiosRef.get('/echo');
    assert.equal(r.data.headers['x-axios-ref'], 'yes');
    sync.axiosRef.interceptors.request.eject(id);

    // redirects
    r = await firstValueFrom(sync.get('/redirect'));
    assert.equal(r.data.url, '/echo?redirected=1');

    // withCredentials is a no-op (matches axios on Node); no cookie jar peer is
    // installed here (http-cookie-agent/tough-cookie are optional), and none is needed
    // to prove this.
    await firstValueFrom(sync.get('/login'));
    r = await firstValueFrom(sync.get('/echo'));
    assert.equal(r.data.headers.cookie, undefined);

    // errors
    const error = await firstValueFrom(sync.get('/status/404')).then(
      () => null,
      e => e,
    );
    assert.ok(error, 'expected 404 to reject');
    assert.ok(error instanceof AxiosError, 'instanceof exported AxiosError');
    assert.ok(isAxiosError(error));
    assert.equal(error.code, 'ERR_BAD_REQUEST');
    assert.equal(error.response.status, 404);
    const refused = await firstValueFrom(sync.get('http://127.0.0.1:1/')).then(
      () => null,
      e => e,
    );
    assert.equal(refused?.code, 'ECONNREFUSED');

    // registerAsync(): useFactory + inject + class interceptor with DI
    r = await firstValueFrom(asyncSvc.get('/echo'));
    assert.equal(r.data.url, '/async-cfg/echo');
    assert.equal(r.data.headers.authorization, 'Bearer di-token');

    // Observable identity: consumers' rxjs operators work on our Observable
    assert.ok(
      sync.get('/echo') instanceof Observable,
      'returns the consumer rxjs Observable',
    );
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
  return 'ok';
};
