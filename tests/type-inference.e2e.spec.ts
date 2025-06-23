import { Test, TestingModule } from '@nestjs/testing';
import { Injectable, Inject } from '@nestjs/common';
import { HttpModule, HttpService } from '../src';
import { lastValueFrom, Observable } from 'rxjs';
import type { AxiosLikeResponse } from '../src/modules/http/interfaces';
import type { Dispatcher } from 'undici';

describe('Type Inference Patterns E2E', () => {
  describe('Standard HttpService (axios-compatible by default)', () => {
    @Injectable()
    class StandardTestService {
      constructor(private readonly httpService: HttpService) {}

      async fetchData() {
        const response = await lastValueFrom(
          this.httpService.get<{ id: number; title: string }>('https://jsonplaceholder.typicode.com/posts/1')
        );
        
        // Response is already AxiosLikeResponse type
        expect(response.status).toBeDefined();
        expect(response.data).toBeDefined();
        
        return response.data;
      }
    }

    let service: StandardTestService;

    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
        providers: [StandardTestService],
      }).compile();

      service = module.get<StandardTestService>(StandardTestService);
    });

    it('should work with axios-compatible responses by default', async () => {
      const data = await service.fetchData();
      expect(data.id).toBe(1);
      expect(data.title).toBeDefined();
    });
  });

  describe('HttpService with type-safe responses', () => {
    @Injectable()
    class TypedTestService {
      constructor(private readonly httpService: HttpService) {}

      async fetchData() {
        const response = await lastValueFrom(
          this.httpService.get<{ id: number; title: string }>('https://jsonplaceholder.typicode.com/posts/1')
        );
        
        // TypeScript knows these properties exist
        expect(response.data).toBeDefined();
        expect(response.status).toBe(200);
        expect(response.statusText).toBe('OK');
        
        return response.data;
      }
    }

    let service: TypedTestService;

    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
        providers: [TypedTestService],
      }).compile();

      service = module.get<TypedTestService>(TypedTestService);
    });

    it('should work with axios-compatible responses', async () => {
      const data = await service.fetchData();
      expect(data.id).toBe(1);
      expect(data.title).toBeDefined();
    });
  });

  describe('Direct usage without casting', () => {
    @Injectable()
    class DirectService {
      constructor(private readonly httpService: HttpService) {}

      async fetchData() {
        const response = await lastValueFrom(
          this.httpService.get<{ id: number }>('https://jsonplaceholder.typicode.com/posts/1')
        );
        
        return response.data;
      }
    }

    let service: DirectService;

    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
        providers: [DirectService],
      }).compile();

      service = module.get<DirectService>(DirectService);
    });

    it('should work without type casting', async () => {
      const data = await service.fetchData();
      expect(data.id).toBe(1);
    });
  });

  describe('Response handling pattern', () => {
    @Injectable()
    class ResponseService {
      constructor(private readonly httpService: HttpService) {}

      async fetchData() {
        const response = await lastValueFrom(
          this.httpService.get<{ id: number }>('https://jsonplaceholder.typicode.com/posts/1')
        );
        // Always returns AxiosLikeResponse
        return response.data;
      }

      async fetchWithHeaders() {
        const response = await lastValueFrom(
          this.httpService.get('https://jsonplaceholder.typicode.com/posts/1')
        );
        return {
          data: response.data,
          contentType: response.headers['content-type'],
          status: response.status
        };
      }
    }

    it('should always return axios-compatible responses', async () => {
      const module = await Test.createTestingModule({
        imports: [HttpModule.register({})],
        providers: [ResponseService],
      }).compile();

      const service = module.get<ResponseService>(ResponseService);
      
      const data = await service.fetchData();
      expect(data.id).toBe(1);
      
      const withHeaders = await service.fetchWithHeaders();
      expect(withHeaders.status).toBe(200);
      expect(withHeaders.contentType).toContain('application/json');
    });
  });

  describe('Service injection pattern', () => {
    @Injectable()
    class InjectedService {
      constructor(private readonly httpService: HttpService) {}

      async fetchData() {
        const response = await lastValueFrom(
          this.httpService.get<{ id: number }>('https://jsonplaceholder.typicode.com/posts/1')
        );
        return response.data;
      }
    }

    let service: InjectedService;

    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
        providers: [InjectedService],
      }).compile();

      service = module.get<InjectedService>(InjectedService);
    });

    it('should work with standard injection', async () => {
      const data = await service.fetchData();
      expect(data.id).toBe(1);
    });
  });

  describe('Type assertions for compile-time safety', () => {
    it('should compile with correct types', () => {
      // These are compile-time checks - if they compile, the test passes
      
      // HttpService now returns AxiosLikeResponse
      type GetReturn = ReturnType<HttpService['get']>;
      type IsObservable = GetReturn extends Observable<AxiosLikeResponse> ? true : false;
      const isObservable: IsObservable = true;
      expect(isObservable).toBe(true);
      
      // Check that response has expected properties
      type ResponseHasData = AxiosLikeResponse extends { data: any } ? true : false;
      const hasData: ResponseHasData = true;
      expect(hasData).toBe(true);
      
      // Check that response has status
      type ResponseHasStatus = AxiosLikeResponse extends { status: number } ? true : false;
      const hasStatus: ResponseHasStatus = true;
      expect(hasStatus).toBe(true);
    });
  });
});