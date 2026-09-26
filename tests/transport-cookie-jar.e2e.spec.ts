/**
 * Covers plan.md phase 2 "breaking: withCredentials becomes a no-op; add
 * cookieJar" - the opt-in `cookieJar` module option. `withCredentials`
 * itself is covered in axios-options-compatibility.e2e.spec.ts (it's a
 * no-op there, matching axios on Node.js).
 *
 * Design decisions this file exercises:
 * - `cookieJar` only accepts a `tough-cookie` `CookieJar` *instance*, never
 *   `true`. A `true` shorthand that built one jar per service would
 *   reintroduce the exact bug this option replaces (a jar shared by every
 *   caller of that service, leaking cookies between them) - the caller must
 *   own the jar's scope explicitly.
 * - There's no per-request `cookieJar`: wiring one up builds a `CookieAgent`
 *   (wrapping whatever dispatcher the module built), which only happens once
 *   per `HttpService`, in its constructor - never on the request path.
 * - `http-cookie-agent`/`tough-cookie` are optional peer dependencies,
 *   `require()`d lazily only when `cookieJar` is actually set; a missing
 *   peer throws a clear, actionable error instead of an opaque
 *   `Cannot find module`.
 */
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom, lastValueFrom } from 'rxjs';
import { Agent as HttpAgent } from 'node:http';
import { CookieJar } from 'tough-cookie';
import { HttpModule, HttpService } from '../src';

describe('HttpService cookieJar', () => {
  let server: Server;
  let base: string;
  const modules: TestingModule[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url || '';
      if (url === '/login') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'sid=abc123; Path=/',
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url === '/whoami') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all(modules.map(m => m.close()));
    await new Promise(resolve => server.close(resolve));
  });

  const makeService = async (options: any): Promise<HttpService> => {
    const module = await Test.createTestingModule({
      imports: [HttpModule.register(options)],
    }).compile();
    modules.push(module);
    return module.get(HttpService);
  };

  it('stores and replays cookies through a caller-supplied jar', async () => {
    const service = await makeService({ cookieJar: new CookieJar() });

    await firstValueFrom(service.get(`${base}/login`));
    const whoami: any = await firstValueFrom(service.get(`${base}/whoami`));

    expect(whoami.data.cookie).toBe('sid=abc123');
  });

  it('two services with separate jars do not share cookies', async () => {
    const serviceA = await makeService({ cookieJar: new CookieJar() });
    const serviceB = await makeService({ cookieJar: new CookieJar() });

    // Only serviceA logs in and picks up the cookie.
    await firstValueFrom(serviceA.get(`${base}/login`));

    const whoamiA: any = await firstValueFrom(serviceA.get(`${base}/whoami`));
    expect(whoamiA.data.cookie).toBe('sid=abc123');

    // serviceB has its own jar and never logged in, so it must not see the
    // cookie serviceA's jar stored - the leak a single jar shared by every
    // caller (the old `withCredentials: true` behaviour) caused. (An empty
    // string, not absent: `CookieAgent` always sets a `Cookie` header once a
    // jar is configured, even when that jar has nothing to send yet.)
    const whoamiB: any = await firstValueFrom(serviceB.get(`${base}/whoami`));
    expect(whoamiB.data.cookie).toBe('');
  });

  it('a cookieJar shared on purpose IS shared - the caller chose that scope', async () => {
    const jar = new CookieJar();
    const serviceA = await makeService({ cookieJar: jar });
    const serviceB = await makeService({ cookieJar: jar });

    await firstValueFrom(serviceA.get(`${base}/login`));
    const whoamiB: any = await firstValueFrom(serviceB.get(`${base}/whoami`));

    expect(whoamiB.data.cookie).toBe('sid=abc123');
  });

  it('wraps a base dispatcher built from other transport options (httpAgent)', async () => {
    const service = await makeService({
      cookieJar: new CookieJar(),
      httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 4 }),
    });

    await firstValueFrom(service.get(`${base}/login`));
    const whoami: any = await firstValueFrom(service.get(`${base}/whoami`));

    expect(whoami.data.cookie).toBe('sid=abc123');
  });

  it('registerAsync: a jar from a factory works', async () => {
    const module = await Test.createTestingModule({
      imports: [
        HttpModule.registerAsync({
          useFactory: async () => ({ cookieJar: new CookieJar() }),
        }),
      ],
    }).compile();
    modules.push(module);
    const service = module.get(HttpService);

    await firstValueFrom(service.get(`${base}/login`));
    const whoami: any = await firstValueFrom(service.get(`${base}/whoami`));
    expect(whoami.data.cookie).toBe('sid=abc123');
  });

  it('rejects a cookieJar that is not a CookieJar at setup', async () => {
    await expect(makeService({ cookieJar: { notAJar: true } })).rejects.toThrow(
      'cookieJar must be a tough-cookie CookieJar instance',
    );
  });

  it('throws a clear error when the optional peers are not installed', () => {
    try {
      jest.isolateModules(() => {
        jest.doMock('http-cookie-agent/undici', () => {
          throw new Error("Cannot find module 'http-cookie-agent/undici'");
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module graph for the mocked peer
        const { HttpService: IsolatedHttpService } = require('../src');
        expect(
          () =>
            new IsolatedHttpService({}, { cookieJar: new CookieJar() } as any),
        ).toThrow(
          'cookieJar requires the optional peer dependencies http-cookie-agent and tough-cookie; ' +
            'install them with npm i http-cookie-agent tough-cookie',
        );
      });
    } finally {
      // `jest.doMock` registers into the shared mock registry, which
      // `isolateModules` does NOT undo on its own (it only isolates which
      // *module instances* later `require()`s see) - without this, every
      // later `require('http-cookie-agent/undici')` in this file would
      // still throw.
      jest.dontMock('http-cookie-agent/undici');
    }
  });
});

describe('HttpService cookieJar - per-request is not supported (module-level only)', () => {
  it('a per-request cookieJar is ignored; the module-level jar (if any) still applies', async () => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const module = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    const service = module.get(HttpService);

    // No module-level cookieJar was configured, so this request-level one
    // (undocumented, unsupported) is simply ignored - the request still
    // goes through the plain dispatcher, not a CookieAgent.
    const response = await lastValueFrom(
      service.get(base, { cookieJar: new CookieJar() } as any),
    );
    expect(response.status).toBe(200);

    await module.close();
    await new Promise(resolve => server.close(resolve));
  });
});
