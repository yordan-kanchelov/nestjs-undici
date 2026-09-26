/**
 * Covers plan.md phase 2 "fix(config): transport options" - proxy support:
 * an explicit `proxy: {...}` (already an undici `ProxyAgent`), and the
 * `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` environment variables axios reads
 * via `proxy-from-env` when `proxy` is not set (`EnvHttpProxyAgent`,
 * available in undici 7 and 8).
 *
 * The proxy itself is a plain `http.createServer` that forwards absolute-
 * form requests (`GET http://host/path HTTP/1.1`), as a real forward proxy
 * would for a plaintext target.
 *
 * This sandbox may itself have HTTP_PROXY/HTTPS_PROXY set, and other test
 * files must never be routed through it: every env var this suite touches
 * is saved before, and restored after, each test.
 */
import { createServer, request as httpRequest, Server } from 'node:http';
import { AddressInfo, connect as netConnect } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { Agent as UndiciAgent } from 'undici';
import { Agent as HttpsAgent } from 'node:https';
import { HttpModule, HttpService } from '../src';

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

describe('HttpService proxy support', () => {
  let target: Server;
  let targetUrl: string;
  let proxy: Server;
  let proxyUrl: string;
  let proxyHost: string;
  let proxyPort: number;
  let proxied: Array<{ url: string; host?: string }>;
  let tunnels: string[];
  let tlsTarget: Server;
  let tlsTargetUrl: string;
  const modules: TestingModule[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    target = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

    // A minimal forward proxy: forwards absolute-form requests to their
    // target and pipes the response straight back.
    proxy = createServer((req, res) => {
      proxied.push({ url: req.url!, host: req.headers.host });
      const upstream = new URL(req.url!);
      const upstreamReq = httpRequest(
        {
          hostname: upstream.hostname,
          port: upstream.port,
          path: upstream.pathname + upstream.search,
          method: req.method,
          headers: req.headers,
        },
        upstreamRes => {
          res.writeHead(upstreamRes.statusCode!, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      req.pipe(upstreamReq);
    });
    // CONNECT tunnels, as used for an https target.
    proxy.on('connect', (req, clientSocket, head) => {
      tunnels.push(req.url!);
      const [host, port] = req.url!.split(':');
      const upstream = netConnect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));

    const fixtures = join(__dirname, 'fixtures', 'tls');
    tlsTarget = createHttpsServer(
      {
        cert: readFileSync(join(fixtures, 'server-cert.pem')),
        key: readFileSync(join(fixtures, 'server-key.pem')),
      },
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
    ) as unknown as Server;
    await new Promise<void>(resolve =>
      tlsTarget.listen(0, '127.0.0.1', resolve),
    );
    tlsTargetUrl = `https://127.0.0.1:${(tlsTarget.address() as AddressInfo).port}`;
    const addr = proxy.address() as AddressInfo;
    proxyHost = '127.0.0.1';
    proxyPort = addr.port;
    proxyUrl = `http://${proxyHost}:${proxyPort}`;
  });

  afterAll(async () => {
    await Promise.all(modules.map(m => m.close()));
    target.closeAllConnections();
    proxy.closeAllConnections();
    await new Promise(resolve => target.close(resolve));
    await new Promise(resolve => proxy.close(resolve));
    (tlsTarget as any).closeAllConnections?.();
    await new Promise(resolve => tlsTarget.close(resolve));
  });

  beforeEach(() => {
    proxied = [];
    tunnels = [];
    for (const key of PROXY_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const makeService = async (options: any = {}): Promise<HttpService> => {
    const module = await Test.createTestingModule({
      imports: [HttpModule.register(options)],
    }).compile();
    modules.push(module);
    return module.get(HttpService);
  };

  it('an explicit proxy object routes the request through it', async () => {
    const service = await makeService({
      proxy: { host: proxyHost, port: proxyPort },
    });
    const response = await firstValueFrom(service.get(targetUrl));
    expect(response.status).toBe(200);
    expect(proxied).toHaveLength(1);
    expect(proxied[0].url).toBe(targetUrl + '/');
  });

  it('HTTP_PROXY is read when no explicit proxy/dispatcher/agent is set', async () => {
    process.env.HTTP_PROXY = proxyUrl;
    const service = await makeService({});
    const response = await firstValueFrom(service.get(targetUrl));
    expect(response.status).toBe(200);
    expect(proxied).toHaveLength(1);
  });

  it('lower-case http_proxy is also read (axios/proxy-from-env is case-insensitive)', async () => {
    process.env.http_proxy = proxyUrl;
    const service = await makeService({});
    await firstValueFrom(service.get(targetUrl));
    expect(proxied).toHaveLength(1);
  });

  it('NO_PROXY excludes a matching host even with HTTP_PROXY set', async () => {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.NO_PROXY = '127.0.0.1';
    const service = await makeService({});
    const response = await firstValueFrom(service.get(targetUrl));
    expect(response.status).toBe(200);
    expect(proxied).toHaveLength(0);
  });

  it('proxy: false disables the HTTP_PROXY env var entirely', async () => {
    process.env.HTTP_PROXY = proxyUrl;
    const service = await makeService({ proxy: false });
    const response = await firstValueFrom(service.get(targetUrl));
    expect(response.status).toBe(200);
    expect(proxied).toHaveLength(0);
  });

  it('an explicit dispatcher wins over HTTP_PROXY', async () => {
    process.env.HTTP_PROXY = proxyUrl;
    const service = await makeService({ dispatcher: new UndiciAgent() });
    const response = await firstValueFrom(service.get(targetUrl));
    expect(response.status).toBe(200);
    expect(proxied).toHaveLength(0);
  });

  it('an explicit httpsAgent/httpAgent still picks up HTTP_PROXY, as in axios', async () => {
    process.env.HTTP_PROXY = proxyUrl;
    const service = await makeService({
      httpsAgent: new HttpsAgent({ rejectUnauthorized: false }),
    });
    const response = await firstValueFrom(service.get(targetUrl));
    expect(response.status).toBe(200);
    expect(proxied).toHaveLength(1);
  });

  it('httpsAgent TLS options apply to an https target reached through an explicit proxy', async () => {
    const proxyConfig = { protocol: 'http', host: proxyHost, port: proxyPort };
    const withTls = await makeService({
      proxy: proxyConfig,
      httpsAgent: new HttpsAgent({ rejectUnauthorized: false }),
    });
    const response = await firstValueFrom(withTls.get(tlsTargetUrl));
    expect(response.status).toBe(200);
    expect(tunnels).toHaveLength(1);

    const withoutTls = await makeService({ proxy: proxyConfig });
    const error = await firstValueFrom(withoutTls.get(tlsTargetUrl)).catch(
      e => e,
    );
    expect(error.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('a module-level socketPath does not also pick up HTTP_PROXY', async () => {
    const sockPath = join(
      tmpdir(),
      `nestjs-undici-proxy-test-${randomUUID()}.sock`,
    );
    const unixServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => unixServer.listen(sockPath, resolve));
    try {
      process.env.HTTP_PROXY = proxyUrl;
      const service = await makeService({ socketPath: sockPath });
      const response = await firstValueFrom(service.get('http://example.com/'));
      expect(response.status).toBe(200);
      // The proxy server never saw this request - it went straight over the
      // unix socket, not through HTTP_PROXY.
      expect(proxied).toHaveLength(0);
    } finally {
      await new Promise(resolve => unixServer.close(resolve));
      if (existsSync(sockPath)) unlinkSync(sockPath);
    }
  });

  it('with no HTTP_PROXY/HTTPS_PROXY set, requests to 127.0.0.1 go direct (no proxy overhead by default)', async () => {
    const service = await makeService({});
    const response = await firstValueFrom(service.get(targetUrl));
    expect(response.status).toBe(200);
    expect(proxied).toHaveLength(0);
  });
});
