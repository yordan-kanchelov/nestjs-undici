/**
 * Covers plan.md phase 2 "fix(config): transport options" - `socketPath`,
 * module- and request-level: `Agent({ connect: { socketPath } })`, cached
 * per path. The request URL's host is only ever used for the `Host` header
 * (matching axios); the socket itself is a real unix domain socket in the
 * OS temp dir.
 */
import { Agent as HttpAgent, createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { HttpModule, HttpService } from '../src';

function socketPath(): string {
  return join(tmpdir(), `nestjs-undici-test-${randomUUID()}.sock`);
}

describe('HttpService socketPath', () => {
  let server: Server;
  let sockPath: string;
  const modules: TestingModule[] = [];

  beforeAll(async () => {
    sockPath = socketPath();
    server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          url: req.url,
          host: req.headers.host,
          method: req.method,
        }),
      );
    });
    await new Promise<void>(resolve => server.listen(sockPath, resolve));
  });

  afterAll(async () => {
    await Promise.all(modules.map(m => m.close()));
    await new Promise(resolve => server.close(resolve));
    if (existsSync(sockPath)) unlinkSync(sockPath);
  });

  const makeService = async (options: any = {}): Promise<HttpService> => {
    const module = await Test.createTestingModule({
      imports: [HttpModule.register(options)],
    }).compile();
    modules.push(module);
    return module.get(HttpService);
  };

  it('module-level socketPath dials the unix socket; the URL host becomes the Host header', async () => {
    const service = await makeService({ socketPath: sockPath });
    const response = await firstValueFrom(
      service.get('http://example.com/foo?x=1'),
    );
    expect(response.status).toBe(200);
    expect(response.data).toEqual({
      url: '/foo?x=1',
      host: 'example.com',
      method: 'GET',
    });
  });

  it('request-level socketPath works with no module-level socketPath', async () => {
    const service = await makeService({});
    const response = await firstValueFrom(
      service.get('http://example.com/bar', { socketPath: sockPath } as any),
    );
    expect(response.status).toBe(200);
    expect(response.data.url).toBe('/bar');
  });

  it('a non-existent socketPath fails the same way axios does (ENOENT)', async () => {
    const service = await makeService({
      socketPath: join(tmpdir(), `nestjs-undici-missing-${randomUUID()}.sock`),
    });
    await expect(
      firstValueFrom(service.get('http://localhost/echo')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('caches the dispatcher per socket path (repeat request-level calls to the same path reuse it)', async () => {
    const service = await makeService({});
    const r1 = await firstValueFrom(
      service.get('http://a.example/one', { socketPath: sockPath } as any),
    );
    const r2 = await firstValueFrom(
      service.get('http://a.example/two', { socketPath: sockPath } as any),
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Both succeeded through the same real unix socket server; if a fresh
    // Agent were built (and, e.g., leaked) per call this would still pass
    // functionally, so this also asserts on the cache directly:
    expect((service as any).socketPathDispatchers?.size).toBe(1);
  });

  it('a request-level socketPath wins over a module-built dispatcher', async () => {
    const service = await makeService({
      httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 4 }),
    });
    const response = await firstValueFrom(
      service.get('http://a.example/override', { socketPath: sockPath } as any),
    );
    expect(response.status).toBe(200);
    expect(response.data.host).toBe('a.example');
  });

  it('caps the per-path Agent cache', async () => {
    const service = await makeService({});
    for (let i = 0; i < 40; i++) {
      (service as any).getSocketPathDispatcher(socketPath());
    }
    expect((service as any).socketPathDispatchers.size).toBe(32);
  });
});
