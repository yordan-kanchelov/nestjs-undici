import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { randomStringGenerator } from '@nestjs/common/utils/random-string-generator.util';
import { map } from 'rxjs/operators';

import { HttpService } from './services/http.service';
import { axiosResponseAdapter } from './interceptors/axios-response-adapter.interceptor';
import { mapAxiosConfigToUndici, getAxiosCompatibilityWarnings } from './adapters/axios-config.adapter';

import {
  UNDICI_INSTANCE_TOKEN,
  HTTP_MODULE_ID,
  HTTP_MODULE_OPTIONS,
} from './constants/http.constants';

import type {
  HttpModuleAsyncOptions,
  HttpModuleOptionsFactory,
  HttpInterceptor,
  HttpInterceptorFunction,
} from './interfaces';
import type { HttpModuleOptions, UndiciRequestOptionsType } from './types';

const INTERCEPTOR_METADATA = 'HTTP_INTERCEPTORS_METADATA';
const HTTP_SERVICE_INTERCEPTORS = 'HTTP_SERVICE_INTERCEPTORS';

@Module({
  providers: [
    HttpService,
    {
      provide: UNDICI_INSTANCE_TOKEN,
      useValue: {}, // Default empty options
    },
    {
      provide: HTTP_MODULE_OPTIONS,
      useValue: {}, // Default empty module options
    },
  ],
  exports: [HttpService],
})
export class HttpModule {
  static register(config: HttpModuleOptions & any = {}): DynamicModule {
    // Check if this looks like axios configuration
    const hasAxiosOptions = !!(
      config.httpAgent || 
      config.httpsAgent || 
      config.maxRedirects !== undefined ||
      config.auth ||
      config.baseURL ||
      config.validateStatus ||
      config.transformRequest ||
      config.transformResponse ||
      config.withCredentials ||
      config.xsrfCookieName ||
      config.xsrfHeaderName ||
      config.proxy ||
      config.maxBodyLength !== undefined ||
      config.maxContentLength !== undefined
    );

    let processedConfig = config;
    
    // If axios-style options detected, map them to undici options
    if (hasAxiosOptions) {
      const warnings = getAxiosCompatibilityWarnings(config);
      if (warnings.length > 0) {
        console.warn('[nestjs-undici-interceptors] Axios compatibility warnings:');
        warnings.forEach(warning => console.warn(`  - ${warning}`));
      }
      
      // Map axios config to undici config
      const mappedConfig = mapAxiosConfigToUndici(config);
      
      // Convert axios transformRequest/transformResponse to interceptors
      const additionalInterceptors: HttpInterceptorFunction[] = [];
      
      if (config.transformRequest) {
        const transforms = Array.isArray(config.transformRequest) ? config.transformRequest : [config.transformRequest];
        transforms.forEach(transform => {
          additionalInterceptors.push((request, next) => {
            // Apply transform to request data
            if (request.options.body) {
              const transformedData = transform(request.options.body, request.options.headers);
              return next.handle({
                ...request,
                options: {
                  ...request.options,
                  body: transformedData,
                },
              });
            }
            return next.handle(request);
          });
        });
      }
      
      if (config.transformResponse) {
        const transforms = Array.isArray(config.transformResponse) ? config.transformResponse : [config.transformResponse];
        transforms.forEach(transform => {
          additionalInterceptors.push((request, next) => {
            return next.handle(request).pipe(
              map(response => {
                if (response && typeof response === 'object' && 'data' in response) {
                  const transformedData = transform(response.data);
                  return {
                    ...response,
                    data: transformedData,
                  };
                }
                return response;
              })
            );
          });
        });
      }
      
      // Merge with original config, preserving any undici-specific options
      processedConfig = {
        ...mappedConfig,
        ...config,
        // Ensure interceptors are preserved and include transform interceptors
        interceptors: [
          ...(mappedConfig.interceptors || []), // Include interceptors from mapping (e.g., size limit)
          ...additionalInterceptors, // Include transform interceptors
          ...(config.interceptors || []) // Include user-provided interceptors
        ],
      };
    }
    
    // Extract interceptors - axios response adapter will be added in the service
    const interceptors = processedConfig.interceptors || [];
    
    const { interceptors: _, ...undiciOptions } = processedConfig;
    
    // Separate function and class interceptors
    const functionInterceptors: HttpInterceptorFunction[] = [];
    const classInterceptors: Type<HttpInterceptor>[] = [];
    
    interceptors.forEach(interceptor => {
      if (typeof interceptor === 'function') {
        // Check if it's a class constructor by looking for class syntax markers
        // Classes have toString() that starts with 'class' or have constructor in prototype
        const isClass = interceptor.toString().startsWith('class') || 
                       (interceptor.prototype && 
                        interceptor.prototype.constructor === interceptor &&
                        Object.getOwnPropertyNames(interceptor.prototype).includes('intercept'));
        
        if (isClass) {
          classInterceptors.push(interceptor as Type<HttpInterceptor>);
        } else {
          functionInterceptors.push(interceptor as HttpInterceptorFunction);
        }
      }
    });
    
    // Create providers for class interceptors
    const interceptorProviders = classInterceptors.map(InterceptorClass => ({
      provide: InterceptorClass,
      useClass: InterceptorClass,
    }));
    
    return {
      module: HttpModule,
      providers: [
        {
          provide: UNDICI_INSTANCE_TOKEN,
          useValue: undiciOptions,
        },
        {
          provide: HTTP_MODULE_OPTIONS,
          useValue: { ...processedConfig, interceptors: functionInterceptors },
        },
        {
          provide: HTTP_MODULE_ID,
          useValue: randomStringGenerator(),
        },
        ...interceptorProviders,
        {
          provide: HTTP_SERVICE_INTERCEPTORS,
          useFactory: (...args: any[]) => {
            // The injected arguments are the instantiated interceptors
            const interceptorInstances = args;
            return [...functionInterceptors, ...interceptorInstances];
          },
          inject: classInterceptors,
        },
        {
          provide: HttpService,
          useFactory: (options: UndiciRequestOptionsType, moduleOptions: HttpModuleOptions, interceptors: Array<HttpInterceptor | HttpInterceptorFunction>) => {
            const service = new HttpService(options, moduleOptions);
            service.setInterceptors(interceptors);
            return service;
          },
          inject: [UNDICI_INSTANCE_TOKEN, HTTP_MODULE_OPTIONS, HTTP_SERVICE_INTERCEPTORS],
        },
      ],
      exports: [HttpService],
    };
  }

