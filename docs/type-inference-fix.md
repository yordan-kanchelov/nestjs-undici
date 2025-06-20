# Type Inference Fix for ResponseData

## Problem

The HttpService was returning a union type of `Dispatcher.ResponseData<null> | AxiosLikeResponse<T>` for convenience methods (get, post, etc.). The issue was that `ResponseData` was always typed with `<null>` for the opaque parameter, which prevented proper type inference in TypeScript.

## Root Cause

1. The undici `request` function is generic with a `TOpaque = null` parameter
2. The `HttpService.request` method wasn't propagating this generic type
3. This caused `Dispatcher.ResponseData` to always use the default `null` type
4. The convenience methods returned a union type that included `ResponseData<null>`, making TypeScript unable to narrow the type properly

## Solution

The fix involved making the following changes:

1. **Made `HttpService.request` generic**: Added `<TOpaque = any>` parameter that propagates through to undici's request function
2. **Updated internal methods**: Made `executeRequest`, `executeInterceptorChain`, and `createInterceptorHandler` generic to properly pass the type parameter
3. **Fixed convenience method return types**: Changed from `ResponseData` to `ResponseData<any>` in the union types
4. **Updated interceptor interfaces**: Changed interceptor interfaces to return `Observable<any>` since interceptors can transform responses to any type (e.g., AxiosLikeResponse)
5. **Updated type definitions**: Modified `UndiciRequestOptionsType` to use `Dispatcher.RequestOptions<any>` instead of the default

## Impact

- Improved type inference when using HttpService
- Better TypeScript support for response handling
- No breaking changes to the API
- Interceptors can now properly transform response types

## Usage

The fix allows for better type handling:

```typescript
// Before: TypeScript couldn't properly infer the type
httpService.get<User[]>('/users').pipe(
  map(response => {
    // Error: Property 'data' does not exist on type 'ResponseData<null> | AxiosLikeResponse<User[]>'
    return response.data; // ❌
  })
);

// After: TypeScript can work with the response properly
httpService.get<User[]>('/users').pipe(
  map(response => {
    if ('data' in response) {
      return response.data; // ✅ TypeScript knows this is AxiosLikeResponse<User[]>
    }
    // Handle Dispatcher.ResponseData<any> case
    return null;
  })
);
```