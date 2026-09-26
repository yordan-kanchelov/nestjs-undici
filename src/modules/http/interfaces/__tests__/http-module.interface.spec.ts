import type { Provider, Type } from '@nestjs/common';

import {
  HttpModuleAsyncOptions,
  HttpModuleOptionsFactory,
} from '../http-module.interface';

import type { HttpModuleOptions } from '../../types';

class HttpModuleOptionsFactoryImplMock implements HttpModuleOptionsFactory {
  createHttpOptions(): Promise<HttpModuleOptions> | HttpModuleOptions {
    return {
      headers: {
        'Content-Type': 'application/json',
      },
      baseURL: 'http://localhost:3000',
    };
  }
}

describe('http-module.interface', () => {
  describe('HttpModuleOptionsFactory', () => {
    let httpModuleOptionsFactory: HttpModuleOptionsFactory;
    let createHttpOptions: HttpModuleOptions;

    beforeEach(() => {
      httpModuleOptionsFactory = new HttpModuleOptionsFactoryImplMock();
      // The mock always returns synchronously; the interface itself allows
      // a Promise too (see `HttpModuleOptionsFactory`).
      createHttpOptions =
        httpModuleOptionsFactory.createHttpOptions() as HttpModuleOptions;
    });
    it('should be defined', () => {
      expect(httpModuleOptionsFactory).toBeDefined();
    });
    it('should be headers defined', () => {
      expect(createHttpOptions.headers).toBeDefined();
    });
  });
  describe('HttpModuleAsyncOptions', () => {
    class HttpModuleAsyncOptionsImpl implements HttpModuleAsyncOptions {
      useExisting?: Type<HttpModuleOptionsFactory>;
      useClass?: Type<HttpModuleOptionsFactory>;
      useFactory?: (
        ...args: any[]
      ) => Promise<HttpModuleOptions> | HttpModuleOptions;
      inject?: any[];
      extraProviders?: Provider[];
    }
    it('should be defined', () => {
      expect(HttpModuleAsyncOptionsImpl).toBeDefined();
    });
  });
});
