import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import * as http from 'http';
import { AddressInfo } from 'net';

import { HttpService } from '../http.service';
import { HttpModule } from '../../http.module';

/**
 * Perf item 1 (per-method default/module header cache) and item 2
 * (interceptor chain cache) both cache work across requests. These tests
 * make sure the caching stays invisible from the outside: a header change or
 * an interceptor add/eject made *after* the first request through a service
 * still takes effect on the very next request.
 */
describe('HttpService - request-path caches stay live', () => {
  let service: HttpService;
  let module: TestingModule;
  let mockServer: http.Server;
  let serverUrl: string;

  const createMockServer = (handler: http.RequestListener): Promise<string> =>
    new Promise(resolve => {
      mockServer = http.createServer(handler);
      mockServer.listen(0, '127.0.0.1', () => {
        const port = (mockServer.address() as AddressInfo).port;
        resolve(`http://127.0.0.1:${port}`);
      });
    });

  beforeEach(async () => {
    serverUrl = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ headers: req.headers }));
    });

    module = await Test.createTestingModule({
      imports: [HttpModule.register()],
    }).compile();
    service = module.get<HttpService>(HttpService);
  });

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((resolve, reject) => {
        mockServer.close(err => (err ? reject(err) : resolve()));
        mockServer.closeAllConnections();
      });
    }
    if (module) await module.close();
  });

  it('a header set on axiosRef.defaults after the first request still applies', async () => {
    const before = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(before.data.headers['x-runtime']).toBeUndefined();

    // Populate the per-method header cache with the first request above,
    // then mutate both `common` and a method bucket (get) directly.
    service.axiosRef.defaults.headers.common['X-Runtime'] = 'common-value';
    service.axiosRef.defaults.headers.get['X-Runtime-Get'] = 'get-value';

    const after = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(after.data.headers['x-runtime']).toBe('common-value');
    expect(after.data.headers['x-runtime-get']).toBe('get-value');

    delete service.axiosRef.defaults.headers.common['X-Runtime'];
    delete service.axiosRef.defaults.headers.get['X-Runtime-Get'];
    const afterDelete = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(afterDelete.data.headers['x-runtime']).toBeUndefined();
    expect(afterDelete.data.headers['x-runtime-get']).toBeUndefined();
  });

  it('a flat header set directly on axiosRef.defaults.headers after the first request still applies', async () => {
    await firstValueFrom(service.get(`${serverUrl}/x`));

    (service.axiosRef.defaults.headers as any)['X-Flat'] = 'flat-value';
    const after = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(after.data.headers['x-flat']).toBe('flat-value');
  });

  it('replacing axiosRef.defaults.headers wholesale after the first request still applies', async () => {
    await firstValueFrom(service.get(`${serverUrl}/x`));

    const replacement = { common: { 'X-Replaced': 'r1' } };
    (service.axiosRef.defaults as any).headers = replacement;
    const after = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(after.data.headers['x-replaced']).toBe('r1');
    expect(after.data.headers['user-agent'] ?? '').not.toMatch(
      /nestjs-axios-undici/,
    );

    replacement.common['X-Replaced'] = 'r2';
    const again = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(again.data.headers['x-replaced']).toBe('r2');
  });

  it('mutating a held reference to a replaced bucket still applies', async () => {
    const bucket: Record<string, string> = { 'X-Held': 'h1' };
    // `common` is typed `AxiosHeaders` (matching axios' own
    // `AxiosInstance.defaults.headers`) but stays a plain object at runtime
    // - see the doc comment on `AxiosRefDefaults.headers` - so a plain
    // object is still exactly what's assigned here in practice; the cast is
    // only to satisfy the type.
    service.axiosRef.defaults.headers.common = bucket as any;
    const first = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(first.data.headers['x-held']).toBe('h1');

    bucket['X-Held'] = 'h2';
    const after = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(after.data.headers['x-held']).toBe('h2');
  });

  it('a header added with Object.defineProperty after the first request still applies', async () => {
    await firstValueFrom(service.get(`${serverUrl}/x`));

    Object.defineProperty(
      service.axiosRef.defaults.headers.common,
      'X-Defined',
      {
        value: 'd',
        enumerable: true,
        configurable: true,
      },
    );
    const after = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(after.data.headers['x-defined']).toBe('d');
  });

  it('module headers seed axiosRef.defaults at setup; mutating undiciRef afterwards no longer has any effect (request > defaults > module)', async () => {
    // Precedence change from PR #16 (plan.md "feat(axiosRef): make it a
    // real axios instance"): module options only ever *seed*
    // `axiosRef.defaults` once, at construction (`createAxiosRefDefaults`).
    // From then on `axiosRef.defaults` is the single source of truth, so a
    // later mutation of the raw module options object (`undiciRef`, a
    // lower-level, mostly-transport-focused handle) is no longer picked up -
    // use `axiosRef.defaults.headers` instead (covered by the other cases
    // in this file).
    const moduleWithHeaders = await Test.createTestingModule({
      imports: [
        HttpModule.register({ headers: { common: { 'X-Module': 'v1' } } }),
      ],
    }).compile();
    try {
      const svc = moduleWithHeaders.get<HttpService>(HttpService);
      const first = await firstValueFrom(svc.get(`${serverUrl}/x`));
      expect(first.data.headers['x-module']).toBe('v1');

      (svc.undiciRef as any).headers.common['X-Module'] = 'v2';
      const after = await firstValueFrom(svc.get(`${serverUrl}/x`));
      expect(after.data.headers['x-module']).toBe('v1');

      // The supported way to change it at runtime:
      (svc.axiosRef.defaults.headers.common as any)['X-Module'] = 'v3';
      const viaDefaults = await firstValueFrom(svc.get(`${serverUrl}/x`));
      expect(viaDefaults.data.headers['x-module']).toBe('v3');
    } finally {
      await moduleWithHeaders.close();
    }
  });

  it('adding an axiosRef request interceptor after the first request still applies', async () => {
    const before = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(before.data.headers['x-added']).toBeUndefined();

    service.axiosRef.interceptors.request.use(config => {
      config.headers = { ...(config.headers as any), 'X-Added': 'yes' };
      return config;
    });

    const after = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(after.data.headers['x-added']).toBe('yes');
  });

  it('ejecting an axiosRef request interceptor after the first request still applies', async () => {
    const id = service.axiosRef.interceptors.request.use(config => {
      config.headers = { ...(config.headers as any), 'X-Ejectable': 'yes' };
      return config;
    });

    const before = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(before.data.headers['x-ejectable']).toBe('yes');

    service.axiosRef.interceptors.request.eject(id);

    const after = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(after.data.headers['x-ejectable']).toBeUndefined();
  });

  it('setInterceptors after the first request still applies', async () => {
    await firstValueFrom(service.get(`${serverUrl}/x`));

    // `setInterceptors` is internal now (plan.md phase 3 "HttpService
    // members") - `http.module.ts` passes the resolved interceptor list into
    // the constructor instead of calling it. Reached here via a bracket-key
    // cast purely to exercise the cache-invalidation behaviour this test is
    // actually about.
    (service as unknown as { setInterceptors: (i: unknown[]) => void })[
      'setInterceptors'
    ]([
      (request, next) => {
        request.options.headers = {
          ...(request.options.headers as any),
          'X-Set-Interceptors': 'yes',
        };
        return next.handle(request);
      },
    ]);

    const after = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(after.data.headers['x-set-interceptors']).toBe('yes');
  });
});
