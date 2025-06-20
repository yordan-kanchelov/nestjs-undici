import type { Dispatcher } from 'undici';
import type { UrlObject } from 'node:url';

export type UndiciResponseDataType = Promise<Dispatcher.ResponseData>;

export type UndiciRequestOptionsType = {
  dispatcher?: Dispatcher;
} & Omit<Dispatcher.RequestOptions<any>, 'origin' | 'path' | 'method'> &
  Partial<any>;

export type UndiciURLType = string | URL | UrlObject;

export type UndiciRequestArgsType = {
  url: UndiciURLType;
  options?: UndiciRequestOptionsType;
};

export type UndiciRequestType = (
  args: UndiciRequestArgsType,
) => UndiciResponseDataType;

import type { Type, DynamicModule } from '@nestjs/common';
import type { HttpInterceptor, HttpInterceptorFunction } from '../interfaces';

export type HttpModuleOptions = UndiciRequestOptionsType & {
  interceptors?: Array<Type<HttpInterceptor> | HttpInterceptorFunction>;
};

export interface TypedDynamicModule<T> extends DynamicModule {
  module: Type<any>;
  providers: any[];
  exports: any[];
}
