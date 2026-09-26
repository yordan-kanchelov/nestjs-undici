/**
 * axios-mock-adapter compatibility (plan.md phase 2 "feat(axiosRef): make
 * it a real axios instance", item 3: a function `adapter`). `MockAdapter`
 * is the standard way to mock HTTP in NestJS/axios test suites: it sets
 * `axiosInstance.defaults.adapter` to its own function and expects
 * `axiosInstance.create()` to exist (for `axiosInstanceWithoutInterceptors`).
 * No network call, no local server: the adapter intercepts before undici
 * ever runs (`HttpService.executeAdapter`), so a wrong host/port never
 * matters - every case below uses an address nothing listens on.
 *
 * Run twice, first against real @nestjs/axios (proving MockAdapter's own
 * contract), then against this library's `HttpService`/`axiosRef`, with the
 * same assertions - the differential this item's tests ask for.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import MockAdapter from 'axios-mock-adapter';
import {
  HttpModule as RefHttpModule,
  HttpService as RefHttpService,
} from '@nestjs/axios';
import { HttpModule, HttpService } from '../src';

const UNREACHABLE = 'http://127.0.0.1:1'; // nothing listens here; the adapter must intercept first

describe.each([
  ['@nestjs/axios', RefHttpModule, RefHttpService] as const,
  ['this library', HttpModule, HttpService] as const,
])('axios-mock-adapter with %s', (_label, Module, ServiceCls) => {
  let testModule: TestingModule;
  let service: any;
  let mock: MockAdapter;

  beforeEach(async () => {
    testModule = await Test.createTestingModule({
      imports: [Module.register({ baseURL: UNREACHABLE })],
    }).compile();
    service = testModule.get(ServiceCls as any);
    mock = new MockAdapter(service.axiosRef);
  });

  afterEach(async () => {
    mock.restore();
    await testModule.close();
  });

  it('mocks a GET response', async () => {
    mock.onGet('/users/1').reply(200, { id: 1, name: 'Ada' });
    const res: any = await firstValueFrom(service.get('/users/1'));
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id: 1, name: 'Ada' });
  });

  it('mocks a POST response and sees the sent body', async () => {
    mock.onPost('/users').reply(config => {
      const body = JSON.parse(config.data);
      return [201, { id: 2, ...body }];
    });
    const res: any = await firstValueFrom(
      service.post('/users', { name: 'Grace' }),
    );
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ id: 2, name: 'Grace' });
  });

  it('mocks response headers', async () => {
    mock.onGet('/x').reply(200, 'ok', { 'x-mock': 'yes' });
    const res: any = await firstValueFrom(service.get('/x'));
    expect(res.headers['x-mock']).toBe('yes');
  });

  it('a non-2xx mocked status rejects like a real error response', async () => {
    mock.onGet('/missing').reply(404, { message: 'not found' });
    await expect(firstValueFrom(service.get('/missing'))).rejects.toMatchObject(
      {
        isAxiosError: true,
        response: { status: 404, data: { message: 'not found' } },
      },
    );
  });

  it('networkError() rejects with a network-style error', async () => {
    mock.onGet('/boom').networkError();
    await expect(firstValueFrom(service.get('/boom'))).rejects.toBeTruthy();
  });

  it('an unmatched route rejects (default onNoMatch)', async () => {
    await expect(
      firstValueFrom(service.get('/unmatched-route')),
    ).rejects.toBeTruthy();
  });

  it('axiosRef(config), called directly, is also mocked', async () => {
    mock.onGet('/direct').reply(200, { via: 'callable axiosRef' });
    const res = await service.axiosRef({ url: '/direct', method: 'get' });
    expect(res.data).toEqual({ via: 'callable axiosRef' });
  });
});
