import { DynamicModule, Logger, Module, Provider, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { HttpService } from './services/http.service';
import {
  mapAxiosConfigToUndici,
  getAxiosCompatibilityWarnings,
} from './adapters/axios-config.adapter';

import {
  UNDICI_INSTANCE_TOKEN,
  HTTP_MODULE_OPTIONS,
} from './constants/http.constants';

import type {
  HttpModuleAsyncOptions,
  HttpModuleOptionsFactory,
  HttpInterceptor,
  HttpInterceptorFunction,
} from './interfaces';
import type { HttpModuleOptions } from './types';
import type {
  ResolvedHttpModuleOptions,
  ResolvedUndiciRequestOptions,
} from './internal/resolved-config';

const INTERCEPTOR_METADATA = 'HTTP_INTERCEPTORS_METADATA';
const HTTP_SERVICE_INTERCEPTORS = 'HTTP_SERVICE_INTERCEPTORS';

type InterceptorOption =
  Type<HttpInterceptor> | HttpInterceptor | HttpInterceptorFunction;

function isInterceptorClass(
  interceptor: InterceptorOption,
): interceptor is Type<HttpInterceptor> {
  return (
    typeof interceptor === 'function' &&
    (interceptor.toString().startsWith('class') ||
      (interceptor.prototype &&
        interceptor.prototype.constructor === interceptor &&
        Object.getOwnPropertyNames(interceptor.prototype).includes(
          'intercept',
        )))
  );
}

function isInterceptorInstance(
  interceptor: InterceptorOption,
): interceptor is HttpInterceptor {
  return (
    typeof interceptor === 'object' &&
    interceptor !== null &&
    typeof (interceptor as HttpInterceptor).intercept === 'function'
  );
}

@Module({
  providers: [
    HttpService,
    {
      provide: UNDICI_INSTANCE_TOKEN,
      // A factory, not `useValue: {}` (**breaking**: fixes a real bug, not
      // just a style choice - plan.md phase 3 "Resource cleanup": "The
      // static module's default options become a factory"). `@Module()`'s
      // provider metadata is evaluated once, when this class is declared,
      // so a literal `{}` here would be the exact same object reference
      // handed to every app that imports the static `HttpModule` (as
      // opposed to `HttpModule.register({})`, which builds a fresh object
      // per call): `HttpService#setDispatcher()` mutating `instanceOptions`
      // in one app would then leak into every other app's `HttpService`
      // that also imported the bare `HttpModule` -
      // `plan/reports/package-quality.md`'s "A static `HttpModule` import
      // shares one `{}` options object across apps". A factory runs once
      // per module instantiation instead, so each app's `HttpService` gets
      // its own options object.
      useFactory: () => ({}),
    },
    {
      provide: HTTP_MODULE_OPTIONS,
      useFactory: () => ({}), // Default empty module options, per-instantiation (see above)
    },
  ],
  exports: [HttpService],
})
export class HttpModule {
  private static readonly logger = new Logger(HttpModule.name);
  static register(config: HttpModuleOptions = {}): DynamicModule {
    const processedConfig: ResolvedHttpModuleOptions =
      HttpModule.processAxiosConfig(config);

    // Extract interceptors - axios response adapter will be added in the service
    const interceptors = processedConfig.interceptors || [];

    const {
      interceptors: _,
      global: _global,
      ...undiciOptions
    } = processedConfig;

    // Classes are resolved through Nest DI; functions and instances are used as-is
    const functionInterceptors: HttpInterceptorFunction[] = [];
    const classInterceptors: Type<HttpInterceptor>[] = [];
    const instanceInterceptors: HttpInterceptor[] = [];

    interceptors.forEach((interceptor: InterceptorOption) => {
      if (isInterceptorClass(interceptor)) {
        classInterceptors.push(interceptor);
      } else if (typeof interceptor === 'function') {
        functionInterceptors.push(interceptor as HttpInterceptorFunction);
      } else if (isInterceptorInstance(interceptor)) {
        instanceInterceptors.push(interceptor);
      }
    });

    // Create providers for class interceptors
    const interceptorProviders = classInterceptors.map(InterceptorClass => ({
      provide: InterceptorClass,
      useClass: InterceptorClass,
    }));

    return {
      module: HttpModule,
      global: config.global,
      providers: [
        {
          provide: UNDICI_INSTANCE_TOKEN,
          useValue: undiciOptions,
        },
        {
          provide: HTTP_MODULE_OPTIONS,
          useValue: { ...processedConfig, interceptors: functionInterceptors },
        },
        ...interceptorProviders,
        {
          provide: HTTP_SERVICE_INTERCEPTORS,
          useFactory: (...args: any[]) => {
            // The injected arguments are the instantiated interceptors
            const interceptorInstances = args;
            return [
              ...functionInterceptors,
              ...instanceInterceptors,
              ...interceptorInstances,
            ];
          },
          inject: classInterceptors,
        },
        {
          provide: HttpService,
          useFactory: (
            options: ResolvedUndiciRequestOptions,
            moduleOptions: ResolvedHttpModuleOptions,
            interceptors: Array<HttpInterceptor | HttpInterceptorFunction>,
          ) => new HttpService(options, moduleOptions, interceptors),
          inject: [
            UNDICI_INSTANCE_TOKEN,
            HTTP_MODULE_OPTIONS,
            HTTP_SERVICE_INTERCEPTORS,
          ],
        },
      ],
      exports: [HttpService],
    };
  }

  /**
   * Detects axios-style options (register() and registerAsync()) and maps
   * them to undici options plus interceptors (transforms, size limits, ...).
   */
  private static processAxiosConfig(
    config: HttpModuleOptions = {},
  ): ResolvedHttpModuleOptions {
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
      config.proxy !== undefined ||
      config.maxBodyLength !== undefined ||
      config.maxContentLength !== undefined ||
      config.socketPath ||
      config.httpVersion !== undefined ||
      config.http2Options
    );

    let processedConfig = config;

    // If axios-style options detected, map them to undici options
    if (hasAxiosOptions) {
      const warnings = getAxiosCompatibilityWarnings(config);
      if (warnings.length > 0) {
        HttpModule.logger.warn('Axios compatibility warnings:');
        warnings.forEach(warning => HttpModule.logger.warn(`  - ${warning}`));
      }

      // Map axios config to undici config
      const mappedConfig = mapAxiosConfigToUndici(config);

      // Merge with original config, preserving any undici-specific options.
      // `transformRequest`/`transformResponse` stay as plain config (from
      // `...config`) - HttpService's axiosRef pipeline (`buildAxiosConfig`/
      // `serializeAxiosConfig`) runs them directly against the raw request
      // data/response body, rather than through an interceptor that only
      // ever saw the already-serialised/-parsed undici body.
      processedConfig = {
        ...mappedConfig,
        ...config,
        // Ensure interceptors are preserved
        interceptors: [
          ...(mappedConfig.interceptors || []), // Include interceptors from mapping (e.g., size limit)
          ...(config.interceptors || []), // Include user-provided interceptors
        ],
      };
    }

    return processedConfig;
  }

  static registerAsync(options: HttpModuleAsyncOptions): DynamicModule {
    return {
      module: HttpModule,
      global: options.global,
      imports: options.imports,
      providers: [
        ...this.createAsyncProviders(options),
        {
          provide: UNDICI_INSTANCE_TOKEN,
          useFactory: (config: ResolvedHttpModuleOptions) => {
            const { interceptors, global: _global, ...undiciOptions } = config;
            return undiciOptions;
          },
          inject: [HTTP_MODULE_OPTIONS],
        },
        {
          provide: HTTP_SERVICE_INTERCEPTORS,
          useFactory: (config: HttpModuleOptions, moduleRef: ModuleRef) =>
            Promise.all(
              (config.interceptors || [])
                .filter(
                  (interceptor: InterceptorOption) =>
                    typeof interceptor === 'function' ||
                    isInterceptorInstance(interceptor),
                )
                .map((interceptor: InterceptorOption) =>
                  isInterceptorClass(interceptor)
                    ? // Known only at runtime, so not a provider: instantiate it with
                      // dependencies from this module's scope (`imports`, `extraProviders`)
                      moduleRef.create(interceptor)
                    : interceptor,
                ),
            ),
          inject: [HTTP_MODULE_OPTIONS, ModuleRef],
        },
        {
          provide: HttpService,
          useFactory: (
            options: ResolvedUndiciRequestOptions,
            moduleOptions: ResolvedHttpModuleOptions,
            interceptors: Array<HttpInterceptor | HttpInterceptorFunction>,
          ) => new HttpService(options, moduleOptions, interceptors),
          inject: [
            UNDICI_INSTANCE_TOKEN,
            HTTP_MODULE_OPTIONS,
            HTTP_SERVICE_INTERCEPTORS,
          ],
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
    // `createAsyncOptionsProvider` below throws when none of
    // useFactory/useClass/useExisting is set; this check just narrows
    // `useClass` for the compiler, since it runs first either way.
    const useClass = options.useClass;
    if (!useClass) {
      return [this.createAsyncOptionsProvider(options)];
    }
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: useClass,
        useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: HttpModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      const useFactory = options.useFactory;
      return {
        provide: HTTP_MODULE_OPTIONS,
        useFactory: async (...args: any[]) =>
          HttpModule.processAxiosConfig(await useFactory(...args)),
        inject: options.inject || [],
      };
    }
    const factoryClass = options.useExisting || options.useClass;
    if (!factoryClass) {
      // Without this, Nest would silently register a provider with
      // `provide: undefined` (the `inject: [undefined]` below) instead of
      // failing clearly - one of the 7 `strict`-mode errors in
      // `plan/reports/package-quality.md`.
      throw new Error(
        'HttpModule.registerAsync() requires one of useFactory, useClass or useExisting',
      );
    }
    return {
      provide: HTTP_MODULE_OPTIONS,
      useFactory: async (optionsFactory: HttpModuleOptionsFactory) =>
        HttpModule.processAxiosConfig(await optionsFactory.createHttpOptions()),
      inject: [factoryClass],
    };
  }
}
