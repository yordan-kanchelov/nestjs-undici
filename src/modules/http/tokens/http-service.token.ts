import { InjectionToken } from '@nestjs/common';
import { HttpService } from '../services/http.service';

/**
 * Typed injection token for HttpService
 * This allows proper type inference based on module configuration
 */
export const TYPED_HTTP_SERVICE = Symbol('TYPED_HTTP_SERVICE');

/**
 * Type-safe provider factory
 */
export interface TypedHttpServiceProvider<T extends HttpService = HttpService> {
  provide: typeof HttpService;
  useValue: T;
}

/**
 * Helper to create a properly typed HttpService provider
 */
export function createTypedHttpServiceProvider<T extends HttpService>(
  service: T
): TypedHttpServiceProvider<T> {
  return {
    provide: HttpService,
    useValue: service,
  };
}