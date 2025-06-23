# Examples

This directory contains various examples demonstrating the features of `nestjs-undici-interceptors`.

## Running Examples

The examples can be run individually or as a test suite:

### Setup Examples
First, set up the examples by installing dependencies:

```bash
npm run setup:examples
```

This will:
- Build the library
- Install dependencies for the interceptor-demo
- Create necessary configuration files

### Run All Examples as Tests
Run all examples as an e2e test suite:

```bash
npm run test:examples
```

For verbose output:

```bash
npm run test:examples:verbose
```

### Run Individual Examples

#### Root Examples
```bash
# OpenTelemetry Integration
npx ts-node examples/opentelemetry-integration.ts

# Axios Compatibility Features
npx ts-node examples/axios-compatibility-features.ts

# Axios Headers
npx ts-node examples/axios-headers-example.ts
```

#### Interceptor Demo Examples
```bash
cd examples/interceptor-demo

# Basic axios example
npm run test:axios

# Migration patterns
npx ts-node src/axios-to-undici-migration.ts

# Interceptor patterns
npx ts-node src/interceptors-example.ts
```

## Example Descriptions

### Root Examples

1. **opentelemetry-integration.ts**
   - Shows three ways to integrate OpenTelemetry trace propagation
   - Axios-style interceptors (easiest migration)
   - Native interceptors (better performance)
   - Class-based interceptors (most flexible)

2. **axios-compatibility-features.ts**
   - Comprehensive demonstration of all axios compatibility features
   - Configuration mapping (timeout, maxRedirects, etc.)
   - Axios-style interceptor API
   - Response structure compatibility
   - Error handling compatibility
   - All HTTP methods

3. **axios-headers-example.ts**
   - Focused example on AxiosHeaders class
   - Case-insensitive header operations
   - Creating headers from various sources
   - Header concatenation and manipulation

### Interceptor Demo Examples

1. **axios-example.ts**
   - Pure axios reference implementation
   - Useful for comparing behavior

2. **axios-to-undici-migration.ts**
   - Comprehensive migration patterns
   - Side-by-side comparisons
   - Real-world scenarios

3. **interceptors-example.ts**
   - Basic interceptor usage patterns
   - Function-based interceptors
   - Class-based interceptors

## Using Examples as Tests

The examples are designed to be runnable as tests. When run via `npm run test:examples`, they:

1. Execute in isolation with proper error handling
2. Report pass/fail status
3. Show execution time
4. Provide a summary report

This serves as additional e2e testing beyond the formal test suite, ensuring that:
- All documented patterns work correctly
- The library integrates properly with NestJS
- Examples remain up-to-date with library changes

## Adding New Examples

When adding new examples:

1. Make them self-contained and runnable
2. Export a main function for testing: `export async function demonstrateFeature()`
3. Include error handling
4. Add clear console output indicating success/failure
5. Update the `examples` array in `scripts/run-examples.js`

Example structure:
```typescript
export async function demonstrateFeature() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    // Your example code here
    console.log('✅ Feature demonstrated successfully!');
    return true;
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await app.close();
  }
}

// Run if called directly
if (require.main === module) {
  demonstrateFeature().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
```
