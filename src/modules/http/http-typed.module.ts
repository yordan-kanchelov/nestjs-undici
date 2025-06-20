import { DynamicModule, Module, Provider } from '@nestjs/common';
import { HttpModule } from './http.module';
import { HttpService } from './services/http.service';
import type { HttpModuleOptions } from './types';

/**
 * Symbol to identify the service type at compile time
 */
export const HTTP_SERVICE_TYPE = Symbol('HTTP_SERVICE_TYPE');

/**
 * Typed HTTP module that provides better type inference
 */
@Module({})
export class TypedHttpModule {
  /**
   * Register with standard HttpService
   */
  static register(config: HttpModuleOptions = {}): DynamicModule & {
    __serviceType: HttpService;
  } {
    const baseModule = HttpModule.register(config);
    return {
      ...baseModule,
      __serviceType: {} as HttpService,
    };
  }

}

/**
 * Type helper to extract the service type from a module
 */
export type ExtractHttpServiceType<T> = T extends { __serviceType: infer S } ? S : HttpService;

/**
 * Decorator to inject the correctly typed HttpService
 */
export function InjectTypedHttpService<T extends DynamicModule>(): (
  target: any,
  propertyKey: string | symbol,
  parameterIndex: number
) => void {
  return (target: any, propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const existingTokens = Reflect.getMetadata('design:paramtypes', target) || [];
    existingTokens[parameterIndex] = HttpService;
    Reflect.defineMetadata('design:paramtypes', existingTokens, target);
    Reflect.defineMetadata('self:paramtypes', existingTokens, target);
    if (propertyKey !== undefined) {
      Reflect.defineMetadata('optional:paramtypes', false, target, propertyKey);
    }
  };
}