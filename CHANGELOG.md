# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.4] - 2025-06-21

### Fixed
- Critical fix for "UNDICI_INSTANCE_TOKEN" error when HttpModule is used with stored module pattern
- Added default providers to match @nestjs/axios behavior exactly

## [0.5.3] - 2025-06-21

### Fixed
- Fixed `HttpModule.registerAsync()` to properly handle axios-style configurations
- Fixed `HttpModule.registerAsync()` to support transform functions (transformRequest/transformResponse)
- Fixed dependency resolution issues when using HttpService in NestJS modules
- Fixed "UNDICI_INSTANCE_TOKEN" error when HttpModule.register() result is stored in a variable and re-exported
- Added default providers to base HttpModule to match @nestjs/axios behavior
- Improved compatibility with existing @nestjs/axios codebases

### Added
- Comprehensive NestJS module integration tests
- Real-world NestJS application tests
- HttpConfigModule compatibility test for OpenTelemetry scenarios
- Exact @nestjs/axios compatibility tests
- Documentation for interceptor patterns and limitations

### Changed
- Enhanced `registerAsync` to process configurations through the same axios compatibility logic as `register()`
- Added default UNDICI_INSTANCE_TOKEN and HTTP_MODULE_OPTIONS providers to base module
- Documented class-based interceptor limitations with dependency injection

## [0.5.0] - 2025-06-21

### Added
- Full support for `httpAgent`/`httpsAgent` options - automatically maps to Undici Agent configuration
- Full support for `proxy` option - automatically creates ProxyAgent with authentication support
- Full support for `maxBodyLength`/`maxContentLength` options - enforces size limits via interceptors
- Full support for `withCredentials` option - enables automatic cookie management via http-cookie-agent
- New `SizeLimitInterceptor` for request/response size validation
- Axios-style interceptor API via `httpService.axiosRef.interceptors.request/response.use()`
- The standard `HttpModule.register()` method now automatically detects and handles axios options
- Comprehensive documentation for newly supported axios options

### Changed
- Enhanced `mapAxiosConfigToUndici` to handle all new options
- Updated `HttpService` to setup custom dispatchers based on configuration
- Improved axios response adapter to check content length limits
- Removed warnings for now-supported options (httpAgent, httpsAgent, proxy, maxBodyLength, maxContentLength, withCredentials)

### Dependencies
- Added `http-cookie-agent` as runtime dependency for cookie support

### Documentation
- Added `docs/axios-supported-options.md` with detailed explanations
- Updated migration guide with new features
- Added known limitations section

### Known Limitations
- Combining `httpAgent`/`httpsAgent` with `withCredentials` may cause issues due to dispatcher wrapping

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