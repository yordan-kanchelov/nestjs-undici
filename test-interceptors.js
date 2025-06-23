// Test script to verify interceptor functionality
const { HttpService } = require('./lib/modules/http/services/http.service');

console.log('Testing interceptor functionality in nestjs-undici...\n');

// Create a new HttpService instance
const httpService = new HttpService({});

console.log('1. Checking if interceptor methods exist:');
console.log(
  '   - addInterceptor method exists:',
  typeof httpService.addInterceptor === 'function',
);
console.log(
  '   - interceptorCount property exists:',
  typeof httpService.interceptorCount === 'number',
);
console.log('   - Initial interceptor count:', httpService.interceptorCount);

console.log('\n2. Testing dynamic interceptor addition:');
// Add a test interceptor
httpService.addInterceptor((request, next) => {
  console.log('   ✓ Interceptor called for:', request.url);
  return next.handle(request);
});

console.log(
  '   - Interceptor count after adding:',
  httpService.interceptorCount,
);

console.log('\n3. Making a test request with interceptor:');
const observable = httpService.request(
  'https://jsonplaceholder.typicode.com/posts/1',
);

observable.subscribe({
  next: response => {
    console.log('   ✓ Request completed with status:', response.statusCode);
    console.log('\n✅ Interceptor functionality is working correctly!');
  },
  error: err => {
    console.error('   ✗ Request failed:', err.message);
  },
});
