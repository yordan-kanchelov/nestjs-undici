import { Test, TestingModule } from '@nestjs/testing';
import { of, firstValueFrom } from 'rxjs';
import { AxiosResponseAdapterInterceptor, axiosResponseAdapter } from '../axios-response-adapter.interceptor';
import type { HttpInterceptorHandler, HttpInterceptorRequest } from '../../interfaces';
import type { Dispatcher } from 'undici';

describe('AxiosResponseAdapterInterceptor', () => {
  let interceptor: AxiosResponseAdapterInterceptor;

  beforeEach(() => {
    interceptor = new AxiosResponseAdapterInterceptor();
  });

  const createMockRequest = (): HttpInterceptorRequest => ({
    url: 'https://api.example.com/data',
    options: {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
      },
    },
  });

  const createMockNext = (response: Partial<Dispatcher.ResponseData>): HttpInterceptorHandler => ({
    handle: jest.fn().mockReturnValue(of(response as Dispatcher.ResponseData)),
  });

  describe('intercept', () => {
    it('should transform JSON response to Axios format', async () => {
      const mockResponse: Partial<Dispatcher.ResponseData> = {
        statusCode: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: {
          json: jest.fn().mockResolvedValue({ id: 1, name: 'Test' }),
          text: jest.fn().mockResolvedValue('{"id":1,"name":"Test"}'),
          arrayBuffer: jest.fn(),
        } as any,
      };

      const request = createMockRequest();
      const next = createMockNext(mockResponse);

      const result: any = await firstValueFrom(interceptor.intercept(request, next));
      
      // Verify Axios-like structure
      expect(result.data).toEqual({ id: 1, name: 'Test' });
      expect(result.status).toBe(200);
      expect(result.statusText).toBe('OK');
      expect(result.headers).toBe(mockResponse.headers);
      expect(result.config).toMatchObject({
        url: 'https://api.example.com/data',
        method: 'GET',
        headers: request.options.headers,
      });
      
      // Verify body.text was called for JSON content
      expect(mockResponse.body.text).toHaveBeenCalled();
    });

    it('should transform text response to Axios format', async () => {
      const mockResponse: Partial<Dispatcher.ResponseData> = {
        statusCode: 201,
        headers: {
          'content-type': 'text/plain',
        },
        body: {
          json: jest.fn(),
          text: jest.fn().mockResolvedValue('Plain text response'),
          arrayBuffer: jest.fn(),
        } as any,
      };

      const request = createMockRequest();
      const next = createMockNext(mockResponse);

      const result: any = await firstValueFrom(interceptor.intercept(request, next));
      
      expect(result.data).toBe('Plain text response');
      expect(result.status).toBe(201);
      expect(result.statusText).toBe('Created');
      expect(mockResponse.body.text).toHaveBeenCalled();
    });

    it('should transform binary response to Buffer', async () => {
      const binaryData = new ArrayBuffer(8);
      const mockResponse: Partial<Dispatcher.ResponseData> = {
        statusCode: 200,
        headers: {
          'content-type': 'application/octet-stream',
        },
        body: {
          json: jest.fn(),
          text: jest.fn(),
          arrayBuffer: jest.fn().mockResolvedValue(binaryData),
        } as any,
      };

      const request = createMockRequest();
      const next = createMockNext(mockResponse);

      const result: any = await firstValueFrom(interceptor.intercept(request, next));
      
      expect(result.data).toBeInstanceOf(Buffer);
      expect(result.data.length).toBe(8);
      expect(mockResponse.body.arrayBuffer).toHaveBeenCalled();
    });

    it('should handle null body', async () => {
      const mockResponse: Partial<Dispatcher.ResponseData> = {
        statusCode: 204,
        headers: {},
        body: null as any,
      };

      const request = createMockRequest();
      const next = createMockNext(mockResponse);

      const result: any = await firstValueFrom(interceptor.intercept(request, next));
      
      expect(result.data).toBe('');
      expect(result.status).toBe(204);
      expect(result.statusText).toBe('No Content');
    });

    it('should handle parsing errors gracefully', async () => {
      const mockResponse: Partial<Dispatcher.ResponseData> = {
        statusCode: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: {
          json: jest.fn().mockRejectedValue(new Error('Invalid JSON')),
          text: jest.fn().mockResolvedValue('Invalid JSON text'),
          arrayBuffer: jest.fn(),
        } as any,
      };

      const request = createMockRequest();
      const next = createMockNext(mockResponse);

      const result: any = await firstValueFrom(interceptor.intercept(request, next));
      
      expect(result.data).toBe('Invalid JSON text');
      expect(result.status).toBe(200);
    });

    it('should handle unknown status codes', async () => {
      const mockResponse: Partial<Dispatcher.ResponseData> = {
        statusCode: 999,
        headers: {},
        body: {
          json: jest.fn().mockResolvedValue({}),
          text: jest.fn().mockResolvedValue('{}'),
          arrayBuffer: jest.fn(),
        } as any,
      };

      const request = createMockRequest();
      const next = createMockNext(mockResponse);

      await expect(firstValueFrom(interceptor.intercept(request, next))).rejects.toMatchObject({
        response: {
          status: 999,
          statusText: 'Unknown'
        },
        isAxiosError: true
      });
    });

    it('should handle XML content type as text', async () => {
      const xmlContent = '<?xml version="1.0"?><root>test</root>';
      const mockResponse: Partial<Dispatcher.ResponseData> = {
        statusCode: 200,
        headers: {
          'content-type': 'application/xml',
        },
        body: {
          json: jest.fn(),
          text: jest.fn().mockResolvedValue(xmlContent),
          arrayBuffer: jest.fn(),
        } as any,
      };

      const request = createMockRequest();
      const next = createMockNext(mockResponse);

      const result: any = await firstValueFrom(interceptor.intercept(request, next));
      
      expect(result.data).toBe(xmlContent);
      expect(mockResponse.body.text).toHaveBeenCalled();
    });
  });

  describe('axiosResponseAdapter function', () => {
    it('should work as a function interceptor', async () => {
      const mockResponse: Partial<Dispatcher.ResponseData> = {
        statusCode: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: {
          json: jest.fn().mockResolvedValue({ success: true }),
          text: jest.fn().mockResolvedValue('{"success":true}'),
          arrayBuffer: jest.fn(),
        } as any,
      };

      const request = createMockRequest();
      const next = createMockNext(mockResponse);

      const result: any = await firstValueFrom(axiosResponseAdapter(request, next));
      
      expect(result.data).toEqual({ success: true });
      expect(result.status).toBe(200);
      expect(result.statusText).toBe('OK');
    });
  });
});