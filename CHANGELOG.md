# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2025-01-20

### Changed
- **BREAKING**: All responses are now axios-compatible by default. This simplifies the API and makes the library a true drop-in replacement for @nestjs/axios.
- **BREAKING**: Removed `HttpModule.registerAxiosCompatible()` method - use `HttpModule.register()` instead
- **BREAKING**: Removed `HttpModule.registerNative()` and `HttpModule.registerNativeAsync()` methods
- **BREAKING**: Removed `nativeMode` option from `HttpModuleOptions`
- **BREAKING**: Removed `AxiosCompatibleHttpService` class - functionality merged into `HttpService`
- **BREAKING**: `HttpService` methods now always return `Observable<AxiosLikeResponse<T>>`

### Removed
- Removed the ability to get raw Undici responses directly
- Removed `setAxiosCompatible()` and `isAxiosCompatible()` methods from `HttpService`
- Removed native mode test files

### Migration Guide
See the [Migration Guide](README.md#migration-from-v03x-to-v04x) in the README for detailed instructions on upgrading from v0.3.x.

## [0.3.1] - Previous Release

### Added
- Axios compatibility mode via `HttpModule.registerAxiosCompatible()`
- Support for class-based interceptors
- Dynamic interceptor management

### Fixed
- Type inference issues with union types
- Error handling in axios compatibility mode