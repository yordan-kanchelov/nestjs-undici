import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule } from '../src/modules/http/http.module';
import { HttpService } from '../src/modules/http/services/http.service';
import { of } from 'rxjs';
import { map } from 'rxjs/operators';
import { AxiosLikeResponse } from '../src/modules/http/interfaces/axios-compatible.interface';

describe('Type Inference Test', () => {
  describe('Simplified: Always Axios-Compatible', () => {
    it('should work with direct data access', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);

      // Mock axios-compatible response
      jest.spyOn(httpService, 'get').mockReturnValue(
        of({
          data: [{ playerSessionId: '123', name: 'Player 1' }],
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {},
        } as AxiosLikeResponse<any[]>)
      );

      // Direct access to data property - no type checking needed
      httpService.get<any[]>('/test').pipe(
        map((response) => response.data) // ✅ Direct access
      ).subscribe(data => {
        expect(data).toEqual([{ playerSessionId: '123', name: 'Player 1' }]);
      });
    });
  });

  describe('Default Behavior: Axios Compatible', () => {
    it('should always return axios-compatible responses', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          HttpModule.register({
            // Axios compatible configuration
          }),
        ],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);

      // Mock the response
      const mockData = [{ playerSessionId: '123', name: 'Player 1' }];
      jest.spyOn(httpService, 'get').mockReturnValue(
        of({
          data: mockData,
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as any,
        } as AxiosLikeResponse<any[]>)
      );

      const result = await new Promise((resolve) => {
        httpService.get<any[]>('/test').pipe(
          map((response) => response.data), // ✅ No type error!
        ).subscribe(resolve);
      });

      expect(result).toEqual(mockData);
    });
  });

  describe('Direct Access Pattern', () => {
    it('should allow direct property access', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [HttpModule.register({})],
      }).compile();

      const httpService = module.get<HttpService>(HttpService);

      // Mock axios-like response
      jest.spyOn(httpService, 'get').mockReturnValue(
        of({
          data: [{ playerSessionId: '123', name: 'Player 1' }],
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as any,
        } as AxiosLikeResponse<any[]>)
      );

      const result = await new Promise((resolve) => {
        httpService.get<any[]>('/test').pipe(
          map((response) => response.data), // ✅ Direct access
        ).subscribe(resolve);
      });

      expect(result).toBeDefined();
      expect(result).toHaveLength(1);
    });
  });
});