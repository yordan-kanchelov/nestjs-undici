import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { request, type Dispatcher } from 'undici';

import { HttpService } from '../index';
import { HttpModule } from '../../../../index';

/**
 * Perf item: `unsupportedProtocol`'s fast path (case-insensitive `http://`/
 * `https://` prefix check, skipping the regex entirely) must keep exactly
 * the same accept/reject behaviour as the regex it bypasses - checked here
 * across casing, non-prefixed (relative) URLs, and unsupported schemes.
 */
jest.mock('undici', () => ({
  ...jest.requireActual('undici'),
  request: jest.fn(),
}));

const requestMock = request as jest.MockedFunction<typeof request>;

const okResponse = () =>
  ({
    statusCode: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: {
      json: jest.fn().mockResolvedValue({}),
      text: jest.fn().mockResolvedValue('{}'),
    },
    trailers: {},
    opaque: null,
    context: {},
  }) as unknown as Awaited<ReturnType<typeof request>>;

describe('HttpService: unsupported protocol fast path', () => {
  let service: HttpService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    service = module.get<HttpService>(HttpService);
  });

  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue(okResponse());
  });

  it.each([
    'http://example.test/x',
    'https://example.test/x',
    'HTTP://example.test/x',
    'HTTPS://example.test/x',
    'Http://Example.test/x',
    'hTtPs://example.test/x',
  ])(
    'dispatches a plain %s URL (any casing) instead of rejecting',
    async url => {
      await expect(firstValueFrom(service.get(url))).resolves.toBeDefined();
      expect(requestMock).toHaveBeenCalledTimes(1);
    },
  );

  it('dispatches a relative URL/path (no scheme) against a configured baseURL', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({ baseURL: 'http://example.test' })],
    }).compile();
    const scoped = module.get<HttpService>(HttpService);

    await expect(firstValueFrom(scoped.get('/x'))).resolves.toBeDefined();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it.each(['ftp://example.test/x', 'tel:+1234', 'file:///etc/passwd'])(
    'rejects %s synchronously with ERR_BAD_REQUEST, never dispatching',
    async url => {
      await expect(firstValueFrom(service.get(url))).rejects.toMatchObject({
        code: 'ERR_BAD_REQUEST',
        message: expect.stringContaining('Unsupported protocol'),
      });
      expect(requestMock).not.toHaveBeenCalled();
    },
  );

  it('rejects an unsupported protocol given as a URL instance the same way', async () => {
    await expect(
      firstValueFrom(service.get(new URL('ftp://example.test/x'))),
    ).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST' });
    expect(requestMock).not.toHaveBeenCalled();
  });
});

/**
 * plan.md phase 2 "fix: support data: URLs" (found by upstream conformance):
 * `axiosRef.get('data:...')` used to reject with `Unsupported protocol
 * data:` (the same `unsupportedProtocol` check above only allows
 * `http:`/`https:`); real axios decodes a `data:` URL entirely locally, no
 * network request at all - checked against real axios 1.20's own test
 * suite (`tests/unit/adapters/http.test.js`'s "Data URL" block).
 */
describe('HttpService: data: URLs (resolved locally, never dispatched)', () => {
  let service: HttpService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    service = module.get<HttpService>(HttpService);
  });

  beforeEach(() => {
    requestMock.mockReset();
  });

  it('resolves a data: URL as a Buffer, without ever calling undici', async () => {
    const buffer = Buffer.from('123');
    const dataURI = `data:application/octet-stream;base64,${buffer.toString('base64')}`;
    const response = await firstValueFrom(service.get(dataURI));
    expect(response.status).toBe(200);
    expect(Buffer.isBuffer(response.data)).toBe(true);
    expect((response.data as Buffer).equals(buffer)).toBe(true);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('resolves a data: URL given as a URL instance', async () => {
    const url = new URL('data:text/plain,hello');
    const response = await firstValueFrom(service.get(url));
    expect(response.data).toEqual(Buffer.from('hello'));
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects when maxContentLength is exceeded, without ever calling undici', async () => {
    const body = 'QQ' + '%41'.repeat(4000);
    await expect(
      firstValueFrom(
        service.get(`data:application/octet-stream;base64,${body}`, {
          maxContentLength: 3000,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
    expect(requestMock).not.toHaveBeenCalled();
  });
});
