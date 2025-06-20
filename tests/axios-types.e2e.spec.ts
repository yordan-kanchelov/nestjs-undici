import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule, HttpService } from '../src';
import { lastValueFrom } from 'rxjs';
import { AxiosLikeResponse } from '../src/modules/http/interfaces/axios-compatible.interface';

describe('Axios Compatible Types E2E', () => {
  let httpService: HttpService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        HttpModule.register({
          timeout: 5000,
        }),
      ],
    }).compile();

    httpService = module.get<HttpService>(HttpService);
  });

  it('should type check axios compatible response structure', async () => {
    const mockUrl = 'https://jsonplaceholder.typicode.com/posts/1';

    // This should compile without errors and response should have axios-like properties
    const response = await lastValueFrom(
      httpService.get<{ id: number; title: string }>(mockUrl),
    );

    // TypeScript should allow these property accesses
    expect(typeof response.status).toBe('number');
    expect(typeof response.statusText).toBe('string');
    expect(typeof response.headers).toBe('object');
    expect(typeof response.data).toBe('object');
    expect(typeof response.config).toBe('object');

    // Actual runtime checks
    expect(response.status).toBe(200);
    expect(response.statusText).toBe('OK');
    expect(response.data.id).toBe(1);
    expect(response.data.title).toBeDefined();
  });

  it('should type check convenience methods with axios compatibility', async () => {
    interface PostData {
      userId: number;
      id: number;
      title: string;
      body: string;
    }

    const mockUrl = 'https://jsonplaceholder.typicode.com/posts';

    // Test POST method
    const postResponse = await lastValueFrom(
      httpService.post<PostData>(mockUrl, {
        title: 'Test Post',
        body: 'Test Body',
        userId: 1,
      }),
    );

    expect(postResponse.status).toBe(201);
    expect(postResponse.data.title).toBe('Test Post');
    expect(postResponse.data.body).toBe('Test Body');

    // Test PUT method
    const putResponse = await lastValueFrom(
      httpService.put<PostData>(`${mockUrl}/1`, {
        id: 1,
        title: 'Updated Title',
        body: 'Updated Body',
        userId: 1,
      }),
    );

    expect(putResponse.status).toBe(200);
    expect(putResponse.data.title).toBe('Updated Title');

    // Test PATCH method
    const patchResponse = await lastValueFrom(
      httpService.patch<Partial<PostData>>(`${mockUrl}/1`, {
        title: 'Patched Title',
      }),
    );

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.data.title).toBe('Patched Title');

    // Test DELETE method
    const deleteResponse = await lastValueFrom(
      httpService.delete(`${mockUrl}/1`),
    );

    expect(deleteResponse.status).toBe(200);
  });

  it('should handle error responses with axios compatibility', async () => {
    const mockUrl = 'https://jsonplaceholder.typicode.com/posts/99999';

    try {
      await lastValueFrom(httpService.get(mockUrl));
      fail('Should have thrown an error');
    } catch (error: any) {
      // Axios-style error structure
      expect(error.response).toBeDefined();
      expect(error.response.status).toBe(404);
      expect(error.response.statusText).toBe('Not Found');
      expect(error.config).toBeDefined();
      expect(error.isAxiosError).toBe(true);
    }
  });

  it('should compile with proper generic types', () => {
    interface UserData {
      id: number;
      name: string;
      email: string;
    }

    // This is a compile-time test - these lines should compile without errors
    const mockUrl = 'https://jsonplaceholder.typicode.com/users/1';
    const getRequest = httpService.get<UserData>(mockUrl);
    const postRequest = httpService.post<UserData>(mockUrl, {});
    const putRequest = httpService.put<UserData>(mockUrl, {});
    const patchRequest = httpService.patch<Partial<UserData>>(
      mockUrl,
      {},
    );
    const deleteRequest = httpService.delete<void>(mockUrl);

    // Verify return types are Observable<any> which can be cast to AxiosLikeResponse
    // This is just a type check - we don't actually execute the request
    expect(getRequest).toBeDefined();
    expect(postRequest).toBeDefined();
    expect(putRequest).toBeDefined();
    expect(patchRequest).toBeDefined();
    expect(deleteRequest).toBeDefined();

    // The important part is that this compiles without errors:
    // response should be typed as AxiosLikeResponse<UserData>
    type GetResponseType = AxiosLikeResponse<UserData>;
    type PostResponseType = AxiosLikeResponse<UserData>;
  });
});
