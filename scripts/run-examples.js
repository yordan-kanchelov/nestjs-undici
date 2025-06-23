#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const examples = [
  // Root level examples
  {
    name: 'OpenTelemetry Integration',
    file: 'examples/opentelemetry-integration.ts',
    type: 'module',
  },
  {
    name: 'Axios Compatibility Features',
    file: 'examples/axios-compatibility-features.ts',
    type: 'module',
  },
  {
    name: 'Axios Headers Example',
    file: 'examples/axios-headers-example.ts',
    type: 'module',
  },
  // Interceptor demo examples
  {
    name: 'Axios Example',
    file: 'examples/interceptor-demo/src/axios-example.ts',
    type: 'script',
    cwd: 'examples/interceptor-demo',
  },
  {
    name: 'Axios to Undici Migration',
    file: 'examples/interceptor-demo/src/axios-to-undici-migration.ts',
    type: 'script',
    cwd: 'examples/interceptor-demo',
  },
  {
    name: 'Interceptors Example',
    file: 'examples/interceptor-demo/src/interceptors-example.ts',
    type: 'script',
    cwd: 'examples/interceptor-demo',
  },
];

let passed = 0;
let failed = 0;
const results = [];

console.log('🧪 Running examples as tests...\n');

async function runExample(example) {
  return new Promise(resolve => {
    console.log(`📋 Running: ${example.name}`);

    const startTime = Date.now();
    let output = '';
    let errorOutput = '';

    // Determine the command based on example type
    let command, args, options;

    if (example.type === 'module') {
      // For module examples, we need to compile and run
      command = 'npx';
      args = ['ts-node', '--project', 'examples/tsconfig.json', example.file];
      options = { cwd: path.resolve(__dirname, '..') };
    } else {
      // For script examples in interceptor-demo
      command = 'npx';
      args = ['ts-node', path.basename(example.file)];
      options = { cwd: path.resolve(__dirname, '..', example.cwd, 'src') };
    }

    const child = spawn(command, args, {
      ...options,
      env: { ...process.env, NODE_ENV: 'test' },
    });

    child.stdout.on('data', data => {
      output += data.toString();
    });

    child.stderr.on('data', data => {
      errorOutput += data.toString();
    });

    // Set a timeout for long-running examples
    const timeout = setTimeout(() => {
      child.kill();
      console.log(`⏱️  Timeout: ${example.name} (30s)`);
      failed++;
      results.push({
        name: example.name,
        status: 'timeout',
        duration: 30000,
        error: 'Example timed out after 30 seconds',
      });
      resolve();
    }, 30000);

    child.on('close', code => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (code === 0) {
        console.log(`✅ Passed: ${example.name} (${duration}ms)`);
        passed++;
        results.push({
          name: example.name,
          status: 'passed',
          duration,
          output: output.substring(0, 200), // Keep first 200 chars
        });
      } else {
        console.log(`❌ Failed: ${example.name} (${duration}ms)`);
        console.log(`   Error: ${errorOutput || output}`);
        failed++;
        results.push({
          name: example.name,
          status: 'failed',
          duration,
          error: errorOutput || output || `Process exited with code ${code}`,
        });
      }

      console.log(''); // Empty line for readability
      resolve();
    });
  });
}

async function runAllExamples() {
  // Check if examples are set up
  const interceptorDemoNodeModules = path.join(
    __dirname,
    '..',
    'examples',
    'interceptor-demo',
    'node_modules',
  );
  if (!fs.existsSync(interceptorDemoNodeModules)) {
    console.error(
      '❌ Examples not set up. Please run: npm run setup:examples\n',
    );
    process.exit(1);
  }

  // Run examples sequentially
  for (const example of examples) {
    await runExample(example);
  }

  // Print summary
  console.log('📊 Test Summary');
  console.log('================');
  console.log(`Total: ${examples.length}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log('');

  // Print detailed results
  console.log('📋 Detailed Results');
  console.log('===================');
  results.forEach(result => {
    const icon = result.status === 'passed' ? '✅' : '❌';
    console.log(`${icon} ${result.name} (${result.duration}ms)`);
    if (result.status === 'failed' || result.status === 'timeout') {
      console.log(`   ${result.error.split('\n')[0]}`);
    }
  });

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Test run interrupted');
  process.exit(1);
});

runAllExamples().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
