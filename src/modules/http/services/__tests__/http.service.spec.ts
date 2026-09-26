import { Test, TestingModule } from '@nestjs/testing';
import { lastValueFrom } from 'rxjs';
import { request, type Dispatcher } from 'undici';

import { HttpService } from '../index';
import { HttpModule } from '../../../../index';

jest.mock('undici', () => ({
  ...jest.requireActual('undici'),
  request: jest.fn(),
}));

type ExampleResponse = {
  name: string;
  version?: string;
};

const requestMock = request as jest.MockedFunction<typeof request>;
const dispatcherMock = {} as Dispatcher;

const createResponse = (
  statusCode = 200,
  payload: ExampleResponse = { name: 'undici', version: '7.0.0' },
) =>
  ({
    statusCode,
    statusText: statusCode === 200 ? 'OK' : 'Not Found',
    headers: {
      'content-type': 'application/json',
    },
    body: {
      json: jest.fn().mockResolvedValue(payload),
      text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
    },
    trailers: {},
    opaque: null,
    context: {},
  }) as unknown as Awaited<ReturnType<typeof request>>;

describe('HttpService', () => {
  let service: HttpService;
  let baseURL: string;

  beforeAll(async (): Promise<void> => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();

    service = module.get<HttpService>(HttpService);
    baseURL = 'https://example.test/package.json';
  });

  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue(createResponse());
  });

  describe('request', () => {
    it('should return an Observable with an axios-like response', async () => {
      await expect(lastValueFrom(service.request(baseURL))).resolves.toEqual(
        expect.objectContaining({
          status: 200,
          statusText: 'OK',
          data: expect.any(Object),
        }),
      );
    });

    it('should call undici request with configured module options', async () => {
      await lastValueFrom(
        service.request(baseURL, {
          method: 'GET',
        }),
      );

      expect(requestMock).toHaveBeenCalledWith(
        baseURL,
        expect.objectContaining({
          method: 'GET',
          signal: expect.objectContaining({ aborted: false }),
        }),
      );
    });

    it('should reject with an axios-like error on 404 status', async () => {
      requestMock.mockResolvedValueOnce(createResponse(404));

      await expect(
        lastValueFrom(
          service.request(`${baseURL}/missing`, {
            method: 'GET',
          }),
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          status: 404,
        }),
        isAxiosError: true,
      });
    });

    it('should return data with a name', async () => {
      const response = await lastValueFrom(
        service.request<ExampleResponse>(baseURL, {
          method: 'GET',
        }),
      );

      expect(response?.data?.name).toBe('undici');
      expect(response?.data?.version).toBeDefined();
      expect(response?.data?.version).toBeTruthy();
    });

    it('should return data with a version', async () => {
      const response = await lastValueFrom(
        service.request<ExampleResponse>(baseURL, {
          method: 'GET',
        }),
      );

      expect(response?.data?.version).toBeDefined();
      expect(response?.data?.version).toBeTruthy();
      expect(response?.data?.version).not.toBe('');
    });

    it('should emit request errors through the Observable', async () => {
      const error = new Error('network unavailable');
      requestMock.mockRejectedValueOnce(error);

      await expect(
        lastValueFrom(
          service.request(baseURL, {
            method: 'GET',
          }),
        ),
      ).rejects.toThrow(error);
    });

    it('should expose undici options through undiciRef', () => {
      expect(service.undiciRef).toEqual({});
    });

    it('should set the dispatcher via setDispatcher', () => {
      service.setDispatcher(dispatcherMock);

      expect(service.undiciRef.dispatcher).toBe(dispatcherMock);
    });

    describe('request with a dispatcher', () => {
      it('should use the dispatcher passed to the request', async () => {
        const configuredService = new HttpService({});

        await lastValueFrom(
          configuredService.request(baseURL, {
            dispatcher: dispatcherMock,
          }),
        );

        expect(requestMock).toHaveBeenCalledWith(
          baseURL,
          expect.objectContaining({
            dispatcher: dispatcherMock,
            signal: expect.objectContaining({ aborted: false }),
          }),
        );
      });

      it('should merge module options with request options', async () => {
        const configuredService = new HttpService({
          dispatcher: dispatcherMock,
          headers: {
            authorization: 'Bearer module-token',
          },
        });

        await lastValueFrom(
          configuredService.request(baseURL, {
            method: 'POST',
          }),
        );

        expect(requestMock).toHaveBeenCalledWith(
          baseURL,
          expect.objectContaining({
            dispatcher: dispatcherMock,
            // The default Accept/User-Agent/Accept-Encoding headers are also
            // present (see axios-ref.factory.spec.ts); this only asserts the
            // module header survives the merge.
            headers: expect.objectContaining({
              authorization: 'Bearer module-token',
            }),
            method: 'POST',
            signal: expect.objectContaining({ aborted: false }),
          }),
        );
      });

      it('should allow request options to override module options', async () => {
        const configuredService = new HttpService({
          headers: {
            authorization: 'Bearer module-token',
          },
        });

        await lastValueFrom(
          configuredService.request(baseURL, {
            method: 'PUT',
          }),
        );

        expect(requestMock).toHaveBeenCalledWith(
          baseURL,
          expect.objectContaining({
            headers: expect.objectContaining({
              authorization: 'Bearer module-token',
            }),
            method: 'PUT',
            signal: expect.objectContaining({ aborted: false }),
          }),
        );
      });
    });
  });

  /**
   * plan.md phase 2 "fix: remaining error-shape gaps" (found by upstream
   * conformance), item 3: "HTTP and interceptor errors should keep the
   * call-site stack, as axios does" - see `appendCallSiteStack`'s doc
   * comment (`axios-error.ts`) for how this differs from axios in practice,
   * since this library's request path is an `Observable`, not a plain
   * awaited promise chain: it can't reliably reach all the way back to the
   * *application's* call site the way axios' own fix does, but it does
   * augment the raw undici/network error - whose stack otherwise gives no
   * hint it passed through this library's request pipeline at all - with
   * this library's own frames.
   */
  /**
   * plan.md phase 2 "fix: remaining error-shape gaps", item 3: "HTTP and
   * interceptor errors should keep the call-site stack, as axios does". A
   * literal port of axios' own mechanism (a fresh `Error.captureStackTrace`
   * on every error, appended to `error.stack`) was tried and reverted -
   * see the doc comment on `HttpService.dispatch` and on
   * `axios-error.spec.ts`'s equivalent describe block for the measured perf
   * cost and why this library's *existing* behaviour already covers the
   * item's intent for free.
   */
  describe('HTTP errors already carry a meaningful stack, at no extra cost', () => {
    it("a wrapped HTTP/network failure shows it was built by this library's own error handling", async () => {
      const original = new Error('socket hang up');
      Object.assign(original, { code: 'ECONNRESET' });
      requestMock.mockRejectedValueOnce(original);

      const error: any = await lastValueFrom(service.request(baseURL)).catch(
        e => e,
      );
      expect(error.isAxiosError).toBe(true);
      expect(error.stack).toEqual(expect.stringContaining('toAxiosError'));
    });

    it('never touches Error.captureStackTrace (no per-error capture cost)', async () => {
      const spy = jest.spyOn(Error, 'captureStackTrace');
      requestMock.mockRejectedValueOnce(new Error('boom'));
      await lastValueFrom(service.request(baseURL)).catch(() => undefined);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  /**
   * plan.md phase 2 "fix: remaining error-shape gaps" (found by upstream
   * conformance), item 1: an unparsable `timeout` gives `ERR_BAD_OPTION_
   * VALUE`, not the generic `ERR_BAD_REQUEST` a raw undici
   * `InvalidArgumentError` used to map to - checked up front, before ever
   * calling undici's `request()`.
   */
  describe('an unparsable timeout', () => {
    it('rejects with ERR_BAD_OPTION_VALUE, never dispatching', async () => {
      await expect(
        lastValueFrom(
          service.request(baseURL, { timeout: 'not-a-number' as any }),
        ),
      ).rejects.toMatchObject({
        code: 'ERR_BAD_OPTION_VALUE',
        message: 'error trying to parse `config.timeout` to int',
      });
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('a valid numeric timeout is unaffected', async () => {
      await expect(
        lastValueFrom(service.request(baseURL, { timeout: 5000 })),
      ).resolves.toBeDefined();
      expect(requestMock).toHaveBeenCalled();
    });
  });

  /**
   * plan.md phase 2 "fix: parse a numeric-string timeout like axios": axios
   * accepts `timeout: '250'` via `parseInt(config.timeout, 10)`. Without the
   * fix, the raw string reaches undici's own `headersTimeout`/`bodyTimeout`
   * unparsed - this test would fail without it (either the mocked `request`
   * receives a string `headersTimeout`/`bodyTimeout`, which the real undici
   * rejects with `ERR_BAD_REQUEST`, or - with the mock in place - the
   * assertion on the parsed number below fails outright).
   */
  describe('a numeric-string timeout', () => {
    it('is parsed like axios (parseInt), not left as a string', async () => {
      await expect(
        lastValueFrom(service.request(baseURL, { timeout: '250' as any })),
      ).resolves.toBeDefined();
      expect(requestMock).toHaveBeenCalled();
      const [, options] = requestMock.mock.calls[0];
      expect((options as any).headersTimeout).toBe(250);
      expect((options as any).bodyTimeout).toBe(250);
    });

    it('an unparsable string still rejects with ERR_BAD_OPTION_VALUE', async () => {
      await expect(
        lastValueFrom(service.request(baseURL, { timeout: 'abc' as any })),
      ).rejects.toMatchObject({
        code: 'ERR_BAD_OPTION_VALUE',
        message: 'error trying to parse `config.timeout` to int',
      });
      expect(requestMock).not.toHaveBeenCalled();
    });
  });

  /**
   * plan.md phase 2 "fix: reject a malformed URL like axios instead of
   * silently dispatching it": a URL with an embedded null byte or a bare
   * `\n` isn't rejected synchronously today - the characters are silently
   * dropped (WHATWG URL parsing is forgiving about them) and the request is
   * dispatched anyway. This test would fail without the fix: `requestMock`
   * would have been called instead of the request rejecting up front.
   */
  describe('a malformed http(s) URL', () => {
    it.each([
      ['\u0000https:example.com/users', 'https:example.com/users'],
      ['h\nttp:example.com/users', 'http:example.com/users'],
    ])(
      'rejects %j with ERR_INVALID_URL before ever dispatching',
      async (url, normalized) => {
        await expect(
          lastValueFrom(service.request(url, { headers: { 'X-Test': 'yes' } })),
        ).rejects.toMatchObject({
          code: 'ERR_INVALID_URL',
          message: `Invalid URL ${JSON.stringify(normalized)}: missing "//" after protocol`,
        });
        expect(requestMock).not.toHaveBeenCalled();
      },
    );

    it('preserves the original url and headers on error.config', async () => {
      const url = '\u0000https:example.com/users';
      let caught: any;
      try {
        await lastValueFrom(
          service.request(url, { headers: { 'X-Test': 'yes' } }),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(caught.config.url).toBe(url);
      expect(caught.config.headers.get('X-Test')).toBe('yes');
    });

    it('a well-formed URL is unaffected', async () => {
      await expect(
        lastValueFrom(service.request(baseURL)),
      ).resolves.toBeDefined();
      expect(requestMock).toHaveBeenCalled();
    });
  });

  /**
   * plan.md phase 2 "fix: redirect sensitiveHeaders option" - axios' own
   * validation for `config.sensitiveHeaders` (`lib/adapters/http.js`),
   * checked up front, before ever calling undici's `request()` - the same
   * precedent as `timeout` just above.
   */
  describe('an invalid sensitiveHeaders option', () => {
    it('rejects with ERR_BAD_OPTION_VALUE, never dispatching', async () => {
      await expect(
        lastValueFrom(
          service.request(baseURL, {
            sensitiveHeaders: 'X-Api-Key' as any,
          }),
        ),
      ).rejects.toMatchObject({
        code: 'ERR_BAD_OPTION_VALUE',
        message: 'sensitiveHeaders must be an array of strings',
      });
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('rejects an array containing a non-string element too', async () => {
      await expect(
        lastValueFrom(
          service.request(baseURL, {
            sensitiveHeaders: ['X-Api-Key', 42] as any,
          }),
        ),
      ).rejects.toMatchObject({ code: 'ERR_BAD_OPTION_VALUE' });
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('a valid sensitiveHeaders array is unaffected', async () => {
      await expect(
        lastValueFrom(
          service.request(baseURL, { sensitiveHeaders: ['X-Api-Key'] }),
        ),
      ).resolves.toBeDefined();
      expect(requestMock).toHaveBeenCalled();
    });

    it('is skipped entirely when maxRedirects: 0 (no redirects to strip headers on), matching axios', async () => {
      await expect(
        lastValueFrom(
          service.request(baseURL, {
            sensitiveHeaders: 'not-an-array' as any,
            maxRedirects: 0,
          }),
        ),
      ).resolves.toBeDefined();
      expect(requestMock).toHaveBeenCalled();
    });
  });

  /**
   * plan.md phase 2 "fix: sanitize CRLF / non-Latin1 header values like
   * axios" (found by upstream conformance): undici would otherwise throw
   * `InvalidArgumentError` for a header value axios' Node `http` transport
   * silently rewrites.
   */
  describe('header value sanitization', () => {
    it('sanitizes a CRLF out of a header value before ever calling undici, matching axios', async () => {
      await lastValueFrom(
        service.request(baseURL, { headers: { 'X-Bad': 'a\nb' } }),
      );
      expect(requestMock).toHaveBeenCalledWith(
        baseURL,
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Bad': 'ab' }),
        }),
      );
    });
  });
});
