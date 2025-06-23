/**
 * Axios-compatible header types
 * These types match axios header definitions for compatibility
 */

/**
 * Valid axios header value types
 */
export type AxiosHeaderValue = string | string[] | number | boolean | null | undefined;

/**
 * Common HTTP request headers with proper typing
 */
export interface CommonRequestHeaders {
  'Accept'?: AxiosHeaderValue;
  'Accept-Encoding'?: AxiosHeaderValue;
  'Accept-Language'?: AxiosHeaderValue;
  'Authorization'?: AxiosHeaderValue;
  'Cache-Control'?: AxiosHeaderValue;
  'Content-Encoding'?: AxiosHeaderValue;
  'Content-Length'?: AxiosHeaderValue;
  'Content-Type'?: AxiosHeaderValue;
  'Cookie'?: AxiosHeaderValue;
  'Host'?: AxiosHeaderValue;
  'Origin'?: AxiosHeaderValue;
  'Referer'?: AxiosHeaderValue;
  'User-Agent'?: AxiosHeaderValue;
  'X-Requested-With'?: AxiosHeaderValue;
}

/**
 * Common HTTP response headers
 */
export interface CommonResponseHeaders {
  'Cache-Control'?: AxiosHeaderValue;
  'Content-Encoding'?: AxiosHeaderValue;
  'Content-Length'?: AxiosHeaderValue;
  'Content-Type'?: AxiosHeaderValue;
  'Date'?: AxiosHeaderValue;
  'Etag'?: AxiosHeaderValue;
  'Expires'?: AxiosHeaderValue;
  'Last-Modified'?: AxiosHeaderValue;
  'Location'?: AxiosHeaderValue;
  'Server'?: AxiosHeaderValue;
  'Set-Cookie'?: AxiosHeaderValue;
  'Vary'?: AxiosHeaderValue;
}

/**
 * Raw axios headers interface - allows any string key with AxiosHeaderValue
 */
export interface RawAxiosHeaders {
  [key: string]: AxiosHeaderValue;
}

/**
 * Method-specific headers
 */
export interface MethodHeaders {
  common?: RawAxiosHeaders;
  delete?: RawAxiosHeaders;
  get?: RawAxiosHeaders;
  head?: RawAxiosHeaders;
  post?: RawAxiosHeaders;
  put?: RawAxiosHeaders;
  patch?: RawAxiosHeaders;
  options?: RawAxiosHeaders;
  trace?: RawAxiosHeaders;
  connect?: RawAxiosHeaders;
}

/**
 * Combined axios request headers type
 * Supports common headers with proper typing and any custom headers
 */
export type AxiosRequestHeaders = Partial<RawAxiosHeaders & CommonRequestHeaders>;

/**
 * AxiosHeaders class for advanced header manipulation
 * Provides methods similar to the Headers API but with axios compatibility
 * Supports bracket notation for header access/assignment
 */
export class AxiosHeaders {
  private headers: Map<string, AxiosHeaderValue>;

