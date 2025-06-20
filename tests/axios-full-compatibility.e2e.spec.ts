import { Test, TestingModule } from '@nestjs/testing';
import {
  HttpModule as UndiciHttpModule,
  HttpService as UndiciHttpService,
} from '../src';
import {
  HttpModule as AxiosHttpModule,
  HttpService as AxiosHttpService,
} from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';
import * as http from 'http';
import * as https from 'https';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as FormData from 'form-data';

describe('Axios Full Compatibility E2E Tests', () => {
  let mockServer: http.Server;
  let serverUrl: string;
  let axiosModule: TestingModule;
  let undiciModule: TestingModule;
  let axiosService: AxiosHttpService;
  let undiciService: UndiciHttpService;

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

  beforeEach(async () => {
    axiosModule = await Test.createTestingModule({
      imports: [AxiosHttpModule.register({ timeout: 5000 })],
    }).compile();

    undiciModule = await Test.createTestingModule({
      imports: [UndiciHttpModule.registerAxiosCompatible({ timeout: 5000 })],
    }).compile();

    axiosService = axiosModule.get<AxiosHttpService>(AxiosHttpService);
    undiciService = undiciModule.get<UndiciHttpService>(UndiciHttpService);
  });

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((resolve, reject) => {
        mockServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        // Force close all connections after a timeout
        mockServer.closeAllConnections();
      });
      mockServer = null;
    }
    await axiosModule?.close();
    await undiciModule?.close();
  });

  describe('Content Type Handling', () => {
    describe('JSON responses', () => {
      beforeEach(async () => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              message: 'Hello JSON',
              number: 42,
              nested: { value: true },
            }),
          );
        });
      });

      it('should handle JSON responses identically', async () => {
        const [axiosRes, undiciRes] = await Promise.all([
          firstValueFrom(axiosService.get(serverUrl)),
          firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
        ]);

        expect(undiciRes.data).toEqual(axiosRes.data);
        expect(undiciRes.status).toBe(axiosRes.status);
        expect(undiciRes.statusText).toBe(axiosRes.statusText);
        expect(typeof undiciRes.data).toBe('object');
        expect(undiciRes.data.message).toBe('Hello JSON');
        expect(undiciRes.data.number).toBe(42);
        expect(undiciRes.data.nested.value).toBe(true);
      });
    });

    describe('Text responses', () => {
      beforeEach(async () => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Hello plain text response');
        });
      });

      it('should handle text responses identically', async () => {
        const [axiosRes, undiciRes] = await Promise.all([
          firstValueFrom(axiosService.get(serverUrl)),
          firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
        ]);

        expect(undiciRes.data).toBe(axiosRes.data);
        expect(typeof undiciRes.data).toBe('string');
        expect(undiciRes.data).toBe('Hello plain text response');
      });
    });

    describe('HTML responses', () => {
      beforeEach(async () => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<!DOCTYPE html><html><body>Hello HTML</body></html>');
        });
      });

      it('should handle HTML responses identically', async () => {
        const [axiosRes, undiciRes] = await Promise.all([
          firstValueFrom(axiosService.get(serverUrl)),
          firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
        ]);

        expect(undiciRes.data).toBe(axiosRes.data);
        expect(undiciRes.data).toContain('<!DOCTYPE html>');
      });
    });

    describe('XML responses', () => {
      beforeEach(async () => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          res.end(
            '<?xml version="1.0"?><root><message>Hello XML</message></root>',
          );
        });
      });

      it('should handle XML responses identically', async () => {
        const [axiosRes, undiciRes] = await Promise.all([
          firstValueFrom(axiosService.get(serverUrl)),
          firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
        ]);

        expect(undiciRes.data).toBe(axiosRes.data);
        expect(undiciRes.data).toContain('<?xml version="1.0"?>');
      });
    });

    describe('Binary responses', () => {
      beforeEach(async () => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          // Send some binary data
          const buffer = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ]);
          res.end(buffer);
        });
      });

      it('should handle binary responses as Buffer', async () => {
        const [axiosRes, undiciRes] = await Promise.all([
          firstValueFrom(
            axiosService.get(serverUrl, { responseType: 'arraybuffer' }),
          ),
          firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
        ]);

        // Axios returns ArrayBuffer for responseType: 'arraybuffer'
        // Our adapter returns Buffer for binary content
        expect(Buffer.isBuffer(undiciRes.data)).toBe(true);
        expect(undiciRes.data.length).toBe(8);

        // Compare the actual bytes
        const axiosBuffer = Buffer.from(axiosRes.data);
        expect(undiciRes.data.equals(axiosBuffer)).toBe(true);
      });
    });

    describe('Empty responses', () => {
      it('should handle 204 No Content identically', async () => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(204);
          res.end();
        });

        const [axiosRes, undiciRes] = await Promise.all([
          firstValueFrom(axiosService.get(serverUrl)),
          firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
        ]);

        expect(undiciRes.status).toBe(204);
        expect(undiciRes.status).toBe(axiosRes.status);
        expect(undiciRes.data).toBe(axiosRes.data);
        expect(undiciRes.data).toBe('');
      });

      it('should handle empty JSON response', async () => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('');
        });

        const [axiosRes, undiciRes] = await Promise.all([
          firstValueFrom(axiosService.get(serverUrl)),
          firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
        ]);

        expect(undiciRes.data).toBe(axiosRes.data);
        expect(undiciRes.data).toBe('');
      });
    });
  });

  describe('Status Code Handling', () => {
    const testStatusCode = async (code: number, expectedText: string) => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(code, { 'Content-Type': 'text/plain' });
        // 204 No Content and 304 Not Modified shouldn't have body
        if (code === 204 || code === 304) {
          res.end();
        } else {
          res.end(`Status ${code}`);
        }
      });

      // For error status codes, we need to catch the error
      if (code >= 400) {
        const [axiosError, undiciError] = await Promise.all([
          firstValueFrom(axiosService.get(serverUrl)).catch(e => e),
          firstValueFrom(undiciService.request(serverUrl)).catch(e => e),
        ]);

        expect(undiciError.response.status).toBe(code);
        expect(undiciError.response.status).toBe(axiosError.response.status);
        expect(undiciError.response.statusText).toBe(expectedText);
        expect(undiciError.response.data).toBe(`Status ${code}`);
        expect(undiciError.isAxiosError).toBe(true);
      } else {
        const [axiosRes, undiciRes] = await Promise.all([
          firstValueFrom(axiosService.get(serverUrl, { maxRedirects: 0 })),
          firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
        ]);

        expect(undiciRes.status).toBe(code);
        expect(undiciRes.status).toBe(axiosRes.status);
        expect(undiciRes.statusText).toBe(expectedText);
        // 204 and 304 should have empty data
        if (code === 204 || code === 304) {
          expect(undiciRes.data).toBe('');
        } else {
          expect(undiciRes.data).toBe(`Status ${code}`);
        }
      }
    };

    it.skip('should handle 1xx status codes', async () => {
      // Skipped: Undici doesn't support 1xx status codes
      await testStatusCode(100, 'Continue');
      await testStatusCode(101, 'Switching Protocols');
    });

    it('should handle 2xx status codes', async () => {
      await testStatusCode(200, 'OK');
      await testStatusCode(201, 'Created');
      await testStatusCode(202, 'Accepted');
      await testStatusCode(204, 'No Content');
    });

    it('should handle 3xx status codes', async () => {
      // Note: 304 Not Modified is treated as an error by Axios
      // We need to handle it specially
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(304);
        res.end();
      });

      const [axiosResult, undiciResult] = await Promise.all([
        firstValueFrom(axiosService.get(serverUrl)).catch(e => e),
        firstValueFrom(undiciService.request(serverUrl)).catch(e => e),
      ]);

      // 304 Not Modified might not throw an error in all configurations
      // Check if it's an error or a response
      if (axiosResult instanceof Error) {
        expect((axiosResult as any).response.status).toBe(304);
        expect(undiciResult).toBeInstanceOf(Error);
        expect((undiciResult as any).response.status).toBe(304);
        expect((undiciResult as any).response.data).toBe((axiosResult as any).response.data);
        expect((undiciResult as any).isAxiosError).toBe(true);
      } else {
        // If axios doesn't throw, neither should undici
        expect((axiosResult as any).status).toBe(304);
        expect((undiciResult as any).status).toBe(304);
        expect((undiciResult as any).data).toBe((axiosResult as any).data);
      }

      // For actual redirects, we need special handling
      const testRedirect = async (code: number, text: string) => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(code, {
            'Content-Type': 'text/plain',
            Location: 'http://example.com',
          });
          res.end();
        });

        try {
          const [axiosRes, undiciRes] = await Promise.all([
            firstValueFrom(
              axiosService.get(serverUrl, { maxRedirects: 0 }),
            ).catch(e => e),
            firstValueFrom(undiciService.request(serverUrl, { maxRedirections: 0 })).catch(e => e) as Promise<any>,
          ]);

          // Both Axios and Undici should throw on redirects when maxRedirects is 0
          expect(axiosRes).toBeInstanceOf(Error);
          expect((axiosRes as any).response?.status).toBe(code);
          
          expect(undiciRes).toBeInstanceOf(Error);
          expect((undiciRes as any).response?.status).toBe(code);
          expect((undiciRes as any).response?.statusText).toBe(text);
        } catch (error) {
          // Handle any unexpected errors
          console.error('Redirect test error:', error);
          throw error;
        }
      };

      await testRedirect(301, 'Moved Permanently');
      await testRedirect(302, 'Found');
    });

    it('should handle 4xx status codes', async () => {
      await testStatusCode(400, 'Bad Request');
      await testStatusCode(401, 'Unauthorized');
      await testStatusCode(403, 'Forbidden');
      await testStatusCode(404, 'Not Found');
      await testStatusCode(422, 'Unprocessable Entity');
    });

    it('should handle 5xx status codes', async () => {
      await testStatusCode(500, 'Internal Server Error');
      await testStatusCode(502, 'Bad Gateway');
      await testStatusCode(503, 'Service Unavailable');
    });
  });

  describe('Header Handling', () => {
    it('should preserve all response headers', async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'custom-value',
          'X-Request-Id': '12345',
          'Cache-Control': 'no-cache',
          ETag: '"33a64df551"',
        });
        res.end('{"ok":true}');
      });

      const [axiosRes, undiciRes] = await Promise.all([
        firstValueFrom(axiosService.get(serverUrl)),
        firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
      ]);

      expect(undiciRes.headers['content-type']).toBe(
        axiosRes.headers['content-type'],
      );
      expect(undiciRes.headers['x-custom-header']).toBe(
        axiosRes.headers['x-custom-header'],
      );
      expect(undiciRes.headers['x-request-id']).toBe(
        axiosRes.headers['x-request-id'],
      );
      expect(undiciRes.headers['cache-control']).toBe(
        axiosRes.headers['cache-control'],
      );
      expect(undiciRes.headers['etag']).toBe(axiosRes.headers['etag']);
    });

    it('should handle multiple values for the same header', async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, {
          'Set-Cookie': ['session=abc123', 'preference=dark'],
        });
        res.end('OK');
      });

      const [axiosRes, undiciRes] = await Promise.all([
        firstValueFrom(axiosService.get(serverUrl)),
        firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
      ]);

      // Both should handle multiple header values
      expect(Array.isArray(undiciRes.headers['set-cookie'])).toBe(true);
      expect(undiciRes.headers['set-cookie']).toHaveLength(2);
    });
  });

  describe('Request Configuration', () => {
    it('should include request config in response', async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });

      const [axiosRes, undiciRes] = await Promise.all([
        firstValueFrom(axiosService.get(serverUrl)),
        firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
      ]);

      expect(undiciRes.config).toBeDefined();
      expect(undiciRes.config.url).toBe(serverUrl);
      expect(undiciRes.config.method).toBe('GET');
    });
  });

  describe('Large Payload Handling', () => {
    it('should handle large JSON payloads', async () => {
      const largeArray = Array(10000)
        .fill(null)
        .map((_, i) => ({
          id: i,
          data: 'x'.repeat(100),
          timestamp: Date.now(),
        }));

      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(largeArray));
      });

      const [axiosRes, undiciRes] = await Promise.all([
        firstValueFrom(axiosService.get(serverUrl)),
        firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
      ]);

      expect(Array.isArray(undiciRes.data)).toBe(true);
      expect(undiciRes.data.length).toBe(10000);
      expect(undiciRes.data[0]).toEqual(axiosRes.data[0]);
      expect(undiciRes.data[9999]).toEqual(axiosRes.data[9999]);
    });

    it('should handle large text payloads', async () => {
      const largeText = 'Lorem ipsum '.repeat(10000);

      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(largeText);
      });

      const [axiosRes, undiciRes] = await Promise.all([
        firstValueFrom(axiosService.get(serverUrl)),
        firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
      ]);

      expect(undiciRes.data).toBe(axiosRes.data);
      expect(undiciRes.data.length).toBe(largeText.length);
    });
  });

  describe('Special Characters and Encoding', () => {
    it('should handle UTF-8 characters correctly', async () => {
      const unicodeData = {
        english: 'Hello World',
        chinese: '你好世界',
        arabic: 'مرحبا بالعالم',
        emoji: '🌍🌎🌏',
        special: '©®™€£¥',
      };

      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify(unicodeData));
      });

      const [axiosRes, undiciRes] = await Promise.all([
        firstValueFrom(axiosService.get(serverUrl)),
        firstValueFrom(undiciService.request(serverUrl)) as Promise<any>,
      ]);

      expect(undiciRes.data).toEqual(axiosRes.data);
      expect(undiciRes.data.chinese).toBe('你好世界');
      expect(undiciRes.data.emoji).toBe('🌍🌎🌏');
    });
  });

  describe('Error Response Handling', () => {
    it('should handle error responses with body', async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'Bad Request', details: 'Invalid input' }),
        );
      });

      const [axiosError, undiciError] = await Promise.all([
        firstValueFrom(axiosService.get(serverUrl)).catch(e => e),
        firstValueFrom(undiciService.request(serverUrl)).catch(e => e),
      ]);

      expect(undiciError.response.status).toBe(400);
      expect(undiciError.response.data).toEqual(axiosError.response.data);
      expect(undiciError.response.data.error).toBe('Bad Request');
      expect(undiciError.isAxiosError).toBe(true);
    });
  });

  describe('Request Method Support', () => {
    const methods = [
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'PATCH',
      'OPTIONS',
      'HEAD',
    ];

    for (const method of methods) {
      it(`should support ${method} method`, async () => {
        serverUrl = await createMockServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method }));
        });

        const config: any = {
          validateStatus: () => true,
          ...(method === 'POST' || method === 'PUT' || method === 'PATCH'
            ? { data: {} }
            : {}),
        };

        const [axiosRes, undiciRes] = await Promise.all([
          firstValueFrom(
            axiosService.request({ ...config, method, url: serverUrl }),
          ),
          firstValueFrom(
            undiciService.request(serverUrl, {
              method,
              ...(config.data ? { body: JSON.stringify(config.data) } : {}),
            }),
          ) as Promise<any>,
        ]);

        if (method !== 'HEAD') {
          expect(undiciRes.data.method).toBe(method);
        }
        expect(undiciRes.status).toBe(axiosRes.status);
      });
    }
  });
});
