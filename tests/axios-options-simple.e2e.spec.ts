import { Test } from '@nestjs/testing';
import { HttpModule, HttpService } from '../src';
import { INestApplication } from '@nestjs/common';
import { lastValueFrom } from 'rxjs';
import * as http from 'http';

describe('Axios Options - Simple Tests', () => {
  let app: INestApplication;
  let httpService: HttpService;
  let server: http.Server;
  let serverPort: number;

  beforeAll((done) => {
    // Create a simple test server
    server = http.createServer((req, res) => {
      const url = req.url || '';
      
      if (url === '/small') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('x'.repeat(50)); // 50 bytes
      } else if (url === '/large') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('x'.repeat(200)); // 200 bytes
      } else if (url === '/echo' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: body }));
        });
      } else if (url === '/cookie-set') {
        res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Set-Cookie': 'test=value123; Path=/; Domain=localhost'
        });
        res.end(JSON.stringify({ success: true }));
      } else if (url === '/cookie-check') {
        const cookies = req.headers.cookie || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cookies }));
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

  describe('maxContentLength', () => {
    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            maxContentLength: 100, // 100 bytes limit
          }),
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();
      httpService = moduleRef.get<HttpService>(HttpService);
    });

    afterEach(async () => {
      await app.close();
    });

    it('should accept responses within limit', async () => {
      const response = await lastValueFrom(
        httpService.get(`http://localhost:${serverPort}/small`)
      );
      
      expect(response.data).toBe('x'.repeat(50));
      expect(response.status).toBe(200);
    });

    it('should reject responses exceeding limit', async () => {
      await expect(
        lastValueFrom(httpService.get(`http://localhost:${serverPort}/large`))
      ).rejects.toThrow(/maxContentLength/);
    });
  });

  describe('maxBodyLength', () => {
    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            maxBodyLength: 100, // 100 bytes limit
          }),
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();
      httpService = moduleRef.get<HttpService>(HttpService);
    });

    afterEach(async () => {
      await app.close();
    });

    it('should accept requests with body within limit', async () => {
      const smallBody = 'x'.repeat(50);
      const response = await lastValueFrom(
        httpService.post(`http://localhost:${serverPort}/echo`, smallBody)
      );
      
      expect(response.data.received).toBe(smallBody);
    });

    it('should reject requests with body exceeding limit', async () => {
      const largeBody = 'x'.repeat(200);
      
      await expect(
        lastValueFrom(httpService.post(`http://localhost:${serverPort}/echo`, largeBody))
      ).rejects.toThrow(/maxBodyLength/);
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

    afterEach(async () => {
      await app.close();
    });

    it('should store and send cookies', async () => {
      // First request to set cookie
      const loginResponse = await lastValueFrom(
        httpService.get(`http://localhost:${serverPort}/cookie-set`)
      );
      expect(loginResponse.data.success).toBe(true);
      
      // Second request should include the cookie
      const checkResponse = await lastValueFrom(
        httpService.get(`http://localhost:${serverPort}/cookie-check`)
      );
      
      // With cookie support enabled, it should include the cookie
      expect(checkResponse.data.cookies).toContain('test=value123');
    });
  });

  describe('httpAgent - Connection Options', () => {
    beforeEach(async () => {
      const httpAgent = new http.Agent({
        keepAlive: true,
        maxSockets: 5,
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
    });

    afterEach(async () => {
      await app.close();
    });

    it('should use agent settings for requests', async () => {
      // Make multiple requests
      const promises = Array(3).fill(null).map(() => 
        lastValueFrom(httpService.get(`http://localhost:${serverPort}/small`))
      );
      
      const responses = await Promise.all(promises);
      
      // All should succeed
      expect(responses).toHaveLength(3);
      responses.forEach(response => {
        expect(response.data).toBe('x'.repeat(50));
      });
    });
  });
});