  constructor(headers?: RawAxiosHeaders | AxiosHeaders) {
    this.headers = new Map();
    
    if (headers) {
      if (headers instanceof AxiosHeaders) {
        headers.forEach((value, key) => {
          this.set(key, value);
        });
      } else {
        Object.entries(headers).forEach(([key, value]) => {
          this.set(key, value);
        });
      }
    }

    // Return a Proxy to support bracket notation
    return new Proxy(this, {
      get(target, prop: string | symbol) {
        // If it's a method or property of AxiosHeaders, return it
        if (prop in target) {
          const value = (target as any)[prop];
          if (typeof value === 'function') {
            return value.bind(target);
          }
          return value;
        }
        
        // Otherwise, treat it as a header key
        if (typeof prop === 'string') {
          return target.get(prop);
        }
        
        return undefined;
      },
      
      set(target, prop: string | symbol, value: AxiosHeaderValue) {
        // Don't allow setting methods or internal properties
        if (prop in target) {
          return false;
        }
        
        // Set as header
        if (typeof prop === 'string') {
          target.set(prop, value);
          return true;
        }
        
        return false;
      },
      
      has(target, prop: string | symbol) {
        // Check if it's a property/method first
        if (prop in target) {
          return true;
        }
        
        // Otherwise check headers
        if (typeof prop === 'string') {
          return target.has(prop);
        }
        
        return false;
      },
      
      deleteProperty(target, prop: string | symbol) {
        // Don't allow deleting methods or internal properties
        if (prop in target) {
          return false;
        }
        
        // Delete header
        if (typeof prop === 'string') {
          return target.delete(prop);
        }
        
        return false;
      },
      
      ownKeys(target) {
        // Return both class properties and header keys
        const classKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(target))
          .concat(Object.getOwnPropertyNames(target));
        const headerKeys = Array.from(target.headers.keys());
        return [...new Set([...classKeys, ...headerKeys])];
      },
      
      getOwnPropertyDescriptor(target, prop: string | symbol) {
        // For class properties/methods
        if (prop in target) {
          return Object.getOwnPropertyDescriptor(target, prop) ||
                 Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), prop);
        }
        
        // For headers
        if (typeof prop === 'string' && target.has(prop)) {
          return {
            configurable: true,
            enumerable: true,
            value: target.get(prop)
          };
        }
        
        return undefined;
      }
    });
  }

  /**
   * Set a header value
   */
  set(key: string, value: AxiosHeaderValue): this {
    if (value !== undefined) {
      this.headers.set(key.toLowerCase(), value);
    }
    return this;
  }

  /**
   * Get a header value
   */
  get(key: string): AxiosHeaderValue {
    return this.headers.get(key.toLowerCase());
  }

  /**
   * Check if header exists
   */
  has(key: string): boolean {
    return this.headers.has(key.toLowerCase());
  }

  /**
   * Delete a header
   */
  delete(key: string): boolean {
    return this.headers.delete(key.toLowerCase());
  }

  /**
   * Clear all headers
   */
  clear(): void {
    this.headers.clear();
  }

  /**
   * Iterate over headers
   */
  forEach(callback: (value: AxiosHeaderValue, key: string, headers: AxiosHeaders) => void): void {
    this.headers.forEach((value, key) => {
      callback(value, key, this);
    });
  }

  /**
   * Get all headers as a plain object
   */
  toJSON(): RawAxiosHeaders {
    const result: RawAxiosHeaders = {};
    this.headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  /**
   * Create AxiosHeaders from various input types
   * @param thing - Input to convert to AxiosHeaders
   * @returns AxiosHeaders instance with proxy support
   */
  static from(thing?: AxiosHeaders | RawAxiosHeaders | string): AxiosHeaders {
    if (thing instanceof AxiosHeaders) {
      return thing;
    }
    
    const headers = new AxiosHeaders();
    
    if (typeof thing === 'string') {
      // Parse raw headers string (e.g., from HTTP response)
      thing.split('\n').forEach(line => {
        const [key, ...valueParts] = line.split(':');
        if (key && valueParts.length) {
          headers.set(key.trim(), valueParts.join(':').trim());
        }
      });
    } else if (thing && typeof thing === 'object') {
      Object.entries(thing).forEach(([key, value]) => {
        headers.set(key, value);
      });
    }
    
    return headers;
  }

  /**
   * Concatenate headers
   * @param sources - Headers to concatenate
   * @returns New AxiosHeaders instance with all headers
   */
  static concat(...sources: Array<AxiosHeaders | RawAxiosHeaders | undefined>): AxiosHeaders {
    const result = new AxiosHeaders();
    
    sources.forEach(source => {
      if (source) {
        const headers = AxiosHeaders.from(source);
        headers.forEach((value, key) => {
          result.set(key, value);
        });
      }
    });
    
    return result;
  }

  /**
   * Normalize header name
   */
  static normalizeHeader(header: string): string {
    return header.toLowerCase();
  }

  /**
   * Iterator support
   */
  [Symbol.iterator](): Iterator<[string, AxiosHeaderValue]> {
    return this.headers.entries();
  }

  /**
   * Support for Object.entries()
   */
  entries(): IterableIterator<[string, AxiosHeaderValue]> {
    return this.headers.entries();
  }

  /**
   * Get all header keys
   */
  keys(): IterableIterator<string> {
    return this.headers.keys();
  }

  /**
   * Get all header values
   */
  values(): IterableIterator<AxiosHeaderValue> {
    return this.headers.values();
  }
}