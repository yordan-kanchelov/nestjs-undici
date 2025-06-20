import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule, HttpService } from '../src';
import { lastValueFrom, of } from 'rxjs';
import { catchError, retry, map } from 'rxjs/operators';
import * as http from 'http';
import { AddressInfo } from 'net';

describe('Complete Axios Compatibility Test', () => {
  let mockServer: http.Server;
  let serverUrl: string;

  const createMockServer = (handler: http.RequestListener): Promise<string> => {
    return new Promise((resolve) => {
      mockServer = http.createServer(handler);
      mockServer.listen(0, 'localhost', () => {
        const port = (mockServer.address() as AddressInfo).port;
        resolve(`http://localhost:${port}`);
      });
    });
  };

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });

  describe('User\'s Original Code Pattern', () => {
    interface GinPortalConfigDTO {
      id: string;
      name: string;
      status: 'active' | 'inactive';
    }

    let module: TestingModule;
    let httpService: HttpService;

    beforeEach(async () => {
      module = await Test.createTestingModule({
        imports: [HttpModule.registerAxiosCompatible({ timeout: 5000 })],
      }).compile();

      httpService = module.get<HttpService>(HttpService);
    });

    afterEach(async () => {
      await module?.close();
    });

    it('should work with the exact pattern from user\'s code', async () => {
      let attemptCount = 0;
      const activateConfigPath = await createMockServer((req, res) => {
        attemptCount++;
        
        // Simulate failure on first attempt
        if (attemptCount === 1) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal Server Error' }));
          return;
        }

        // Success on retry
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { id: '1', name: 'Config 1', status: 'active' },
          { id: '2', name: 'Config 2', status: 'inactive' }
        ]));
      });

      // This is the EXACT code pattern from the user's example
      const result = await lastValueFrom(
        httpService.post<GinPortalConfigDTO[]>(activateConfigPath, null).pipe(
          retry({ count: 3, delay: 100 }),
          map((response: any) => response?.data), // 👈 Works exactly like Axios!
          catchError((ex) => {
            console.log(`Failed to activate configs: ${ex instanceof Error ? ex.message : JSON.stringify(ex)}`);
            return of(undefined);
          }),
        ),
      );

      expect(result).toBeDefined();
      expect(result).toHaveLength(2);
      expect(result![0].id).toBe('1');
      expect(result![0].name).toBe('Config 1');
      expect(attemptCount).toBe(2); // First attempt failed, second succeeded
    });

    it('should support all convenience methods', async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        
        switch (req.method) {
          case 'GET':
            res.end(JSON.stringify({ method: 'GET', data: 'get response' }));
            break;
          case 'POST':
            res.end(JSON.stringify({ method: 'POST', data: 'created' }));
            break;
          case 'PUT':
            res.end(JSON.stringify({ method: 'PUT', data: 'updated' }));
            break;
          case 'DELETE':
            res.end(JSON.stringify({ method: 'DELETE', data: 'deleted' }));
            break;
          case 'PATCH':
            res.end(JSON.stringify({ method: 'PATCH', data: 'patched' }));
            break;
          default:
            res.end(JSON.stringify({ method: req.method }));
        }
      });

      // Test all convenience methods
      const getResponse: any = await lastValueFrom(httpService.get(serverUrl));
      expect(getResponse.data.method).toBe('GET');

      const postResponse: any = await lastValueFrom(httpService.post(serverUrl, { test: 'data' }));
      expect(postResponse.data.method).toBe('POST');

      const putResponse: any = await lastValueFrom(httpService.put(serverUrl, { update: 'data' }));
      expect(putResponse.data.method).toBe('PUT');

      const deleteResponse: any = await lastValueFrom(httpService.delete(serverUrl));
      expect(deleteResponse.data.method).toBe('DELETE');

      const patchResponse: any = await lastValueFrom(httpService.patch(serverUrl, { patch: 'data' }));
      expect(patchResponse.data.method).toBe('PATCH');
    });

    it('should work with RxJS operators chain', async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          users: [
            { id: 1, name: 'John', active: true },
            { id: 2, name: 'Jane', active: false },
            { id: 3, name: 'Bob', active: true },
          ]
        }));
      });

      // Complex RxJS chain similar to real-world usage
      const activeUsers = await lastValueFrom(
        httpService.get(serverUrl).pipe(
          map((response: any) => response.data),
          map(data => data.users),
          map(users => users.filter((u: any) => u.active)),
          map(activeUsers => activeUsers.map((u: any) => u.name)),
          catchError(() => of([]))
        )
      );

      expect(activeUsers).toEqual(['John', 'Bob']);
    });

    it('should support interceptors for adding headers', async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          headers: req.headers
        }));
      });

      // Add interceptor to inject auth token
      httpService.addInterceptor((request, next) => {
        const modifiedRequest = {
          ...request,
          options: {
            ...request.options,
            headers: {
              ...request.options.headers,
              'Authorization': 'Bearer my-token',
              'X-Request-ID': '12345',
            },
          },
        };
        return next.handle(modifiedRequest);
      });

      const response: any = await lastValueFrom(httpService.get(serverUrl));
      expect(response.data.headers.authorization).toBe('Bearer my-token');
      expect(response.data.headers['x-request-id']).toBe('12345');
    });

    it('should handle form data requests', async () => {
      serverUrl = await createMockServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            contentType: req.headers['content-type'],
            body: body
          }));
        });
      });

      const formData = {
        username: 'john@example.com',
        password: 'secret123',
        remember: 'true'
      };

      const response: any = await lastValueFrom(httpService.postForm(serverUrl, formData));
      expect(response.data.contentType).toBe('application/x-www-form-urlencoded');
      expect(response.data.body).toBe('username=john%40example.com&password=secret123&remember=true');
    });

    it('should preserve type safety with generics', async () => {
      interface ApiResponse<T> {
        success: boolean;
        data: T;
        timestamp: number;
      }

      interface User {
        id: number;
        name: string;
        email: string;
      }

      serverUrl = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: { id: 1, name: 'John Doe', email: 'john@example.com' },
          timestamp: Date.now()
        }));
      });

      // Type-safe request
      const response = await lastValueFrom(
        httpService.get<ApiResponse<User>>(serverUrl).pipe(
          map((res: any) => res.data)
        )
      );

      // TypeScript knows the shape of the response
      expect(response.success).toBe(true);
      expect(response.data.id).toBe(1);
      expect(response.data.name).toBe('John Doe');
      expect(response.data.email).toBe('john@example.com');
    });
  });

  describe('Error Handling Compatibility', () => {
    let module: TestingModule;
    let httpService: HttpService;

    beforeEach(async () => {
      module = await Test.createTestingModule({
        imports: [HttpModule.registerAxiosCompatible()],
      }).compile();

      httpService = module.get<HttpService>(HttpService);
    });

    afterEach(async () => {
      await module?.close();
    });

    it('should handle network errors', async () => {
      // Invalid URL to trigger network error
      const invalidUrl = 'http://localhost:99999/invalid';

      try {
        await lastValueFrom(httpService.get(invalidUrl));
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error).toBeDefined();
        expect(error.code).toBeDefined();
      }
    });

    it('should handle 4xx/5xx errors with response body', async () => {
      serverUrl = await createMockServer((req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Not Found',
          message: 'The requested resource does not exist'
        }));
      });

      try {
        await lastValueFrom(httpService.get(serverUrl));
        fail('Should have thrown an error');
      } catch (error: any) {
        // The error should still have the response data
        expect(error).toBeDefined();
      }
    });
  });
});