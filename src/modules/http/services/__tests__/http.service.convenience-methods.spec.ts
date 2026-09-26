import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '../http.service';
import { HttpModule } from '../../http.module';
import { AxiosHeaders } from '../../interfaces/axios-headers';
import * as http from 'http';
import { AddressInfo } from 'net';
import { firstValueFrom } from 'rxjs';

describe('HttpService Convenience Methods', () => {
  let service: HttpService;
  let mockServer: http.Server;
  let serverUrl: string;

  const createMockServer = (handler: http.RequestListener): Promise<string> => {
    return new Promise(resolve => {
      mockServer = http.createServer(handler);
      mockServer.listen(0, '127.0.0.1', () => {
        const port = (mockServer.address() as AddressInfo).port;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register()],
    }).compile();

    service = module.get<HttpService>(HttpService);
  });

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>(resolve => mockServer.close(() => resolve()));
    }
  });

  describe('GET method', () => {
    it('should make GET request', async () => {
      serverUrl = await createMockServer((req, res) => {
        expect(req.method).toBe('GET');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'GET success' }));
      });

      const response: any = await firstValueFrom(service.get(serverUrl));
      expect(response.data.message).toBe('GET success');
      expect(response.status).toBe(200);
    });
  });

  describe('POST method', () => {
    it('should make POST request with JSON data', async () => {
      const testData = { name: 'test', value: 123 };

      serverUrl = await createMockServer((req, res) => {
        expect(req.method).toBe('POST');
        expect(req.headers['content-type']).toBe('application/json');

        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          expect(JSON.parse(body)).toEqual(testData);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 1, ...testData }));
        });
      });

      const response: any = await firstValueFrom(
        service.post(serverUrl, testData),
      );
      expect(response.data.id).toBe(1);
      expect(response.data.name).toBe('test');
      expect(response.status).toBe(201);
    });

    it('should handle POST with no data', async () => {
      serverUrl = await createMockServer((req, res) => {
        expect(req.method).toBe('POST');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ created: true }));
      });

      const response: any = await firstValueFrom(service.post(serverUrl));
      expect(response.data.created).toBe(true);
    });
  });

  describe('PUT method', () => {
    it('should make PUT request', async () => {
      const updateData = { id: 1, name: 'updated' };

      serverUrl = await createMockServer((req, res) => {
        expect(req.method).toBe('PUT');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updated: true, ...updateData }));
      });

      const response: any = await firstValueFrom(
        service.put(serverUrl, updateData),
      );
      expect(response.data.updated).toBe(true);
      expect(response.data.name).toBe('updated');
    });
  });

  describe('DELETE method', () => {
    it('should make DELETE request', async () => {
      serverUrl = await createMockServer((req, res) => {
        expect(req.method).toBe('DELETE');
        res.writeHead(204);
        res.end();
      });

      const response: any = await firstValueFrom(service.delete(serverUrl));
      expect(response.status).toBe(204);
    });
  });

  describe('PATCH method', () => {
    it('should make PATCH request', async () => {
      const patchData = { status: 'active' };

      serverUrl = await createMockServer((req, res) => {
        expect(req.method).toBe('PATCH');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ patched: true, ...patchData }));
      });

      const response: any = await firstValueFrom(
        service.patch(serverUrl, patchData),
      );
      expect(response.data.patched).toBe(true);
      expect(response.data.status).toBe('active');
    });
  });

  describe('HEAD method', () => {
    it('should make HEAD request', async () => {
      serverUrl = await createMockServer((req, res) => {
        expect(req.method).toBe('HEAD');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'test-value',
        });
        res.end();
      });

      const response: any = await firstValueFrom(service.head(serverUrl));
      expect(response.status).toBe(200);
      expect(response.headers['x-custom-header']).toBe('test-value');
    });
  });

  describe('OPTIONS method', () => {
    it('should make OPTIONS request', async () => {
      serverUrl = await createMockServer((req, res) => {
        expect(req.method).toBe('OPTIONS');
        res.writeHead(200, {
          Allow: 'GET, POST, PUT, DELETE',
        });
        res.end();
      });

      const response: any = await firstValueFrom(service.options(serverUrl));
      expect(response.status).toBe(200);
      expect(response.headers['allow']).toBe('GET, POST, PUT, DELETE');
    });
  });

  describe('Form methods', () => {
    // postForm/putForm/patchForm send multipart/form-data by default, like
    // axios' own postForm (plan.md phase 2 "feat(axiosRef): make it a real
    // axios instance") - previously (a documented gap) this library sent
    // url-encoded data instead. `post()`/`put()`/`patch()` with
    // `data: new URLSearchParams(...)` still sends url-encoded, unaffected.
    it('should make POST request with form data', async () => {
      const formData = { username: 'john', password: 'secret' };

      serverUrl = await createMockServer((req, res) => {
        expect(req.method).toBe('POST');
        expect(req.headers['content-type']).toMatch(/^multipart\/form-data;/);

        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          expect(body).toContain('name="username"');
          expect(body).toContain('john');
          expect(body).toContain('name="password"');
          expect(body).toContain('secret');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        });
      });

      const response: any = await firstValueFrom(
        service.postForm(serverUrl, formData),
      );
      expect(response.data.success).toBe(true);
    });

    it('should make PUT request with form data', async () => {
      const formData = { id: '123', name: 'updated name' };

      serverUrl = await createMockServer((req, res) => {
        expect(req.method).toBe('PUT');
        expect(req.headers['content-type']).toMatch(/^multipart\/form-data;/);

        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          expect(body).toContain('name="id"');
          expect(body).toContain('123');
          expect(body).toContain('name="name"');
          expect(body).toContain('updated name');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ updated: true }));
        });
      });

      const response: any = await firstValueFrom(
        service.putForm(serverUrl, formData),
      );
      expect(response.data.updated).toBe(true);
    });

    it('should make PATCH request with form data', async () => {
      const formData = { status: 'active' };

      serverUrl = await createMockServer((req, res) => {
        expect(req.method).toBe('PATCH');
        expect(req.headers['content-type']).toMatch(/^multipart\/form-data;/);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ patched: true }));
      });

      const response: any = await firstValueFrom(
        service.patchForm(serverUrl, formData),
      );
      expect(response.data.patched).toBe(true);
    });
  });

  describe('Custom headers', () => {
    it('should allow custom headers in config', async () => {
      serverUrl = await createMockServer((req, res) => {
        expect(req.headers['authorization']).toBe('Bearer token123');
        expect(req.headers['x-api-key']).toBe('secret-key');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authorized: true }));
      });

      const config = {
        headers: {
          Authorization: 'Bearer token123',
          'X-API-Key': 'secret-key',
        },
      };

      const response: any = await firstValueFrom(
        service.get(serverUrl, config),
      );
      expect(response.data.authorized).toBe(true);
    });

    it('should merge headers in POST request', async () => {
      serverUrl = await createMockServer((req, res) => {
        expect(req.headers['content-type']).toBe('application/json');
        expect(req.headers['x-custom']).toBe('value');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });

      const response: any = await firstValueFrom(
        service.post(
          serverUrl,
          { data: 'test' },
          {
            headers: { 'X-Custom': 'value' },
          },
        ),
      );
      expect(response.data.success).toBe(true);
    });
  });

  describe('axiosRef review fixes', () => {
    it('postForm with URLSearchParams sends its body', async () => {
      let received = '';
      serverUrl = await createMockServer((req, res) => {
        req.on('data', chunk => (received += chunk));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
      });

      await service.axiosRef.postForm(
        serverUrl,
        new URLSearchParams({ a: '1', b: '2' }),
      );
      expect(received).toBe('a=1&b=2');
    });

    it('create() copies object defaults instead of sharing them', () => {
      service.axiosRef.defaults.params = { a: 1 };
      try {
        const child = service.axiosRef.create();
        (service.axiosRef.defaults.params as any).a = 999;
        expect((child.defaults.params as any).a).toBe(1);
      } finally {
        delete service.axiosRef.defaults.params;
      }
    });

    it('AxiosHeaders has the Accept-Encoding accessors axios has at runtime', () => {
      const headers = new AxiosHeaders() as any;
      headers.setAcceptEncoding('gzip');
      expect(headers.getAcceptEncoding()).toBe('gzip');
      expect(headers.hasAcceptEncoding()).toBe(true);
    });
  });
});
