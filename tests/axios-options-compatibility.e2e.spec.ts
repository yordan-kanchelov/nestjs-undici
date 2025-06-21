import { Test } from '@nestjs/testing';
import { HttpModule, HttpService } from '../src';
import { INestApplication } from '@nestjs/common';
import { Agent as HttpAgent } from 'http';
import { lastValueFrom } from 'rxjs';
import * as http from 'http';

describe('Axios Options Compatibility - Fixed', () => {
  let app: INestApplication;
  let httpService: HttpService;
  let server: http.Server;
  let serverPort: number;

  // Create a test server that handles all our test cases
  beforeAll((done) => {
    server = http.createServer((req, res) => {
      const url = req.url || '';
      
      // Handle different test endpoints
      if (url === '/test') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: 'test' }));
      } else if (url === '/large') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('x'.repeat(200)); // 200 bytes
      } else if (url === '/small') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('x'.repeat(50)); // 50 bytes
      } else if (url === '/upload' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          if (body.length > 100) {
            res.writeHead(413, { 'Content-Type': 'text/plain' });
            res.end('Payload too large');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: body.length }));
          }
        });
      } else if (url === '/login') {
        res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Set-Cookie': 'sessionid=abc123; Path=/; Domain=localhost; HttpOnly'
        });
        res.end(JSON.stringify({ success: true }));
      } else if (url === '/profile') {
        const cookies = req.headers.cookie || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          name: 'John',
          authenticated: cookies.includes('sessionid=abc123')
        }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(0, () => {
      serverPort = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('httpAgent/httpsAgent - Connection Pooling', () => {
    it('should use custom agents for connection pooling', async () => {
      const httpAgent = new HttpAgent({
        keepAlive: true,
        maxSockets: 2,
        maxFreeSockets: 1,
        timeout: 5000,
      });

      const moduleRef = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            httpAgent,
          }),
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();
      httpService = moduleRef.get<HttpService>(HttpService);

      // Make multiple requests to test connection pooling
      const promises = Array(3).fill(null).map(() => 
        lastValueFrom(httpService.get(`http://localhost:${serverPort}/test`))
      );
      
      const responses = await Promise.all(promises);

      // All should succeed
      expect(responses.length).toBe(3);
      responses.forEach(response => {
        expect(response.data).toEqual({ data: 'test' });
        expect(response.status).toBe(200);
      });
    });
  });

  describe('maxBodyLength/maxContentLength - Size Limits', () => {
    const maxBodyLength = 100; // 100 bytes
    const maxContentLength = 100; // 100 bytes

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            maxBodyLength,
            maxContentLength,
          }),
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();
      httpService = moduleRef.get<HttpService>(HttpService);
    });

    it('should reject responses exceeding maxContentLength', async () => {
      await expect(
        lastValueFrom(httpService.get(`http://localhost:${serverPort}/large`))
      ).rejects.toThrow(/maxContentLength/);
    });

    it('should reject requests with body exceeding maxBodyLength', async () => {
      const largeBody = 'x'.repeat(200); // 200 bytes
      
      await expect(
        lastValueFrom(httpService.post(`http://localhost:${serverPort}/upload`, largeBody))
      ).rejects.toThrow(/maxBodyLength/);
    });

    it('should accept responses within limits', async () => {
      const response = await lastValueFrom(
        httpService.get(`http://localhost:${serverPort}/small`)
      );

      expect(response.data).toBe('x'.repeat(50));
      expect(response.status).toBe(200);
    });
  });

  describe('withCredentials - Cookie Handling', () => {
    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            withCredentials: true,
          }),
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();
      httpService = moduleRef.get<HttpService>(HttpService);
    });

    it('should store and send cookies across requests', async () => {
      // First request sets a cookie
      const loginResponse = await lastValueFrom(
        httpService.get(`http://localhost:${serverPort}/login`)
      );
      expect(loginResponse.data.success).toBe(true);

      // Second request should include the cookie
      const profileResponse = await lastValueFrom(
        httpService.get(`http://localhost:${serverPort}/profile`)
      );
      
      expect(profileResponse.data.name).toBe('John');
      expect(profileResponse.data.authenticated).toBe(true);
    });
  });

  describe('Combined Options', () => {
    it('should support multiple axios options simultaneously', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            timeout: 5000,
            maxContentLength: 1000,
            validateStatus: (status) => status < 400,
            // Note: Combining httpAgent with withCredentials can cause issues
            // due to how CookieAgent wraps dispatchers
          }),
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();
      httpService = moduleRef.get<HttpService>(HttpService);

      const response = await lastValueFrom(
        httpService.get(`http://localhost:${serverPort}/test`)
      );

      expect(response.data).toEqual({ data: 'test' });
      expect(response.status).toBe(200);
    });

    it('should support httpAgent with other options', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            timeout: 5000,
            maxContentLength: 1000,
            httpAgent: new HttpAgent({ keepAlive: true }),
          }),
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();
      httpService = moduleRef.get<HttpService>(HttpService);

      const response = await lastValueFrom(
        httpService.get(`http://localhost:${serverPort}/test`)
      );

      expect(response.data).toEqual({ data: 'test' });
      expect(response.status).toBe(200);
    });

    it('should support withCredentials with other options', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            timeout: 5000,
            maxContentLength: 1000,
            withCredentials: true,
          }),
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();
      httpService = moduleRef.get<HttpService>(HttpService);

      const response = await lastValueFrom(
        httpService.get(`http://localhost:${serverPort}/test`)
      );

      expect(response.data).toEqual({ data: 'test' });
      expect(response.status).toBe(200);
    });
  });

  describe('Proxy Configuration', () => {
    it('should create module with proxy configuration without errors', async () => {
      // We can't actually test proxy functionality without a real proxy server
      // But we can verify the configuration is accepted
      const moduleRef = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            proxy: {
              host: 'proxy.example.com',
              port: 8080,
              auth: {
                username: 'user',
                password: 'pass',
              },
            },
          }),
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();
      httpService = moduleRef.get<HttpService>(HttpService);

      // Should be able to create the service without errors
      expect(httpService).toBeDefined();
    });
  });
});