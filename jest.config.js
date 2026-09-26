module.exports = {
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  // Unit tests live next to the code in src/**/__tests__, e2e tests in tests/
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.(t|j)s$',
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/__tests__/**'],
  // V8 coverage is mapped back to the .ts sources through ts-jest's source
  // maps. The default (babel/istanbul) provider writes malformed `SF:` paths
  // into lcov.info with ts-jest + TypeScript 6, which Codecov can't match.
  coverageProvider: 'v8',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  testTimeout: 10000,
};
