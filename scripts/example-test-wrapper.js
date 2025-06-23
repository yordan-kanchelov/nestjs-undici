#!/usr/bin/env node

/**
 * Wrapper to run example files as tests
 * This adds basic assertions and error handling to examples
 */

const path = require('path');
const fs = require('fs');

// Get the example file from command line
const exampleFile = process.argv[2];
if (!exampleFile) {
  console.error('Usage: node example-test-wrapper.js <example-file>');
  process.exit(1);
}

// Set up a simple test environment
global.testResults = {
  passed: 0,
  failed: 0,
  assertions: [],
};

// Simple assertion helper
global.assert = (condition, message) => {
  if (condition) {
    global.testResults.passed++;
    global.testResults.assertions.push({ passed: true, message });
  } else {
    global.testResults.failed++;
    global.testResults.assertions.push({ passed: false, message });
    console.error(`❌ Assertion failed: ${message}`);
  }
};

// Mock console.log to reduce noise in test mode
const originalLog = console.log;
console.log = (...args) => {
  if (process.env.VERBOSE === 'true') {
    originalLog(...args);
  }
};

// Load and run the example
async function runExample() {
  try {
    // For TypeScript files, we need ts-node
    if (exampleFile.endsWith('.ts')) {
      require('ts-node').register({
        transpileOnly: true,
        compilerOptions: {
          module: 'commonjs',
          target: 'es2021',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
        },
      });
    }

    // Load the example module
    const examplePath = path.resolve(exampleFile);
    const example = require(examplePath);

    // If the example exports functions, try to run them
    if (example.demonstrateFeatures) {
      await example.demonstrateFeatures();
    } else if (example.main) {
      await example.main();
    } else if (example.default?.main) {
      await example.default.main();
    }

    // Wait a bit for any async operations to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Report results
    if (global.testResults.failed > 0) {
      console.error(
        `\n❌ Example failed with ${global.testResults.failed} assertion failures`,
      );
      process.exit(1);
    } else {
      originalLog(
        `\n✅ Example passed with ${global.testResults.passed} assertions`,
      );
      process.exit(0);
    }
  } catch (error) {
    console.error(`\n❌ Example failed with error:`, error.message);
    if (process.env.VERBOSE === 'true') {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Set a timeout
setTimeout(() => {
  console.error('\n❌ Example timed out after 30 seconds');
  process.exit(1);
}, 30000);

// Run the example
runExample();
