/**
 * Real-server test for axios' `parseReviver` config option (plan.md phase 2
 * "fix: JSON reviver (parseReviver)"): passed to `JSON.parse` by the default
 * (no custom `transformResponse`) JSON decoding. See also the deterministic,
 * in-process unit tests in `axios-response-type.adapter.spec.ts` and the
 * axios-vs-this-library differential cases in `tests/compat/differential/
 * response.diff.spec.ts`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { firstValueFrom } from 'rxjs';
import { HttpModule, HttpService } from '../src';

const doubleNumbers = (key: string, value: any) =>
  typeof value === 'number' ? value * 2 : value;

describe('parseReviver (real server)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ a: 1, b: { c: 2 }, d: [3, 4] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('with no parseReviver set, parses JSON normally (unaffected)', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    const service = module.get<HttpService>(HttpService);

    const response = await firstValueFrom(service.request(baseUrl));

    expect(response.data).toEqual({ a: 1, b: { c: 2 }, d: [3, 4] });
  });

  it('applies a per-request parseReviver to every number in the parsed JSON', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    const service = module.get<HttpService>(HttpService);

    const response = await firstValueFrom(
      service.request(baseUrl, { parseReviver: doubleNumbers }),
    );

    expect(response.data).toEqual({ a: 2, b: { c: 4 }, d: [6, 8] });
  });

  it('applies a module-level parseReviver', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({ parseReviver: doubleNumbers })],
    }).compile();
    const service = module.get<HttpService>(HttpService);

    const response = await firstValueFrom(service.request(baseUrl));

    expect(response.data).toEqual({ a: 2, b: { c: 4 }, d: [6, 8] });
  });

  it('applies an axiosRef.defaults.parseReviver set at runtime', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    const service = module.get<HttpService>(HttpService);
    service.axiosRef.defaults.parseReviver = doubleNumbers;

    const response = await firstValueFrom(service.request(baseUrl));

    expect(response.data).toEqual({ a: 2, b: { c: 4 }, d: [6, 8] });
  });

  it('a per-request parseReviver wins over the module-level one', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        HttpModule.register({
          parseReviver: (key: string, value: any) =>
            typeof value === 'number' ? value + 1000 : value,
        }),
      ],
    }).compile();
    const service = module.get<HttpService>(HttpService);

    const response = await firstValueFrom(
      service.request(baseUrl, { parseReviver: doubleNumbers }),
    );

    expect(response.data).toEqual({ a: 2, b: { c: 4 }, d: [6, 8] });
  });

  it('applies to a JSON-looking text/plain response too (the default, forcedJSONParsing path)', async () => {
    const textServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('{"a":5}');
    });
    await new Promise<void>(resolve =>
      textServer.listen(0, '127.0.0.1', resolve),
    );
    try {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
      }).compile();
      const service = module.get<HttpService>(HttpService);
      const textUrl = `http://127.0.0.1:${(textServer.address() as AddressInfo).port}`;

      const response = await firstValueFrom(
        service.request(textUrl, { parseReviver: doubleNumbers }),
      );

      expect(response.data).toEqual({ a: 10 });
    } finally {
      await new Promise<void>(resolve => textServer.close(() => resolve()));
    }
  });

  it('has no effect on responseType: "stream" (never JSON-parsed)', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    const service = module.get<HttpService>(HttpService);

    const response = await firstValueFrom(
      service.request(baseUrl, {
        responseType: 'stream',
        parseReviver: doubleNumbers,
      }),
    );

    expect(typeof (response.data as any).pipe).toBe('function');
  });
});
