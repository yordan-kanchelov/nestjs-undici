import { AxiosHeaders } from '../axios-headers.interface';

describe('AxiosHeaders', () => {
  describe('constructor', () => {
    it('should create empty headers', () => {
      const headers = new AxiosHeaders();
      expect(headers.toJSON()).toEqual({});
    });

    it('should initialize from plain object', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token'
      });
      
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('authorization')).toBe('Bearer token');
    });

    it('should initialize from another AxiosHeaders instance', () => {
      const original = new AxiosHeaders({
        'Content-Type': 'application/json'
      });
      
      const copy = new AxiosHeaders(original);
      expect(copy.get('content-type')).toBe('application/json');
    });
  });

  describe('set', () => {
    it('should set header values', () => {
      const headers = new AxiosHeaders();
      headers.set('Content-Type', 'application/json');
      
      expect(headers.get('content-type')).toBe('application/json');
    });

    it('should normalize header names to lowercase', () => {
      const headers = new AxiosHeaders();
      headers.set('Content-Type', 'application/json');
      headers.set('CONTENT-TYPE', 'text/plain');
      
      expect(headers.get('content-type')).toBe('text/plain');
    });

    it('should handle different value types', () => {
      const headers = new AxiosHeaders();
      headers.set('string', 'value');
      headers.set('number', 123);
      headers.set('boolean', true);
      headers.set('null', null);
      
      expect(headers.get('string')).toBe('value');
      expect(headers.get('number')).toBe(123);
      expect(headers.get('boolean')).toBe(true);
      expect(headers.get('null')).toBe(null);
    });

    it('should not set undefined values', () => {
      const headers = new AxiosHeaders();
      headers.set('test', undefined);
      
      expect(headers.has('test')).toBe(false);
    });

    it('should support method chaining', () => {
      const headers = new AxiosHeaders();
      const result = headers
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer token');
      
      expect(result).toBe(headers);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('authorization')).toBe('Bearer token');
    });
  });

  describe('get', () => {
    it('should get header values', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json'
      });
      
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('CONTENT-TYPE')).toBe('application/json');
    });

    it('should return undefined for non-existent headers', () => {
      const headers = new AxiosHeaders();
      expect(headers.get('non-existent')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should check header existence', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json'
      });
      
      expect(headers.has('Content-Type')).toBe(true);
      expect(headers.has('content-type')).toBe(true);
      expect(headers.has('Authorization')).toBe(false);
    });
  });

  describe('delete', () => {
    it('should delete headers', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token'
      });
      
      const deleted = headers.delete('Content-Type');
      
      expect(deleted).toBe(true);
      expect(headers.has('content-type')).toBe(false);
      expect(headers.has('authorization')).toBe(true);
    });

    it('should return false when deleting non-existent header', () => {
      const headers = new AxiosHeaders();
      expect(headers.delete('non-existent')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all headers', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token'
      });
      
      headers.clear();
      
      expect(headers.toJSON()).toEqual({});
    });
  });

  describe('forEach', () => {
    it('should iterate over headers', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token'
      });
      
      const collected: Array<[string, any]> = [];
      headers.forEach((value, key) => {
        collected.push([key, value]);
      });
      
      expect(collected).toContainEqual(['content-type', 'application/json']);
      expect(collected).toContainEqual(['authorization', 'Bearer token']);
    });
  });

  describe('toJSON', () => {
    it('should convert to plain object', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token'
      });
      
      const json = headers.toJSON();
      
      expect(json).toEqual({
        'content-type': 'application/json',
        'authorization': 'Bearer token'
      });
    });
  });

  describe('from', () => {
    it('should create from AxiosHeaders instance', () => {
      const original = new AxiosHeaders({
        'Content-Type': 'application/json'
      });
      
      const headers = AxiosHeaders.from(original);
      
      expect(headers).toBe(original);
    });

    it('should create from plain object', () => {
      const headers = AxiosHeaders.from({
        'Content-Type': 'application/json'
      });
      
      expect(headers.get('content-type')).toBe('application/json');
    });

    it('should parse raw headers string', () => {
      const rawHeaders = 'Content-Type: application/json\nAuthorization: Bearer token\nX-Custom: value';
      const headers = AxiosHeaders.from(rawHeaders);
      
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('authorization')).toBe('Bearer token');
      expect(headers.get('x-custom')).toBe('value');
    });

    it('should handle headers with colons in values', () => {
      const rawHeaders = 'Timestamp: 2023-12-01T10:00:00Z';
      const headers = AxiosHeaders.from(rawHeaders);
      
      expect(headers.get('timestamp')).toBe('2023-12-01T10:00:00Z');
    });

    it('should return empty headers for undefined input', () => {
      const headers = AxiosHeaders.from(undefined);
      expect(headers.toJSON()).toEqual({});
    });
  });

  describe('concat', () => {
    it('should concatenate multiple header sources', () => {
      const headers1 = new AxiosHeaders({
        'Content-Type': 'application/json'
      });
      
      const headers2 = {
        'Authorization': 'Bearer token'
      };
      
      const headers3 = new AxiosHeaders({
        'X-Custom': 'value',
        'Content-Type': 'text/plain' // Should override
      });
      
      const result = AxiosHeaders.concat(headers1, headers2, headers3);
      
      expect(result.get('content-type')).toBe('text/plain');
      expect(result.get('authorization')).toBe('Bearer token');
      expect(result.get('x-custom')).toBe('value');
    });

    it('should skip undefined sources', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json'
      });
      
      const result = AxiosHeaders.concat(undefined, headers, undefined);
      
      expect(result.get('content-type')).toBe('application/json');
    });
  });

  describe('normalizeHeader', () => {
    it('should normalize header names', () => {
      expect(AxiosHeaders.normalizeHeader('Content-Type')).toBe('content-type');
      expect(AxiosHeaders.normalizeHeader('AUTHORIZATION')).toBe('authorization');
      expect(AxiosHeaders.normalizeHeader('X-Custom-Header')).toBe('x-custom-header');
    });
  });

  describe('iterator support', () => {
    it('should support for...of iteration', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token'
      });
      
      const collected: Array<[string, any]> = [];
      for (const [key, value] of headers) {
        collected.push([key, value]);
      }
      
      expect(collected).toContainEqual(['content-type', 'application/json']);
      expect(collected).toContainEqual(['authorization', 'Bearer token']);
    });

    it('should support entries()', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json'
      });
      
      const entries = Array.from(headers.entries());
      expect(entries).toContainEqual(['content-type', 'application/json']);
    });

    it('should support keys()', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token'
      });
      
      const keys = Array.from(headers.keys());
      expect(keys).toContain('content-type');
      expect(keys).toContain('authorization');
    });

    it('should support values()', () => {
      const headers = new AxiosHeaders({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token'
      });
      
      const values = Array.from(headers.values());
      expect(values).toContain('application/json');
      expect(values).toContain('Bearer token');
    });
  });

  describe('OpenTelemetry compatibility', () => {
    it('should work with OpenTelemetry propagation pattern', () => {
      const headers = new AxiosHeaders();
      
      // Simulate OpenTelemetry trace headers
      const traceHeaders = {
        'traceparent': '00-123456789abcdef-fedcba987654321-01',
        'tracestate': 'vendor=value'
      };
      
      // The typical OpenTelemetry pattern
      Object.entries(traceHeaders).forEach(([key, value]) => {
        headers.set(key, value);
      });
      
      expect(headers.get('traceparent')).toBe('00-123456789abcdef-fedcba987654321-01');
      expect(headers.get('tracestate')).toBe('vendor=value');
    });
  });
});