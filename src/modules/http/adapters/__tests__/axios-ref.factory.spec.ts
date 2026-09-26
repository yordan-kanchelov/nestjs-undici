import { createAxiosRefDefaults } from '../axios-ref.factory';
import { LIBRARY_VERSION } from '../../../../version';

describe('createAxiosRefDefaults', () => {
  it('seeds Accept, User-Agent and Accept-Encoding into headers.common', () => {
    const defaults = createAxiosRefDefaults();
    expect(defaults.headers.common).toEqual({
      Accept: 'application/json, text/plain, */*',
      'User-Agent': `nestjs-axios-undici/${LIBRARY_VERSION}`,
      'Accept-Encoding': 'gzip, compress, deflate, br',
    });
    // per-method buckets start empty, as axios'
    expect(defaults.headers.get).toEqual({});
    expect(defaults.headers.post).toEqual({});
  });

  it('omits Accept-Encoding when the module disables decompression', () => {
    const defaults = createAxiosRefDefaults({ decompress: false });
    expect(defaults.headers.common).toEqual({
      Accept: 'application/json, text/plain, */*',
      'User-Agent': `nestjs-axios-undici/${LIBRARY_VERSION}`,
    });
  });

  it('still seeds Accept-Encoding when decompress is left unset', () => {
    const defaults = createAxiosRefDefaults({});
    expect(defaults.headers.common['Accept-Encoding']).toBe(
      'gzip, compress, deflate, br',
    );
  });

  it('carries the module baseURL through, unrelated to the header defaults', () => {
    const defaults = createAxiosRefDefaults({ baseURL: 'http://api' });
    expect(defaults.baseURL).toBe('http://api');
  });
});
