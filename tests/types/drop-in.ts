// Compile-only: nestjs-axios-undici must be assignable everywhere
// @nestjs/axios types are expected -- the actual "drop-in" contract. A case
// that already holds is plain code; a case that doesn't yet hold is pinned
// with `@ts-expect-error` and a reason, so fixing it forces this file to be
// updated (the stale directive then fails to compile).
// Drop-in type checks (plan.md phase 1 item C).
import type {
  HttpService as RefHttpService,
  HttpModuleOptions as RefHttpModuleOptions,
  HttpModuleAsyncOptions as RefHttpModuleAsyncOptions,
} from '@nestjs/axios';
import type { AxiosInstance, AxiosResponse, AxiosRequestConfig } from 'axios';
import type { Observable } from 'rxjs';
import { HttpModule, HttpService } from '../../lib';

type PublicOf<T> = { [K in keyof T]: T[K] };

declare const ours: HttpService;

// Our HttpService should stand in for @nestjs/axios' HttpService wherever
// it's injected or typed. ('query', new in @nestjs/axios 12, is now
// implemented - see HttpService.query().) AxiosHeaders casing/overload
// parity (plan.md "feat(axiosRef): make it a real axios instance") is done -
// response.config.headers, the InternalAxiosRequestConfig callback shape
// (case9 in usage.ts) and a plain get()/getUri() call's result (below,
// getWithAxiosConfig) are all fully assignable now. What's left here is
// unrelated to headers: axios' own `Axios.request`/`get`/... carry a 4th
// generic (`R`, `AxiosResponseResult<T, R, D, P>`) that lets a caller fully
// override the *response type itself* - since our methods have no matching
// generic, TypeScript can't prove our fixed `AxiosLikeResponse<T, D>` return
// type satisfies that for an arbitrary `R`, only for axios' own default.
// Not pursued: matching it would mean adding a real, otherwise-unused `R`/`P`
// generic pair throughout this library's own request/response types for an
// axios escape hatch this library doesn't use.
// @ts-expect-error -- see the comment above: axios' `Axios.request`/`get`/... have a 4th generic (R, AxiosResponseResult<T,R,D,P>) this library's methods don't mirror; not an AxiosHeaders gap
export const asRefHttpService: PublicOf<RefHttpService> = ours;

// axiosRef should be usable as a plain axios AxiosInstance - callable,
// getUri/create/*Form/query and defaults are all fully assignable now (both
// directions). Blocked only by the same `R`-generic gap as above.
// @ts-expect-error -- same root cause as asRefHttpService above (axios' AxiosResponseResult<T,R,D,P> 4th generic on request/get/...), not an AxiosHeaders gap
export const axiosRefAsAxiosInstance: AxiosInstance = ours.axiosRef;

// A variable typed with axios' own AxiosRequestConfig should be a valid
// second argument to get(), and the call's return type should be assignable
// to Observable<AxiosResponse<T>>, as code written against @nestjs/axios expects.
declare const axiosStyleConfig: AxiosRequestConfig;
export function getWithAxiosConfig(): Observable<
  AxiosResponse<{ id: number }>
> {
  return ours.get<{ id: number }>('/x', axiosStyleConfig);
}

// The same options object accepted by @nestjs/axios' HttpModule.register()
// should be accepted by ours.
declare const refModuleOptions: RefHttpModuleOptions;
HttpModule.register(refModuleOptions);

// ...and HttpModuleAsyncOptions by registerAsync().
declare const refModuleAsyncOptions: RefHttpModuleAsyncOptions;
HttpModule.registerAsync(refModuleAsyncOptions);
