// Set environment variable to disable keepAlive in tests
process.env.NODE_ENV = 'test';
process.env.DISABLE_KEEPALIVE = 'true';

// Import agent tracker to automatically track and cleanup all HTTP agents
// Temporarily disabled due to Node.js compatibility issues
// require('./test-helpers/agent-tracker');

// Set a reasonable timeout for all tests
jest.setTimeout(10000);

// Add global teardown for each test file
afterAll(async () => {
  // Give time for any pending operations to complete
  await new Promise(resolve => setTimeout(resolve, 100));

  // Clear all timers
  jest.clearAllTimers();

  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
});
