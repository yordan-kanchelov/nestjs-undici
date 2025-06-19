import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { randomStringGenerator } from '@nestjs/common/utils/random-string-generator.util';

import { HttpService } from './services/http.service';

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
  providers: [HttpService],
  exports: [HttpService],
})
export class HttpModule {
  static register(config: HttpModuleOptions): DynamicModule {
    const { interceptors = [], ...undiciOptions } = config;
    
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
          useValue: { ...config, interceptors: functionInterceptors },
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
            // For async registration, we only support function interceptors
            // Class interceptors would need to be added via extraProviders
            return config.interceptors?.filter(i => typeof i === 'function') || [];
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