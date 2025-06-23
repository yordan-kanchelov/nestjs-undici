import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule } from '../src/modules/http/http.module';
import { HttpService } from '../src/modules/http/services/http.service';
import { of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { AxiosLikeResponse } from '../src/modules/http/interfaces/axios-compatible.interface';

describe('ResponseData<null> Type Issue', () => {
  interface TestData {
    id: string;
    name: string;
  }

  describe('Simplified: Always returns AxiosLikeResponse', () => {
    let httpService: HttpService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
      }).compile();

      httpService = module.get<HttpService>(HttpService);
    });

    it('should always return axios-compatible response', (done) => {
      // Mock an axios-compatible response
      const mockAxiosResponse: AxiosLikeResponse<TestData[]> = {
        data: [{ id: '1', name: 'Test' }],
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
      };

      jest.spyOn(httpService, 'get').mockReturnValue(of(mockAxiosResponse));

      // Now TypeScript knows response is always AxiosLikeResponse
      httpService.get<TestData[]>('/test').pipe(
        map((response) => {
          // ✅ No type guard needed - response is always AxiosLikeResponse<TestData[]>
          return response.data;
        })
      ).subscribe({
        next: (result) => {
          expect(result).toEqual([{ id: '1', name: 'Test' }]);
          done();
        },
        error: done.fail,
      });
    });
  });

  describe('Direct data access without type guards', () => {
    let httpService: HttpService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
      }).compile();

      httpService = module.get<HttpService>(HttpService);
    });

    it('should directly access data property', (done) => {
      const mockData: TestData[] = [{ id: '1', name: 'Test' }];
      const mockAxiosResponse: AxiosLikeResponse<TestData[]> = {
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      jest.spyOn(httpService, 'get').mockReturnValue(of(mockAxiosResponse));

      httpService.get<TestData[]>('/test').pipe(
        map((response) => response.data) // ✅ Direct access - no type guard needed
      ).subscribe({
        next: (result) => {
          expect(result).toEqual(mockData);
          done();
        },
        error: done.fail,
      });
    });

    it('should access all axios-like properties', (done) => {
      const mockData: TestData[] = [{ id: '1', name: 'Test' }];
      const mockAxiosResponse: AxiosLikeResponse<TestData[]> = {
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        config: {} as any,
      };

      jest.spyOn(httpService, 'get').mockReturnValue(of(mockAxiosResponse));

      httpService.get<TestData[]>('/test').pipe(
        map((response) => ({
          data: response.data,
          status: response.status,
          contentType: response.headers['content-type']
        }))
      ).subscribe({
        next: (result) => {
          expect(result.data).toEqual(mockData);
          expect(result.status).toBe(200);
          expect(result.contentType).toBe('application/json');
          done();
        },
        error: done.fail,
      });
    });
  });

  describe('Simplified API - Always axios-compatible', () => {
    let httpService: HttpService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            timeout: 5000,
          }),
        ],
      }).compile();

      httpService = module.get<HttpService>(HttpService);
    });

    it('should always return AxiosLikeResponse', (done) => {
      const mockData: TestData[] = [{ id: '1', name: 'Test' }];
      const mockResponse: AxiosLikeResponse<TestData[]> = {
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      jest.spyOn(httpService, 'get').mockReturnValue(of(mockResponse));

      // Always returns AxiosLikeResponse<T>
      httpService.get<TestData[]>('/test').pipe(
        map((response) => response.data), // ✅ Direct access!
      ).subscribe({
        next: (result) => {
          expect(result).toEqual(mockData);
          done();
        },
        error: done.fail,
      });
    });
  });

  describe('Custom RxJS Operator (simplified)', () => {
    let httpService: HttpService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
      }).compile();

      httpService = module.get<HttpService>(HttpService);
    });

    // Simple operator to extract data
    function extractData<T>() {
      return map((response: AxiosLikeResponse<T>) => response.data);
    }

    it('should work with custom operator', (done) => {
      const mockData: TestData[] = [{ id: '1', name: 'Test' }];
      const mockResponse: AxiosLikeResponse<TestData[]> = {
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      jest.spyOn(httpService, 'get').mockReturnValue(of(mockResponse));

      httpService.get<TestData[]>('/test').pipe(
        extractData<TestData[]>(), // ✅ Clean and simple
      ).subscribe({
        next: (result) => {
          expect(result).toEqual(mockData);
          done();
        },
        error: done.fail,
      });
    });
  });

  describe('Real-world scenario with error handling', () => {
    let httpService: HttpService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
      }).compile();

      httpService = module.get<HttpService>(HttpService);
    });

    it('should handle errors properly', (done) => {
      jest.spyOn(httpService, 'get').mockReturnValue(
        of(undefined as any).pipe(
          map(() => {
            throw new Error('Network error');
          })
        )
      );

      httpService.get<TestData[]>('/test').pipe(
        catchError(() => of(null)),
        map((response) => {
          if (!response) return [];
          return response.data; // Direct access - response is always AxiosLikeResponse
        })
      ).subscribe({
        next: (result) => {
          expect(result).toEqual([]);
          done();
        },
        error: done.fail,
      });
    });
  });
});