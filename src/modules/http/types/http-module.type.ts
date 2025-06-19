import type { Dispatcher } from 'undici';
import type { UrlObject } from 'node:url';

export type UndiciResponseDataType = Promise<Dispatcher.ResponseData>;

export type UndiciRequestOptionsType = {
  dispatcher?: Dispatcher;
} & Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method'> &
  Partial<any>;

export type UndiciURLType = string | URL | UrlObject;

export type UndiciRequestArgsType = {
  url: UndiciURLType;
  options?: UndiciRequestOptionsType;
};

export type UndiciRequestType = (
  args: UndiciRequestArgsType,
) => UndiciResponseDataType;

import type { Type } from '@nestjs/common';
import type { HttpInterceptor, HttpInterceptorFunction } from '../interfaces';

export type HttpModuleOptions = UndiciRequestOptionsType & {
  interceptors?: Array<Type<HttpInterceptor> | HttpInterceptorFunction>;
};
