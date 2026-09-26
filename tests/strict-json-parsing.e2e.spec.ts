/**
 * Real-server test for plan.md phase 2 "transitional.silentJSONParsing":
 * `transitional.silentJSONParsing: false` combined with `responseType:
 * 'json'` now throws (`ERR_BAD_RESPONSE`, `response.data` the raw text)
 * instead of silently returning the raw text on invalid JSON - matching
 * axios' exact condition (`strictJSONParsing = !silentJSONParsing &&
 * JSONRequested`, checked against real axios 1.20's `lib/defaults
 * /index.js`). The default (silent) behaviour is unaffected. See also the
 * deterministic, in-process unit tests in `axios-response.adapter.spec.ts`
 * and `axios-response-type.adapter.spec.ts`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { firstValueFrom } from 'rxjs';
import { HttpModule, HttpService } from '../src';

describe('transitional.silentJSONParsing (real server)', () => {
  let server: Server;
  let baseUrl: string;
  let service: HttpService;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const p = new URL(req.url!, 'http://x').searchParams;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(p.get('valid') === '1' ? '{"a":1}' : 'not valid json{');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    service = module.get<HttpService>(HttpService);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('rejects invalid JSON with a real AxiosError when silentJSONParsing: false (request-level)', async () => {
    let caught: any;
    try {
      await firstValueFrom(
        service.request(baseUrl, {
          responseType: 'json',
          transitional: { silentJSONParsing: false },
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeTruthy();
    expect(caught.isAxiosError).toBe(true);
    expect(caught.code).toBe('ERR_BAD_RESPONSE');
    expect(caught.response?.data).toBe('not valid json{');
  });

  it('honours axiosRef.defaults.transitional too (request > defaults precedence)', async () => {
    service.axiosRef.defaults.transitional = { silentJSONParsing: false };
    try {
      await expect(
        firstValueFrom(service.request(baseUrl, { responseType: 'json' })),
      ).rejects.toMatchObject({ isAxiosError: true, code: 'ERR_BAD_RESPONSE' });

      // Request-level still wins over defaults.
      const response = await firstValueFrom(
        service.request(baseUrl, {
          responseType: 'json',
          transitional: { silentJSONParsing: true },
        }),
      );
      expect(response.data).toBe('not valid json{');
    } finally {
      service.axiosRef.defaults.transitional = undefined;
    }
  });

  it('honours module-level transitional (module > nothing, folded into axiosRef.defaults)', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        HttpModule.register({
          transitional: { silentJSONParsing: false },
        }),
      ],
    }).compile();
    const moduleService = module.get<HttpService>(HttpService);

    await expect(
      firstValueFrom(moduleService.request(baseUrl, { responseType: 'json' })),
    ).rejects.toMatchObject({ isAxiosError: true, code: 'ERR_BAD_RESPONSE' });

    await module.close();
  });

  it('stays silent by default - no behaviour change for a plain responseType: "json" request', async () => {
    const response = await firstValueFrom(
      service.request(baseUrl, { responseType: 'json' }),
    );
    expect(response.data).toBe('not valid json{');
  });

  it('valid JSON is returned normally regardless of silentJSONParsing', async () => {
    const response = await firstValueFrom(
      service.request(`${baseUrl}?valid=1`, {
        responseType: 'json',
        transitional: { silentJSONParsing: false },
      }),
    );
    expect(response.data).toEqual({ a: 1 });
  });
});
