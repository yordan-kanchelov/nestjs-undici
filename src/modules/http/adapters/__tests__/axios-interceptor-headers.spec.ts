import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import * as http from 'http';
import { AddressInfo } from 'net';

import { HttpService } from '../../services/http.service';
import { HttpModule } from '../../http.module';
import { AxiosHeaders } from '../../interfaces/axios-headers';

/**
 * axiosRef request interceptors now run over the single axios config object
 * (see axios-request.adapter.ts's `buildAxiosConfig`/`serializeAxiosConfig`),
 * not a per-registration wrapper converting to/from undici options. These
 * tests exercise the various shapes an interceptor may leave `config.headers`
 * in, end to end through `HttpService`.
 */
describe('axiosRef request interceptors - header handling', () => {
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

  it('sets a header through AxiosHeaders#set', async () => {
    service.axiosRef.interceptors.request.use(config => {
      expect(config.headers).toBeInstanceOf(AxiosHeaders);
      (config.headers as AxiosHeaders).set('X-Custom-Header', 'test-value');
      return config;
    });

    const response = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(response.data.headers['x-custom-header']).toBe('test-value');
    expect(response.data.headers['content-type']).toBeUndefined();
  });

  it('sets a header through bracket assignment (Proxy support)', async () => {
    service.axiosRef.interceptors.request.use(config => {
      (config.headers as any)['X-Custom-Header'] = 'test-value';
      return config;
    });

    const response = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(response.data.headers['x-custom-header']).toBe('test-value');
  });

  it('sets several headers, as OpenTelemetry propagation.inject would', async () => {
    service.axiosRef.interceptors.request.use(config => {
      const injected: Record<string, string> = {
        traceparent: '00-123456789abcdef-fedcba987654321-01',
        tracestate: 'vendor=value',
      };
      Object.entries(injected).forEach(([key, value]) => {
        (config.headers as AxiosHeaders).set(key, value);
      });
      return config;
    });

    const response = await firstValueFrom(
      service.get(`${serverUrl}/x`, {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(response.data.headers['content-type']).toBe('application/json');
    expect(response.data.headers.traceparent).toBe(
      '00-123456789abcdef-fedcba987654321-01',
    );
    expect(response.data.headers.tracestate).toBe('vendor=value');
  });

  it('replacing config.headers with a plain object still works', async () => {
    service.axiosRef.interceptors.request.use(config => {
      config.headers = { 'X-Plain': 'plain-value' } as any;
      return config;
    });

    const response = await firstValueFrom(service.get(`${serverUrl}/x`));
    expect(response.data.headers['x-plain']).toBe('plain-value');
  });
});
