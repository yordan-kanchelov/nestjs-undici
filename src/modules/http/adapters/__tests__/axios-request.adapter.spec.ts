import {
  buildFormData,
  buildFormRequestConfig,
  buildFormSerializedPairs,
  buildAxiosConfig,
  buildURL,
  combineURLs,
  extractUrlCredentials,
  formDataToJSON,
  isAxiosRequestConfig,
  mergeHeaders,
  normalizeAxiosRequest,
  serializeAxiosConfig,
  serializeRequestData,
  SIGNAL_CLEANUP,
  toUrlEncodedForm,
} from '../axios-request.adapter';
import { createAxiosRefDefaults } from '../axios-ref.factory';
import { AxiosHeaders } from '../../interfaces/axios-headers';

describe('axios request adapter', () => {
  describe('normalizeAxiosRequest', () => {
    it('returns the options untouched when there is nothing axios-specific to do', () => {
      const options = { method: 'GET', headersTimeout: 5 };
      const result = normalizeAxiosRequest('http://api/x', options);
      expect(result.url).toBe('http://api/x');
      expect(result.options).toBe(options);
    });

    it('accepts the request(config) form and upper-cases the method', () => {
      const { url, options } = normalizeAxiosRequest(
        {
          url: 'http://api/x',
          method: 'post',
          data: { a: 1 },
          params: { q: 1 },
        },
        undefined,
      );
      expect(url).toBe('http://api/x?q=1');
      expect(options).toMatchObject({
        method: 'POST',
        body: '{"a":1}',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(options).not.toHaveProperty('data');
      expect(options).not.toHaveProperty('params');
      expect(options).not.toHaveProperty('url');
    });

    it('does not treat URL instances as a config object', () => {
      expect(isAxiosRequestConfig(new URL('http://api/x'))).toBe(false);
      expect(isAxiosRequestConfig({ url: 'http://api/x' })).toBe(true);
      expect(isAxiosRequestConfig({ protocol: 'http:', host: 'api' })).toBe(
        false,
      );
    });

    /**
     * CodeRabbit review finding (`axiosRef(config)` overload detection): a
     * config with no explicit `url` (perfectly valid axios usage - a bare
     * `baseURL`, or one an interceptor fills in later - see
     * `AxiosLikeRequestConfig.url`'s own doc comment) used to fall through
     * to the "this is a URL value" branch (the old check only looked for a
     * `url` key), so `normalizeAxiosRequest({ baseURL, method })` (and, via
     * the same shared `isAxiosRequestConfig`, `axiosRef({ baseURL, method
     * })`) got treated as a raw URL and stringified to `"[object Object]"`.
     * Fixed: a missing `url` key alone no longer means "this is a URL" -
     * only an object that actually looks like a `UrlObject` (carries one of
     * its own fields, e.g. `protocol`/`hostname`/`pathname`) does, matching
     * the existing case just above; everything else with no `url` key is a
     * config, matching axios' own `Axios.prototype.request` (`typeof
     * configOrUrl === 'string'`).
     */
    it('treats a config with no url key at all as a config, not a URL value', () => {
      expect(
        isAxiosRequestConfig({ baseURL: 'http://api', method: 'get' }),
      ).toBe(true);
      expect(isAxiosRequestConfig({ transformRequest: [(d: any) => d] })).toBe(
        true,
      );
      expect(isAxiosRequestConfig({})).toBe(true);
      // A `UrlObject` (any of its own fields, not just protocol/host) is
      // still recognised as a URL value, not a config.
      expect(isAxiosRequestConfig({ pathname: '/x', search: '?a=1' })).toBe(
        false,
      );
    });

    it('normalizeAxiosRequest resolves baseURL for a config with no url key (fails without the isAxiosRequestConfig fix - previously combined baseURL with "[object Object]")', () => {
      const { url } = normalizeAxiosRequest(
        { baseURL: 'http://api.example.com/base', method: 'get' },
        undefined,
      );
      expect(url).toBe('http://api.example.com/base');
    });

    it('merges module headers, axiosRef defaults and request headers case-insensitively', () => {
      const defaults = createAxiosRefDefaults();
      defaults.headers.common['X-Common'] = 'c';
      defaults.headers.get['X-Get'] = 'g';
      defaults.headers['X-Flat'] = 'f';
      const { options } = normalizeAxiosRequest(
        'http://api/x',
        {
          method: 'GET',
          headers: { 'x-module': 'overridden', 'X-Remove': null } as any,
        },
        {
          defaults,
          instanceOptions: { headers: { 'X-Module': 'm', 'X-Remove': 'r' } },
        },
      );
      expect(options.headers).toEqual({
        'x-module': 'overridden',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': expect.stringMatching(/^nestjs-axios-undici\/\d/),
        'Accept-Encoding': 'gzip, compress, deflate, br',
        'X-Common': 'c',
        'X-Get': 'g',
        'X-Flat': 'f',
      });
    });

    it('axiosRef.defaults overrides module headers; request headers override both (request > defaults > module)', () => {
      // Precedence, matching axios' own `mergeConfig(this.defaults, config)`:
      // module options only ever *seed* `axiosRef.defaults` at setup (see
      // `createAxiosRefDefaults`); after that, `defaults` is the single
      // source of truth and always wins over the original module-level
      // value - a runtime mutation of `defaults.headers` is not shadowed by
      // the module headers it started out equal to. This replaces the PR
      // #16 rule ("module headers always win over axiosRef.defaults").
      const defaults = createAxiosRefDefaults();
      defaults.headers.common['User-Agent'] = 'from-defaults/1.0';
      const { options: withDefaultsOverride } = normalizeAxiosRequest(
        'http://api/x',
        { method: 'GET' },
        {
          defaults,
          instanceOptions: { headers: { 'User-Agent': 'my-app/1.0' } },
        },
      );
      expect(withDefaultsOverride.headers).toMatchObject({
        'User-Agent': 'from-defaults/1.0',
      });

      const { options: withRequestOverride } = normalizeAxiosRequest(
        'http://api/x',
        { method: 'GET', headers: { 'User-Agent': 'per-request/1.0' } },
        {
          defaults,
          instanceOptions: { headers: { 'User-Agent': 'my-app/1.0' } },
        },
      );
      expect(withRequestOverride.headers).toMatchObject({
        'User-Agent': 'per-request/1.0',
      });
    });

    it('module headers still seed axiosRef.defaults (createAxiosRefDefaults), so they apply when defaults is otherwise untouched', () => {
      // The real pipeline (`HttpService`'s constructor) always seeds
      // `defaults` from module options via `createAxiosRefDefaults`, so by
      // the time a request is normalised, `defaults.headers` already
      // reflects the module value - the separate `instanceOptions.headers`
      // read here is only a defence-in-depth fallback for callers that
      // build `defaults` some other way.
      const defaults = createAxiosRefDefaults({
        headers: { 'User-Agent': 'my-app/1.0' },
      });
      const { options } = normalizeAxiosRequest(
        'http://api/x',
        { method: 'GET' },
        { defaults },
      );
      expect(options.headers).toMatchObject({ 'User-Agent': 'my-app/1.0' });
    });

    it('a request header set to null/undefined removes a default, as in axios', () => {
      const defaults = createAxiosRefDefaults();
      const { options } = normalizeAxiosRequest(
        'http://api/x',
        {
          method: 'GET',
          headers: { Accept: null, 'User-Agent': undefined } as any,
        },
        { defaults },
      );
      expect(options.headers).not.toHaveProperty('Accept');
      expect(options.headers).not.toHaveProperty('User-Agent');
    });

    it('flattens axios-style method keys (common/post/...) in module headers, per method', () => {
      const { options: getOptions } = normalizeAxiosRequest(
        'http://api/x',
        { method: 'GET' },
        {
          instanceOptions: {
            headers: {
              common: { 'X-C': 'c' },
              post: { 'X-P': 'p' },
              'X-Flat': 'f',
            },
          },
        },
      );
      expect(getOptions.headers).toEqual({ 'X-C': 'c', 'X-Flat': 'f' });
      expect(getOptions.headers).not.toHaveProperty('common');
      expect(getOptions.headers).not.toHaveProperty('post');

      const { options: postOptions } = normalizeAxiosRequest(
        'http://api/x',
        { method: 'POST' },
        {
          instanceOptions: {
            headers: {
              common: { 'X-C': 'c' },
              post: { 'X-P': 'p' },
              'X-Flat': 'f',
            },
          },
        },
      );
      expect(postOptions.headers).toEqual({
        'X-C': 'c',
        'X-P': 'p',
        'X-Flat': 'f',
        'Content-Type': 'application/x-www-form-urlencoded',
      });
    });

    it('applies module baseURL/auth/params/timeout/maxRedirects from raw options', () => {
      const { url, options } = normalizeAxiosRequest(
        '/users',
        { params: { page: 2 }, headers: { Authorization: 'Bearer x' } },
        {
          instanceOptions: {
            baseURL: 'http://api/v1',
            auth: { username: 'u', password: 'p' },
            params: { key: 'k' },
            timeout: 1000,
            maxRedirects: 3,
          },
        },
      );
      expect(url).toBe('http://api/v1/users?key=k&page=2');
      expect(options.headers).toEqual({ Authorization: 'Basic dTpw' });
      expect(options.timeout).toBe(1000);
      expect(options.maxRedirections).toBe(3);
    });

    it('maps an already-cancelled CancelToken to an aborted signal', () => {
      const reason = { message: 'stop', __CANCEL__: true };
      const { options } = normalizeAxiosRequest('http://api/x', {
        cancelToken: { reason },
      });
      expect(options.signal.aborted).toBe(true);
      expect(options.signal.reason).toBe(reason);
    });

    it('combining a live signal with a cancelToken exposes a cleanup that removes its listener (PR #15 review: no listener leak)', () => {
      const controller = new AbortController();
      let listenerCount = 0;
      const originalAdd = controller.signal.addEventListener.bind(
        controller.signal,
      );
      const originalRemove = controller.signal.removeEventListener.bind(
        controller.signal,
      );
      controller.signal.addEventListener = ((...args: any[]) => {
        listenerCount++;
        return (originalAdd as any)(...args);
      }) as any;
      controller.signal.removeEventListener = ((...args: any[]) => {
        listenerCount--;
        return (originalRemove as any)(...args);
      }) as any;

      const { options } = normalizeAxiosRequest('http://api/x', {
        signal: controller.signal,
        cancelToken: { subscribe: () => undefined },
      });
      expect(listenerCount).toBe(1);
      const cleanup = (options.signal as any)[SIGNAL_CLEANUP];
      expect(typeof cleanup).toBe('function');
      cleanup();
      expect(listenerCount).toBe(0);
      // Cleanup is idempotent (no error) even called twice, and the combined
      // signal is unaffected by removing the underlying listener.
      cleanup();
      expect(options.signal.aborted).toBe(false);
    });

    it('does not expose a cleanup when the caller signal is already aborted (no listener was ever added)', () => {
      const controller = new AbortController();
      controller.abort('bye');
      const { options } = normalizeAxiosRequest('http://api/x', {
        signal: controller.signal,
        cancelToken: { subscribe: () => undefined },
      });
      expect(options.signal.aborted).toBe(true);
      expect((options.signal as any)[SIGNAL_CLEANUP]).toBeUndefined();
    });
  });

  describe('extractUrlCredentials', () => {
    it('extracts and percent-decodes credentials, stripping them from the URL', () => {
      const result = extractUrlCredentials('http://user:pa%20ss@host/path?x=1');
      expect(result).toEqual({
        username: 'user',
        password: 'pa ss',
        url: 'http://host/path?x=1',
      });
    });

    it('returns undefined when there are no credentials', () => {
      expect(extractUrlCredentials('http://host/path')).toBeUndefined();
      expect(extractUrlCredentials('not a url')).toBeUndefined();
    });
  });

  describe('URL helpers', () => {
    it('combineURLs concatenates like axios', () => {
      expect(combineURLs('http://api/v1/', '/users')).toBe(
        'http://api/v1/users',
      );
      expect(combineURLs('http://api/v1', '')).toBe('http://api/v1');
    });

    it('buildURL strips the hash and appends to an existing query', () => {
      expect(buildURL('/a?x=1#frag', { y: 2 })).toBe('/a?x=1&y=2');
      expect(buildURL('/a', {})).toBe('/a');
      expect(buildURL('/a', { k: 'v' }, { serialize: () => 'custom' })).toBe(
        '/a?custom',
      );
    });
  });

  describe('body helpers', () => {
    it('serializes JSON, URLSearchParams and binary data', () => {
      const headers: Record<string, any> = {};
      expect(serializeRequestData({ a: 1 }, headers, 'POST')).toBe('{"a":1}');
      expect(headers).toEqual({ 'Content-Type': 'application/json' });

      const formHeaders: Record<string, any> = {};
      expect(
        serializeRequestData(
          new URLSearchParams({ a: '1' }),
          formHeaders,
          'PUT',
        ),
      ).toBe('a=1');
      expect(formHeaders['Content-Type']).toBe(
        'application/x-www-form-urlencoded;charset=utf-8',
      );

      expect(serializeRequestData(new Uint8Array([1, 2]), {}, 'POST')).toEqual(
        Buffer.from([1, 2]),
      );
      expect(serializeRequestData(0, {}, 'POST')).toBeUndefined();
    });

    it('encodes global FormData as a multipart stream with a boundary', () => {
      const form = new FormData();
      form.append('k', 'v');
      const headers: Record<string, any> = {};
      const body = serializeRequestData(form, headers, 'POST');
      expect(typeof body.pipe).toBe('function');
      expect(headers['Content-Type']).toMatch(
        /^multipart\/form-data; boundary=/,
      );
    });

    it('mergeHeaders reads AxiosHeaders and raw undici header arrays', () => {
      // AxiosHeaders now preserves the casing it was set with (plan.md
      // "feat(axiosRef): make it a real axios instance"), so `toJSON()`
      // (which `mergeHeaders` reads through `forEachHeader`) reports 'X-A',
      // not a lower-cased 'x-a'.
      expect(
        mergeHeaders(new AxiosHeaders({ 'X-A': '1' }), ['X-B', '2']),
      ).toEqual({
        'X-A': '1',
        'X-B': '2',
      });
    });

    /**
     * plan.md phase 2 "fix: sanitize CRLF / non-Latin1 header values like
     * axios" (found by upstream conformance): `mergeHeaders` is the one
     * place every header source is merged for the fast, plain-object
     * dispatch path (which never builds an `AxiosHeaders` instance), so it
     * must sanitize the same way `AxiosHeaders#set` does - checked against
     * real axios 1.20.
     */
    it('mergeHeaders sanitizes CRLF/control characters out of header values', () => {
      expect(mergeHeaders({ 'X-Bad': 'a\nb' })).toEqual({ 'X-Bad': 'ab' });
      expect(mergeHeaders({ 'X-Bad': 'a\r\nb' })).toEqual({ 'X-Bad': 'ab' });
    });

    it('mergeHeaders trims space/tab, but leaves a non-Latin1 character untouched (that only happens once, at dispatch time - see sanitizeHeadersToByteString)', () => {
      // mergeHeaders is the fast path's set()-time equivalent - see the doc
      // comment on `sanitizeHeaderValue` in axios-headers.ts for why an
      // emoji/non-Latin1 character survives this pass (an axiosRef request
      // interceptor must still be able to observe/transform it first).
      expect(mergeHeaders({ 'X-Emoji': 'a\u{1F600}b' })).toEqual({
        'X-Emoji': 'a\u{1F600}b',
      });
      expect(mergeHeaders({ 'X-Trim': '\t value \t' })).toEqual({
        'X-Trim': 'value',
      });
    });

    it('mergeHeaders sanitizes every element of an array header value', () => {
      expect(mergeHeaders({ 'X-Multi': ['a\nb', 'c\rd'] })).toEqual({
        'X-Multi': ['ab', 'cd'],
      });
    });

    it('toUrlEncodedForm supports nested values', () => {
      expect(
        toUrlEncodedForm({ a: 1, b: 'x y', list: [1, 2], obj: { k: 'v' } }),
      ).toBe('a=1&b=x%20y&list%5B%5D=1&list%5B%5D=2&obj%5Bk%5D=v');
    });
  });

  describe('formSerializer', () => {
    it('the default (no formSerializer) matches the existing bracket/indexes:false behaviour', () => {
      const form = new FormData();
      buildFormData({ a: 1, list: [1, 2], obj: { k: 'v' } }, form as any);
      expect([...(form as any).keys()]).toEqual([
        'a',
        'list[]',
        'list[]',
        'obj[k]',
      ]);
    });

    it('indexes: true numbers array entries', () => {
      const pairs = buildFormSerializedPairs(
        { list: [10, 20] },
        { indexes: true },
      );
      expect(pairs).toEqual([
        ['list[0]', '10'],
        ['list[1]', '20'],
      ]);
    });

    it('indexes: null drops the brackets entirely (repeated bare key)', () => {
      const pairs = buildFormSerializedPairs(
        { list: [10, 20] },
        { indexes: null },
      );
      expect(pairs).toEqual([
        ['list', '10'],
        ['list', '20'],
      ]);
    });

    it('dots: true renders nested objects with dot notation', () => {
      const pairs = buildFormSerializedPairs(
        { obj: { a: { b: 1 } } },
        { dots: true },
      );
      expect(pairs).toEqual([['obj.a.b', '1']]);
    });

    it('metaTokens: false strips the trailing {} token from a JSON-stringified field', () => {
      const withTokens = buildFormSerializedPairs({ 'meta{}': { x: 1 } }, {});
      expect(withTokens).toEqual([['meta{}', '{"x":1}']]);
      const withoutTokens = buildFormSerializedPairs(
        { 'meta{}': { x: 1 } },
        { metaTokens: false },
      );
      expect(withoutTokens).toEqual([['meta', '{"x":1}']]);
    });

    it('a custom visitor replaces the default traversal entirely', () => {
      const pairs = buildFormSerializedPairs(
        { a: 1, b: 2 },
        {
          visitor(value, key, _path, helpers) {
            if (typeof value === 'number') {
              (this as any).append(`custom_${String(key)}`, value * 10);
              return false;
            }
            return helpers.defaultVisitor.call(
              this,
              value,
              key,
              _path,
              helpers,
            );
          },
        },
      );
      expect(pairs).toEqual([
        ['custom_a', '10'],
        ['custom_b', '20'],
      ]);
    });

    it('maxDepth throws once nesting exceeds the limit', () => {
      expect(() =>
        buildFormSerializedPairs({ a: { b: { c: 1 } } }, { maxDepth: 1 }),
      ).toThrow(/too deeply nested/);
    });

    it('rejects a circular reference', () => {
      const circular: any = { a: 1 };
      circular.self = circular;
      expect(() => buildFormSerializedPairs(circular, {})).toThrow(
        /Circular reference/,
      );
    });

    it('formDataToJSON decodes bracket-path field names back into a nested object (the reverse of buildFormData)', () => {
      const form = new FormData();
      form.append('a', '1');
      form.append('obj[b]', '2');
      form.append('list[]', '3');
      form.append('list[]', '4');
      // Matches real axios exactly (verified directly): a repeated `list[]`
      // key builds a genuine Array (`arrayToObject` only converts a
      // *non-numeric*-keyed intermediate node - see `formDataToJSON`).
      expect(formDataToJSON(form as any)).toEqual({
        a: '1',
        obj: { b: '2' },
        list: ['3', '4'],
      });
    });

    it('serializeRequestData converts a real FormData to JSON when Content-Type is explicitly application/json', () => {
      const form = new FormData();
      form.append('a', '1');
      const headers: Record<string, any> = {
        'Content-Type': 'application/json',
      };
      const body = serializeRequestData(form, headers, 'POST');
      expect(body).toBe('{"a":"1"}');
    });

    it('serializeRequestData sends a plain object as multipart when Content-Type is explicitly multipart/form-data', () => {
      const headers: Record<string, any> = {
        'Content-Type': 'multipart/form-data',
      };
      const body = serializeRequestData({ a: 1 }, headers, 'POST');
      expect(typeof body.pipe).toBe('function');
      expect(headers['Content-Type']).toMatch(
        /^multipart\/form-data; boundary=/,
      );
    });

    it('serializeRequestData honours formSerializer for a urlencoded body', () => {
      const headers: Record<string, any> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      const body = serializeRequestData({ list: [1, 2] }, headers, 'POST', {
        indexes: true,
      });
      expect(body).toBe('list%5B0%5D=1&list%5B1%5D=2');
    });

    it('buildFormRequestConfig honours a request-level formSerializer, overriding the default', () => {
      const config = buildFormRequestConfig(
        'POST',
        'http://api/x',
        { list: [1, 2] },
        { formSerializer: { indexes: true } },
        { indexes: null },
      );
      const form = config.data as any;
      expect([...form.keys()]).toEqual(['list[0]', 'list[1]']);
    });

    it('buildFormRequestConfig falls back to the default formSerializer when the request gives none', () => {
      const config = buildFormRequestConfig(
        'POST',
        'http://api/x',
        { list: [1, 2] },
        undefined,
        { indexes: null },
      );
      const form = config.data as any;
      expect([...form.keys()]).toEqual(['list', 'list']);
    });
  });

  /**
   * plan.md phase 2 "fix: remaining error-shape gaps" (found by upstream
   * conformance), item 2: "a synchronous config-normalization error (e.g. a
   * throwing paramsSerializer/params handling) must reject as an AxiosError
   * like axios" - checked against real axios 1.20 (`lib/adapters/http.js`:
   * `buildURL(...)` wrapped in its own `try`/`catch`,
   * `AxiosError.from(err, AxiosError.ERR_BAD_REQUEST, config, ...)`).
   */
  describe('a throwing paramsSerializer is wrapped as an AxiosError (ERR_BAD_REQUEST)', () => {
    const throwingSerializer = () => {
      throw new Error('boom');
    };

    it('normalizeAxiosRequest (the fast path)', () => {
      expect(() =>
        normalizeAxiosRequest('http://api/x', {
          params: { a: 1 },
          paramsSerializer: throwingSerializer,
        }),
      ).toThrow(
        expect.objectContaining({
          isAxiosError: true,
          code: 'ERR_BAD_REQUEST',
          message: 'boom',
          // axios' own `AxiosError.from`'s 6th-parameter `customProps`
          // (`lib/adapters/http.js`'s `buildURL` catch) - checked against
          // real axios 1.20's "should display error while parsing params".
          url: 'http://api/x',
          exists: true,
        }),
      );
    });

    it('serializeAxiosConfig (the axiosRef pipeline path)', () => {
      const config = buildAxiosConfig('http://api/x', {
        params: { a: 1 },
        paramsSerializer: throwingSerializer,
      });
      expect(() => serializeAxiosConfig(config)).toThrow(
        expect.objectContaining({
          isAxiosError: true,
          code: 'ERR_BAD_REQUEST',
          message: 'boom',
          url: 'http://api/x',
          exists: true,
          config,
        }),
      );
    });
  });

  /**
   * CodeRabbit review finding (`axiosRef.create(config)` drops options):
   * `auth`/`maxContentLength`/`maxBodyLength`/`timeoutErrorMessage`/
   * `decompress`/`socketPath`/`allowAbsoluteUrls`/`beforeRedirect` used to
   * be read only off module/instance options here, never off `defaults` -
   * so `axiosRef.create({ auth })` (which only ever seeds `defaults`, never
   * `instanceOptions`) sent no credentials, and a runtime `axiosRef.defaults
   * .maxContentLength = ...` assignment enforced nothing. Covers both
   * `normalizeAxiosRequest` (the fast path) and `buildAxiosConfig` (the
   * axiosRef pipeline path, what `create()`'s own requests always run
   * through once it has any interceptor/adapter/transform - and, via
   * `dispatchAxiosConfig`, what every `axiosRef`/`create()` call ultimately
   * resolves through regardless), with request-level always winning over
   * `defaults`.
   */
  describe('axiosRef.defaults / create() precedence: auth, maxContentLength, maxBodyLength, timeoutErrorMessage, decompress, socketPath, allowAbsoluteUrls, beforeRedirect', () => {
    const redirectHook = () => undefined;
    const defaultsFixture = () => ({
      ...createAxiosRefDefaults(),
      auth: { username: 'default-user', password: 'default-pass' },
      maxContentLength: 1000,
      maxBodyLength: 2000,
      timeoutErrorMessage: 'default timeout message',
      decompress: false,
      socketPath: '/var/run/default.sock',
      allowAbsoluteUrls: false,
      beforeRedirect: redirectHook,
    });

    it('normalizeAxiosRequest: defaults apply when the request sets nothing', () => {
      const { options } = normalizeAxiosRequest('http://api/x', undefined, {
        defaults: defaultsFixture() as any,
      });
      expect(options.headers.Authorization).toBe(
        `Basic ${Buffer.from('default-user:default-pass').toString('base64')}`,
      );
      expect(options.maxContentLength).toBe(1000);
      expect(options.maxBodyLength).toBe(2000);
      expect(options.timeoutErrorMessage).toBe('default timeout message');
      expect(options.decompress).toBe(false);
      expect(options.socketPath).toBe('/var/run/default.sock');
      expect(options.beforeRedirect).toBe(redirectHook);
    });

    it('normalizeAxiosRequest: a request-level value wins over defaults', () => {
      const requestRedirectHook = () => undefined;
      const { options } = normalizeAxiosRequest(
        'http://api/x',
        {
          auth: { username: 'req-user', password: 'req-pass' },
          maxContentLength: 5,
          maxBodyLength: 6,
          timeoutErrorMessage: 'request message',
          decompress: true,
          socketPath: '/var/run/request.sock',
          beforeRedirect: requestRedirectHook,
        },
        { defaults: defaultsFixture() as any },
      );
      expect(options.headers.Authorization).toBe(
        `Basic ${Buffer.from('req-user:req-pass').toString('base64')}`,
      );
      expect(options.maxContentLength).toBe(5);
      expect(options.maxBodyLength).toBe(6);
      expect(options.timeoutErrorMessage).toBe('request message');
      expect(options.decompress).toBe(true);
      expect(options.socketPath).toBe('/var/run/request.sock');
      expect(options.beforeRedirect).toBe(requestRedirectHook);
    });

    it('normalizeAxiosRequest: allowAbsoluteUrls from defaults makes an absolute url combine with baseURL instead of replacing it', () => {
      const { url } = normalizeAxiosRequest(
        'http://absolute.example/path',
        { baseURL: 'http://base.example/api' },
        { defaults: { ...defaultsFixture(), allowAbsoluteUrls: false } as any },
      );
      expect(url).toBe('http://base.example/api/http://absolute.example/path');
    });

    it('buildAxiosConfig: defaults apply when the request sets nothing', () => {
      const config = buildAxiosConfig('http://api/x', undefined, {
        defaults: defaultsFixture() as any,
      });
      expect(config.auth).toEqual({
        username: 'default-user',
        password: 'default-pass',
      });
      expect(config.maxContentLength).toBe(1000);
      expect(config.maxBodyLength).toBe(2000);
      expect(config.timeoutErrorMessage).toBe('default timeout message');
      expect(config.decompress).toBe(false);
      expect(config.socketPath).toBe('/var/run/default.sock');
      expect(config.allowAbsoluteUrls).toBe(false);
      expect(config.beforeRedirect).toBe(redirectHook);
    });

    it('buildAxiosConfig: a request-level value wins over defaults', () => {
      const requestRedirectHook = () => undefined;
      const config = buildAxiosConfig(
        'http://api/x',
        {
          auth: { username: 'req-user', password: 'req-pass' },
          maxContentLength: 5,
          maxBodyLength: 6,
          timeoutErrorMessage: 'request message',
          decompress: true,
          socketPath: '/var/run/request.sock',
          allowAbsoluteUrls: true,
          beforeRedirect: requestRedirectHook,
        },
        { defaults: defaultsFixture() as any },
      );
      expect(config.auth).toEqual({
        username: 'req-user',
        password: 'req-pass',
      });
      expect(config.maxContentLength).toBe(5);
      expect(config.maxBodyLength).toBe(6);
      expect(config.timeoutErrorMessage).toBe('request message');
      expect(config.decompress).toBe(true);
      expect(config.socketPath).toBe('/var/run/request.sock');
      expect(config.allowAbsoluteUrls).toBe(true);
      expect(config.beforeRedirect).toBe(requestRedirectHook);
    });

    it('module (instanceOptions) still applies when defaults sets nothing (unaffected by this fix)', () => {
      const { options } = normalizeAxiosRequest('http://api/x', undefined, {
        instanceOptions: {
          auth: { username: 'module-user', password: 'module-pass' },
          maxContentLength: 42,
        },
      });
      expect(options.headers.Authorization).toBe(
        `Basic ${Buffer.from('module-user:module-pass').toString('base64')}`,
      );
      expect(options.maxContentLength).toBe(42);
    });
  });
});
