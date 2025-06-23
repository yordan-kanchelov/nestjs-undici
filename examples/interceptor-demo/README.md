# Interceptor Demo

This example demonstrates the interceptor pattern implementation in `nestjs-undici` compared to `@nestjs/axios`.

## Setup

```bash
npm install
```

## Run Examples

### 1. @nestjs/axios with interceptors
```bash
npm run test:axios
```
Shows the traditional axios interceptor pattern.

### 2. nestjs-undici WITHOUT interceptors (original issue)
```bash
npm run test:undici
```
Shows the original problem - no interceptor support.

### 3. nestjs-undici WITH interceptors (NEW!)
```bash
npm run test:undici-simple
```
Shows the new interceptor functionality with dynamic interceptors.

### 4. Complete interceptor demonstration
```bash
npm run test:complete
```
Shows comprehensive interceptor usage including:
- Function-based interceptors
- Request modification
- Response logging
- Error handling
- Dynamic interceptor addition

## Problem Solved! ✅

`nestjs-undici` now supports HTTP interceptors similar to `@nestjs/axios`:

### Configuration-based Interceptors
```typescript
HttpModule.register({
  interceptors: [
    authInterceptor,      // Function interceptor
    LoggingInterceptor,   // Class interceptor
  ],
});
```

### Dynamic Interceptors
```typescript
httpService.addInterceptor((request, next) => {
  // Modify request
  return next.handle(modifiedRequest);
});
```

### Features Implemented
1. ✅ Add authentication headers to all requests
2. ✅ Log request/response details
3. ✅ Handle errors globally
4. ✅ Chain multiple interceptors
5. ✅ Add interceptors dynamically at runtime

The interceptor pattern is now fully supported in nestjs-undici!