  static registerAsync(options: HttpModuleAsyncOptions): DynamicModule {
    return {
      module: HttpModule,
      imports: options.imports,
      providers: [
        ...this.createAsyncProviders(options),
        {
          provide: UNDICI_INSTANCE_TOKEN,
          useFactory: (config: HttpModuleOptions) => {
            const { interceptors, ...undiciOptions } = config;
            return undiciOptions;
          },
          inject: [HTTP_MODULE_OPTIONS],
        },
        {
          provide: HTTP_MODULE_ID,
          useValue: randomStringGenerator(),
        },
        {
          provide: HTTP_SERVICE_INTERCEPTORS,
          useFactory: (config: HttpModuleOptions) => {
            // Get base interceptors - axios response adapter is added in the service
            const baseInterceptors = config.interceptors?.filter(i => typeof i === 'function') || [];
            return baseInterceptors;
          },
          inject: [HTTP_MODULE_OPTIONS],
        },
        {
          provide: HttpService,
          useFactory: (options: UndiciRequestOptionsType, moduleOptions: HttpModuleOptions, interceptors: Array<HttpInterceptor | HttpInterceptorFunction>) => {
            const service = new HttpService(options, moduleOptions);
            service.setInterceptors(interceptors);
            return service;
          },
          inject: [UNDICI_INSTANCE_TOKEN, HTTP_MODULE_OPTIONS, HTTP_SERVICE_INTERCEPTORS],
        },
        ...(options.extraProviders || []),
      ],
      exports: [HttpService],
    };
  }

  private static createAsyncProviders(
    options: HttpModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: options.useClass,
        useClass: options.useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: HttpModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: HTTP_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }
    return {
      provide: HTTP_MODULE_OPTIONS,
      useFactory: async (optionsFactory: HttpModuleOptionsFactory) =>
        optionsFactory.createHttpOptions(),
      inject: [options.useExisting || options.useClass],
    };
  }

}