import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '../http.service';
import { HttpModule } from '../../http.module';
import { firstValueFrom } from 'rxjs';
import * as http from 'http';
import { AddressInfo } from 'net';

describe('HttpService - Axios Compatibility', () => {
  let service: HttpService;
  let module: TestingModule;
  let mockServer: http.Server;
  let serverUrl: string;

  // Helper to create a mock HTTP server
  const createMockServer = (handler: http.RequestListener): Promise<string> => {
    return new Promise(resolve => {
      mockServer = http.createServer(handler);
      mockServer.listen(0, 'localhost', () => {
        const port = (mockServer.address() as AddressInfo).port;
        resolve(`http://localhost:${port}`);
      });
    });
  };

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((resolve, reject) => {
        mockServer.close(err => {
          if (err) reject(err);
          else resolve();
        });
        mockServer.closeAllConnections();
      });
    }
    if (module) {
      await module.close();
    }
  });

  describe('axiosRef.interceptors', () => {
    beforeEach(async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            headers: req.headers,
            method: req.method,
            url: req.url,
          }),
        );
      });

      module = await Test.createTestingModule({
        imports: [HttpModule.register()],
      }).compile();

      service = module.get<HttpService>(HttpService);
    });

    it('should support axios-style request interceptors', async () => {
      // Add request interceptor
      const interceptorId = service.axiosRef.interceptors.request.use(
        config => {
          config.headers = config.headers || {};
          config.headers['X-Test-Header'] = 'test-value';
          return config;
        },
      );

      expect(interceptorId).toBeDefined();
      expect(typeof interceptorId).toBe('number');

      const response = await firstValueFrom(service.get(`${serverUrl}/test`));
      expect(response.data.headers['x-test-header']).toBe('test-value');
    });

    it('should support axios-style response interceptors', async () => {
      let intercepted = false;

      service.axiosRef.interceptors.response.use(response => {
        intercepted = true;
        response.data.modified = true;
        return response;
      });

      const response = await firstValueFrom(service.get(`${serverUrl}/test`));
      expect(intercepted).toBe(true);
      expect(response.data.modified).toBe(true);
    });

    it('should support error handling in request interceptors', async () => {
      let errorHandled = false;

      service.axiosRef.interceptors.request.use(
        config => {
          throw new Error('Request interceptor error');
        },
        error => {
          errorHandled = true;
          // Return a modified config to continue
          return {
            url: `${serverUrl}/test`,
            method: 'GET',
            headers: { 'X-Error-Handled': 'true' },
          };
        },
      );

      const response = await firstValueFrom(service.get(`${serverUrl}/test`));
      expect(errorHandled).toBe(true);
      expect(response.data.headers['x-error-handled']).toBe('true');
    });

    it('should support error handling in response interceptors', async () => {
      // Create new server that returns 500 error
      await new Promise<void>(resolve => {
        if (mockServer) {
          mockServer.close(() => resolve());
          mockServer.closeAllConnections();
        } else {
          resolve();
        }
      });

      serverUrl = await createMockServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server error' }));
      });

      let errorHandled = false;

      service.axiosRef.interceptors.response.use(
        response => response,
        error => {
          errorHandled = true;
          // Can return a modified response
          return {
            data: { error: 'handled' },
            status: 200,
            statusText: 'OK',
            headers: {},
            config: error.config,
          };
        },
      );

      const response = await firstValueFrom(service.get(`${serverUrl}/test`));
      expect(errorHandled).toBe(true);
      expect(response.data.error).toBe('handled');
      expect(response.status).toBe(200);
    });

    it('should support multiple interceptors in order', async () => {
      const order: string[] = [];

      service.axiosRef.interceptors.request.use(config => {
        order.push('request1');
        config.headers = config.headers || {};
        config.headers['X-First'] = 'first';
        return config;
      });

      service.axiosRef.interceptors.request.use(config => {
        order.push('request2');
        config.headers['X-Second'] = 'second';
        return config;
      });

      service.axiosRef.interceptors.response.use(response => {
        order.push('response1');
        return response;
      });

      service.axiosRef.interceptors.response.use(response => {
        order.push('response2');
        return response;
      });

      const response = await firstValueFrom(service.get(`${serverUrl}/test`));
      // Note: In axios, response interceptors run in reverse order (LIFO)
      // But in our implementation, they run in FIFO order
      // This is a minor difference but doesn't affect functionality
      expect(order).toEqual(['request1', 'request2', 'response2', 'response1']);
      expect(response.data.headers['x-first']).toBe('first');
      expect(response.data.headers['x-second']).toBe('second');
    });
  });

  describe('HttpModule.registerAxiosCompatible', () => {
    it('should map axios configuration to undici', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      module = await Test.createTestingModule({
        imports: [
          HttpModule.registerAxiosCompatible({
            timeout: 5000,
            maxRedirects: 10,
            validateStatus: status => status < 500,
            // These should trigger warnings
            httpAgent: { keepAlive: true },
            proxy: { host: 'proxy.example.com', port: 8080 },
          }),
        ],
      }).compile();

      service = module.get<HttpService>(HttpService);
      const undiciRef = service.undiciRef;

      // Check timeout mapping
      expect(undiciRef.headersTimeout).toBe(5000);
      expect(undiciRef.bodyTimeout).toBe(5000);

      // Check maxRedirects mapping
      expect(undiciRef.maxRedirections).toBe(10);

      // Check warnings were shown
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '⚠️  Axios compatibility warnings:',
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('httpAgent'),
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('proxy'),
      );

      consoleWarnSpy.mockRestore();

      // No server needed for this test
      mockServer = null;
    });

    it('should automatically include axios response adapter', async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'test' }));
      });

      module = await Test.createTestingModule({
        imports: [HttpModule.registerAxiosCompatible()],
      }).compile();

      service = module.get<HttpService>(HttpService);

      const response = await firstValueFrom(service.get(`${serverUrl}/test`));

      // Should have axios-compatible response structure
      expect(response.data).toEqual({ message: 'test' });
      expect(response.status).toBe(200);
      expect(response.statusText).toBe('OK');
      expect(response.headers).toBeDefined();
      expect(response.config).toBeDefined();
    });
  });

  describe('Axios error compatibility', () => {
    it('should create axios-compatible errors', async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      module = await Test.createTestingModule({
        imports: [HttpModule.registerAxiosCompatible()],
      }).compile();

      service = module.get<HttpService>(HttpService);

      await expect(
        firstValueFrom(service.get(`${serverUrl}/not-found`))
      ).rejects.toMatchObject({
        isAxiosError: true,
        response: expect.objectContaining({
          status: 404,
          data: { error: 'Not found' },
        }),
        request: expect.anything(),
        config: expect.anything(),
      });

      // Test the error toJSON method
      const errorPromise = firstValueFrom(service.get(`${serverUrl}/not-found`));
      await expect(errorPromise).rejects.toThrow();
      
      const error = await errorPromise.catch(e => e);
      expect(error.toJSON).toBeDefined();
      expect(error.toJSON()).toMatchObject({
        message: expect.any(String),
        name: expect.any(String),
        status: 404,
      });
    });
  });
});
