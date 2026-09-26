import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Readable } from 'stream';

import { HttpService } from '../http.service';
import { HttpModule } from '../../http.module';

describe('HttpService - response.config and transformResponse', () => {
  let service: HttpService;
  let module: TestingModule;
  let server: http.Server;
  let url: string;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/bytes') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from([0x00, 0x01, 0x02, 0xff]));
        return;
      }
      if (req.url === '/404') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"nope"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    module = await Test.createTestingModule({
      imports: [HttpModule.register()],
    }).compile();
    service = module.get(HttpService);
  });

  afterEach(async () => {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await module.close();
  });

  it('response.config is an own property, kept by spread and JSON.stringify', async () => {
    const res = await firstValueFrom(service.get(`${url}/json`));
    expect(Object.prototype.hasOwnProperty.call(res, 'config')).toBe(true);
    expect({ ...res }.config).toBe(res.config);
    expect(
      JSON.parse(JSON.stringify({ ...res, request: undefined })).config,
    ).toMatchObject({ method: 'get' });
  });

  it('error.config is an own property, kept by spread', async () => {
    const error = await firstValueFrom(service.get(`${url}/404`)).catch(e => e);
    expect(Object.prototype.hasOwnProperty.call(error, 'config')).toBe(true);
    expect({ ...error }.config).toMatchObject({ method: 'get' });
  });

  it("transformResponse with responseType 'arraybuffer' receives the raw bytes", async () => {
    let received: unknown;
    const res = await firstValueFrom(
      service.get(`${url}/bytes`, {
        responseType: 'arraybuffer',
        transformResponse: [
          (data: unknown) => {
            received = data;
            return data;
          },
        ],
      } as any),
    );
    expect(Buffer.isBuffer(received)).toBe(true);
    expect([...(received as Buffer)]).toEqual([0x00, 0x01, 0x02, 0xff]);
    expect(Buffer.isBuffer(res.data)).toBe(true);
  });

  it("transformResponse is skipped for responseType 'stream'", async () => {
    const transform = jest.fn((data: unknown) => data);
    const res = await firstValueFrom(
      service.get(`${url}/json`, {
        responseType: 'stream',
        transformResponse: [transform],
      } as any),
    );
    expect(transform).not.toHaveBeenCalled();
    expect(typeof (res.data as Readable).pipe).toBe('function');
    const chunks: Buffer[] = [];
    for await (const chunk of res.data as Readable) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('{"ok":true}');
  });
});
