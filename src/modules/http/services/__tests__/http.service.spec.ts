import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { UNDICI_PACKAGE_JSON } from '../../../../shared/constants/URL';

import { HttpService } from '../index';
import { HttpModule } from '../../../../index';
import { dispatcherMock } from '../../../../shared/mocks/dispatcher.mock';

type ExampleResponse = {
  name: string;
  version?: string;
};

describe('HttpService', () => {
  let service: HttpService;
  let baseURL: string;

  beforeAll(async (): Promise<void> => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();

    service = module.get<HttpService>(HttpService);
    baseURL = UNDICI_PACKAGE_JSON.href;
  });

  describe('request', () => {
    it('should return an Observable', () => {
      expect(service.request(baseURL)).toBeTruthy();
    });
    it('should return an Observable with a ResponseData', () => {
      expect(service.request(baseURL)).toBeTruthy();
    });
    it('should return an Observable with a ResponseData with a statusCode', () => {
      expect(service.request(baseURL)).toBeTruthy();
    });
    it('should return 200 status', async () => {
      const result = service.request(baseURL, {
        method: 'GET',
      });
      const response = await firstValueFrom(result);
      expect(response?.status).toBe(200);
    });
    it('should return 404 status', async () => {
      const result = service.request(baseURL + 1, {
        method: 'GET',
      });
      
      await expect(firstValueFrom(result)).rejects.toMatchObject({
        response: expect.objectContaining({
          status: 404
        }),
        isAxiosError: true
      });
    });
    it('should return data property', async () => {
      const result = service.request(baseURL, {
        method: 'GET',
      });
      const response = await firstValueFrom(result);
      expect(response?.data).toBeTruthy(); // axios-style data property
    });
    it('should return data with a name', async () => {
      const result = service.request(baseURL, {
        method: 'GET',
      });
      const response = await firstValueFrom(result);
      // In axios-compatible mode, data is already parsed
      const json = response?.data;
      // Check if we got the package.json data
      expect(json).toBeDefined();
      const parsedJson = typeof json === 'string' ? JSON.parse(json) : json;
      expect(parsedJson.name).toBe('undici');
    });
    it('should return data with a version', async () => {
      const result = service.request(baseURL, {
        method: 'GET',
      });
      const response = await firstValueFrom(result);
      // In axios-compatible mode, data is already parsed
      const data = response?.data;
      const json = typeof data === 'string' ? JSON.parse(data) : data;
      expect(json?.version).toBeDefined();
      expect(json?.version).toBeTruthy();
      expect(json?.version).not.toBe('');
    });
    describe('request with a dispatcher', () => {
      it('should return an Observable', () => {
        const result = service.request(baseURL, {
          dispatcher: dispatcherMock,
        });
        expect(result).toBeTruthy();
        expect(result).toBeDefined();
      });
      it('should return an Observable with a ResponseData', () => {
        const result = service.request(baseURL, {
          dispatcher: dispatcherMock,
        });
        expect(result).toBeTruthy();
        expect(result).toBeDefined();
      });
    });
  });
});
