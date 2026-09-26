/**
 * Covers plan.md phase 2 "fix(config): transport options" - TLS options from
 * a module-level `httpsAgent`: `ca`, `rejectUnauthorized`, and (implicitly,
 * since they're mapped by the same code) `cert`/`key`/`pfx`/`passphrase`/
 * `servername`/`ciphers`/`minVersion`/`maxVersion`.
 *
 * Uses a self-signed fixture certificate (`tests/fixtures/tls`) so CI never
 * depends on `openssl` being installed.
 */
import { Agent as HttpsAgent } from 'node:https';
import { createServer, Server } from 'node:https';
import { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { Agent as UndiciAgent } from 'undici';
import { HttpModule, HttpService } from '../src';

const FIXTURES = join(__dirname, 'fixtures', 'tls');
const cert = readFileSync(join(FIXTURES, 'server-cert.pem'));
const key = readFileSync(join(FIXTURES, 'server-key.pem'));

describe('HttpService TLS options (httpsAgent)', () => {
  let server: Server;
  let baseUrl: string;
  const modules: TestingModule[] = [];

  beforeAll(async () => {
    server = createServer({ cert, key }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all(modules.map(m => m.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const makeService = async (options: any): Promise<HttpService> => {
    const module = await Test.createTestingModule({
      imports: [HttpModule.register(options)],
    }).compile();
    modules.push(module);
    return module.get(HttpService);
  };

  it('the default (no httpsAgent) rejects the self-signed certificate', async () => {
    const service = await makeService({});
    await expect(firstValueFrom(service.get(baseUrl))).rejects.toMatchObject({
      code: expect.stringMatching(
        /DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/,
      ),
    });
  });

  it('httpsAgent rejectUnauthorized:false accepts the self-signed certificate', async () => {
    const service = await makeService({
      httpsAgent: new HttpsAgent({ rejectUnauthorized: false }),
    });
    const response = await firstValueFrom(service.get(baseUrl));
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
  });

  it('httpsAgent ca trusts a cert signed by that CA', async () => {
    const service = await makeService({
      httpsAgent: new HttpsAgent({ ca: cert }),
    });
    const response = await firstValueFrom(service.get(baseUrl));
    expect(response.status).toBe(200);
  });

  it('an explicit dispatcher wins over httpsAgent TLS options', async () => {
    // The httpsAgent alone would make the certificate trusted; the explicit
    // dispatcher (default TLS verification) must still be the one used.
    const service = await makeService({
      httpsAgent: new HttpsAgent({ rejectUnauthorized: false }),
      dispatcher: new UndiciAgent(),
    });
    await expect(firstValueFrom(service.get(baseUrl))).rejects.toMatchObject({
      code: expect.stringMatching(
        /DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/,
      ),
    });
  });

  it('httpAgent keepAlive/maxSockets do not build a dispatcher that skips TLS verification', async () => {
    // A plain httpAgent (no TLS fields) must never be mistaken for httpsAgent.
    const service = await makeService({
      httpAgent: new HttpsAgent({ rejectUnauthorized: false }) as any,
    });
    // httpAgent (even TLS-shaped) is only read for keep-alive/maxSockets/
    // timeout - never for TLS - so the default verification still applies.
    await expect(firstValueFrom(service.get(baseUrl))).rejects.toBeDefined();
  });
});
