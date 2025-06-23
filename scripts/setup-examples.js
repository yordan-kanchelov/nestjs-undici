#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🔧 Setting up examples...\n');

// Build the main library first
console.log('📦 Building nestjs-undici-interceptors library...');
execSync('npm run build', {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
});

// Setup interceptor-demo
const interceptorDemoPath = path.join(
  __dirname,
  '..',
  'examples',
  'interceptor-demo',
);
if (fs.existsSync(interceptorDemoPath)) {
  console.log('\n📦 Setting up interceptor-demo example...');

  // Update package.json to use the latest local build
  const packageJsonPath = path.join(interceptorDemoPath, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // Ensure it points to the local build
  packageJson.dependencies['nestjs-undici-interceptors'] = 'file:../..';
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

  // Install dependencies
  console.log('Installing dependencies for interceptor-demo...');
  execSync('npm install', { stdio: 'inherit', cwd: interceptorDemoPath });
}

// Create a tsconfig for root examples if it doesn't exist
const rootExamplesTsConfig = path.join(
  __dirname,
  '..',
  'examples',
  'tsconfig.json',
);
if (!fs.existsSync(rootExamplesTsConfig)) {
  console.log('\n📝 Creating tsconfig.json for root examples...');
  const tsConfig = {
    compilerOptions: {
      module: 'commonjs',
      declaration: false,
      removeComments: true,
      emitDecoratorMetadata: true,
      experimentalDecorators: true,
      allowSyntheticDefaultImports: true,
      target: 'ES2021',
      sourceMap: false,
      outDir: './dist',
      baseUrl: './',
      incremental: false,
      skipLibCheck: true,
      strictNullChecks: false,
      noImplicitAny: false,
      strictBindCallApply: false,
      forceConsistentCasingInFileNames: false,
      noFallthroughCasesInSwitch: false,
      resolveJsonModule: true,
      esModuleInterop: true,
      paths: {
        'nestjs-undici-interceptors': ['../lib'],
        'nestjs-undici-interceptors/*': ['../lib/*'],
      },
    },
    include: ['*.ts'],
    exclude: ['node_modules', 'dist', 'interceptor-demo'],
  };
  fs.writeFileSync(rootExamplesTsConfig, JSON.stringify(tsConfig, null, 2));
}

console.log('\n✅ Examples setup complete!');
console.log('You can now run: npm run test:examples\n');
