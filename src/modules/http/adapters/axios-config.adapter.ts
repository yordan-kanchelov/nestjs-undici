import type { HttpModuleOptions } from '../types';
import type { Agent } from 'http';
import type { Agent as HttpsAgent } from 'https';

/**
 * Axios configuration options that need to be mapped
 */
export interface AxiosConfigOptions {
  timeout?: number;
  maxRedirects?: number;
  maxBodyLength?: number;
  maxContentLength?: number;
  httpAgent?: Agent;
  httpsAgent?: HttpsAgent;
  proxy?: {
    protocol?: string;
    host: string;
    port: number;
    auth?: {
      username: string;
      password: string;
    };
  };
  decompress?: boolean;
  validateStatus?: (status: number) => boolean;
  baseURL?: string;
  transformRequest?: Array<(data: any, headers?: any) => any>;
  transformResponse?: Array<(data: any) => any>;
  paramsSerializer?: (params: any) => string;
  socketPath?: string;
  responseType?: 'json' | 'text' | 'stream' | 'arraybuffer' | 'blob';
  responseEncoding?: string;
  xsrfCookieName?: string;
  xsrfHeaderName?: string;
  withCredentials?: boolean;
  auth?: {
    username: string;
    password: string;
  };
}

/**
 * Maps axios configuration to undici configuration
 */
export function mapAxiosConfigToUndici(axiosConfig: AxiosConfigOptions): HttpModuleOptions {
  const undiciConfig: HttpModuleOptions = {};

  // Direct mappings
  if (axiosConfig.timeout !== undefined) {
    undiciConfig.headersTimeout = axiosConfig.timeout;
    undiciConfig.bodyTimeout = axiosConfig.timeout;
  }

  if (axiosConfig.maxRedirects !== undefined) {
    undiciConfig.maxRedirections = axiosConfig.maxRedirects;
  }

  if (axiosConfig.maxBodyLength !== undefined || axiosConfig.maxContentLength !== undefined) {
    // Undici doesn't have direct equivalents, but we can use bodyTimeout as a safeguard
    console.warn('maxBodyLength/maxContentLength are not directly supported in undici. Consider using bodyTimeout.');
  }

  // Agent configuration
  if (axiosConfig.httpAgent || axiosConfig.httpsAgent) {
    // Extract keepAlive and other options from agents
    const agent = axiosConfig.httpAgent || axiosConfig.httpsAgent;
    if (agent && 'keepAlive' in agent) {
      // Note: Undici has different connection pooling mechanisms
      console.warn('httpAgent/httpsAgent configuration detected. Undici uses different connection pooling. Consider using Dispatcher options.');
    }
  }

  // Proxy configuration
  if (axiosConfig.proxy) {
    console.warn('Proxy configuration is not directly supported in undici. Consider using ProxyAgent from undici.');
  }

  // Decompress
  if (axiosConfig.decompress !== undefined) {
    // Undici handles decompression automatically
    console.info('decompress option is handled automatically by undici');
  }

  // Validate status - this is handled at the interceptor level
  if (axiosConfig.validateStatus) {
    undiciConfig.validateStatus = axiosConfig.validateStatus;
  }

  // Socket path
  if (axiosConfig.socketPath) {
    // Undici supports unix sockets differently
    console.warn('socketPath requires special handling in undici. Use unix:// protocol in URL.');
  }

  // Auth
  if (axiosConfig.auth) {
    // Convert to basic auth header
    const basicAuth = Buffer.from(`${axiosConfig.auth.username}:${axiosConfig.auth.password}`).toString('base64');
    undiciConfig.headers = {
      ...undiciConfig.headers,
      'Authorization': `Basic ${basicAuth}`,
    };
  }

  // With credentials
  if (axiosConfig.withCredentials) {
    // Undici handles cookies differently
    console.warn('withCredentials is not directly supported. Consider using cookie jar with undici.');
  }

  // Store axios-specific options for later processing
  const axiosSpecificOptions: any = {};
  
  if (axiosConfig.baseURL) {
    axiosSpecificOptions.baseURL = axiosConfig.baseURL;
  }
  
  if (axiosConfig.transformRequest) {
    axiosSpecificOptions.transformRequest = axiosConfig.transformRequest;
  }
  
  if (axiosConfig.transformResponse) {
    axiosSpecificOptions.transformResponse = axiosConfig.transformResponse;
  }
  
  if (axiosConfig.paramsSerializer) {
    axiosSpecificOptions.paramsSerializer = axiosConfig.paramsSerializer;
  }
  
  if (axiosConfig.responseType) {
    axiosSpecificOptions.responseType = axiosConfig.responseType;
  }
  
  if (axiosConfig.responseEncoding) {
    axiosSpecificOptions.responseEncoding = axiosConfig.responseEncoding;
  }

  // Store axios-specific options in metadata
  if (Object.keys(axiosSpecificOptions).length > 0) {
    (undiciConfig as any).__axiosCompat = axiosSpecificOptions;
  }

  return undiciConfig;
}

/**
 * Creates a warning message for unsupported axios features
 */
export function getAxiosCompatibilityWarnings(axiosConfig: AxiosConfigOptions): string[] {
  const warnings: string[] = [];

  if (axiosConfig.httpAgent || axiosConfig.httpsAgent) {
    warnings.push('httpAgent/httpsAgent: Use undici Dispatcher options for connection pooling');
  }

  if (axiosConfig.proxy) {
    warnings.push('proxy: Use ProxyAgent from undici for proxy support');
  }

  if (axiosConfig.maxBodyLength || axiosConfig.maxContentLength) {
    warnings.push('maxBodyLength/maxContentLength: Not directly supported, consider using timeouts');
  }

  if (axiosConfig.socketPath) {
    warnings.push('socketPath: Use unix:// protocol in URL for unix sockets');
  }

  if (axiosConfig.withCredentials) {
    warnings.push('withCredentials: Cookie handling requires additional configuration');
  }

  if (axiosConfig.xsrfCookieName || axiosConfig.xsrfHeaderName) {
    warnings.push('XSRF protection: Must be implemented manually with interceptors');
  }

  return warnings;
}