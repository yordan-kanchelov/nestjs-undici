import type { HttpModuleOptions } from '../types';
import type { Agent } from 'http';
import type { Agent as HttpsAgent } from 'https';
import { ProxyAgent } from 'undici';
import { CookieAgent } from 'http-cookie-agent/undici';
import { CookieJar } from 'tough-cookie';
import type { HttpInterceptorFunction } from '../interfaces';
import { createSizeLimitInterceptor } from '../interceptors/size-limit.interceptor';

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
  const interceptors: HttpInterceptorFunction[] = [];

  // Direct mappings
  if (axiosConfig.timeout !== undefined) {
    undiciConfig.headersTimeout = axiosConfig.timeout;
    undiciConfig.bodyTimeout = axiosConfig.timeout;
  }

  if (axiosConfig.maxRedirects !== undefined) {
    undiciConfig.maxRedirections = axiosConfig.maxRedirects;
  }

  // Handle size limits with interceptor
  if (axiosConfig.maxBodyLength !== undefined || axiosConfig.maxContentLength !== undefined) {
    // Create size limit interceptor
    interceptors.push(createSizeLimitInterceptor({
      maxBodyLength: axiosConfig.maxBodyLength,
      maxContentLength: axiosConfig.maxContentLength,
    }));
    
    // Also store in options for the response adapter
    (undiciConfig as any).maxBodyLength = axiosConfig.maxBodyLength;
    (undiciConfig as any).maxContentLength = axiosConfig.maxContentLength;
  }

  // Handle httpAgent/httpsAgent - map to Undici Agent options
  if (axiosConfig.httpAgent || axiosConfig.httpsAgent) {
    const agent = axiosConfig.httpAgent || axiosConfig.httpsAgent;
    
    // Extract relevant options from Node.js Agent
    if (agent && typeof agent === 'object') {
      const agentOptions = agent as any;
      
      // Map keepAlive settings
      if ('keepAlive' in agentOptions) {
        undiciConfig.pipelining = agentOptions.keepAlive ? 1 : 0;
      }
      
      // Map timeout settings
      if ('timeout' in agentOptions && !axiosConfig.timeout) {
        undiciConfig.headersTimeout = agentOptions.timeout;
        undiciConfig.bodyTimeout = agentOptions.timeout;
      }
      
      // Map maxSockets to connection limits
      if ('maxSockets' in agentOptions) {
        // Store for later use when creating dispatcher
        (undiciConfig as any).__agentOptions = {
          connections: agentOptions.maxSockets,
        };
      }
    }
  }

  // Handle proxy configuration
  if (axiosConfig.proxy) {
    // Create ProxyAgent
    let proxyUrl = '';
    if (typeof axiosConfig.proxy === 'object') {
      const protocol = axiosConfig.proxy.protocol || 'http:';
      proxyUrl = `${protocol}//${axiosConfig.proxy.host}:${axiosConfig.proxy.port}`;
    }
    
    const proxyOptions: any = {
      uri: proxyUrl,
    };
    
    // Add authentication if provided
    if (axiosConfig.proxy.auth) {
      const proxyAuth = Buffer.from(
        `${axiosConfig.proxy.auth.username}:${axiosConfig.proxy.auth.password}`
      ).toString('base64');
      proxyOptions.token = `Basic ${proxyAuth}`;
    }
    
    // Store proxy configuration for later dispatcher creation
    (undiciConfig as any).__proxyAgent = proxyOptions;
  }

  // Handle withCredentials - cookie support
  if (axiosConfig.withCredentials) {
    // Store flag for later cookie agent creation
    (undiciConfig as any).__withCredentials = true;
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
    // Store for URL transformation
    (undiciConfig as any).__socketPath = axiosConfig.socketPath;
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

  // Add interceptors if any were created
  if (interceptors.length > 0) {
    undiciConfig.interceptors = interceptors;
  }

  return undiciConfig;
}

/**
 * Creates a warning message for unsupported axios features
 */
export function getAxiosCompatibilityWarnings(axiosConfig: AxiosConfigOptions): string[] {
  const warnings: string[] = [];

  // These are now supported but with different implementation
  // Keeping warnings for features that still need manual handling
  
  if (axiosConfig.socketPath) {
    warnings.push('socketPath: Unix sockets require using unix:// protocol in URL');
  }

  if (axiosConfig.xsrfCookieName || axiosConfig.xsrfHeaderName) {
    warnings.push('XSRF protection: Must be implemented manually with interceptors');
  }

  return warnings;
}