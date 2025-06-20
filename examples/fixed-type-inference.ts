import { Dispatcher } from 'undici';
import { Observable } from 'rxjs';
import { AxiosLikeResponse } from '../src/modules/http/interfaces/axios-compatible.interface';

// ==============================================
// THE ISSUE WITH TYPE INFERENCE
// ==============================================

// Undici's request function signature:
// function request<TOpaque = null>(
//   url: string | URL, 
//   options?: RequestOptions<TOpaque>
// ): Promise<Dispatcher.ResponseData<TOpaque>>

// The problem was that HttpService wasn't passing through the generic:
class OldHttpService {
  // ❌ BAD: Not generic, loses type information
  request(url: string, options?: any): Observable<any> {
    // When calling undici.request() without generic, it defaults to <null>
    return {} as Observable<any>;
  }
  
  // This caused the union type to always have ResponseData<null>
  get<T>(url: string): Observable<Dispatcher.ResponseData<null> | AxiosLikeResponse<T>> {
    return {} as any;
  }
}

// ==============================================
// THE FIX: PROPER GENERIC PROPAGATION
// ==============================================

class FixedHttpService {
  // ✅ GOOD: Generic method that preserves type information
  request<TOpaque = any>(
    url: string, 
    options?: Dispatcher.RequestOptions<TOpaque>
  ): Observable<Dispatcher.ResponseData<TOpaque>> {
    // Now undici.request<TOpaque>() preserves the generic
    return {} as Observable<Dispatcher.ResponseData<TOpaque>>;
  }
  
  // Now the union type has ResponseData<any> instead of ResponseData<null>
  get<T>(url: string): Observable<Dispatcher.ResponseData<any> | AxiosLikeResponse<T>> {
    return {} as any;
  }
}

// ==============================================
// WHAT THIS MEANS FOR YOUR CODE
// ==============================================

// Before the fix:
type OldReturnType<T> = Observable<Dispatcher.ResponseData<null> | AxiosLikeResponse<T>>;
//                                                          ^^^^
// Always null, making TypeScript stricter

// After the fix:
type NewReturnType<T> = Observable<Dispatcher.ResponseData<any> | AxiosLikeResponse<T>>;
//                                                         ^^^
// More flexible, but still requires type guards for safety

// ==============================================
// PRACTICAL IMPACT
// ==============================================

// The type inference is better, but you still need to handle the union type:
function handleResponse<T>(response: Dispatcher.ResponseData<any> | AxiosLikeResponse<T>) {
  // Still need to check which type it is:
  if ('data' in response) {
    // It's AxiosLikeResponse
    return response.data;
  } else {
    // It's ResponseData - need to parse body
    // response.body contains the actual data
    return undefined;
  }
}

// ==============================================
// WHY THE UNION TYPE EXISTS
// ==============================================

/*
The library supports two modes:
1. Native undici mode: Returns Dispatcher.ResponseData
2. Axios compatibility mode: Returns AxiosLikeResponse

The union type allows the same service to work in both modes,
but it means you need to handle both cases unless you use
the axios-compatible service specifically.
*/

// ==============================================
// BEST PRACTICES AFTER THE FIX
// ==============================================

// Option 1: Use type guards (works with both modes)
export function safeExtractData<T>(
  response: Dispatcher.ResponseData<any> | AxiosLikeResponse<T>
): T | undefined {
  if (!response) return undefined;
  
  if ('data' in response) {
    return response.data;
  }
  
  // For ResponseData, you'd parse the body
  // This is simplified - real implementation would handle async body parsing
  return undefined;
}

// Option 2: Use axios compatibility mode for consistency
// This is still the recommended approach for easier migration:
/*
@Module({
  imports: [
    HttpModule.registerAxiosCompatible({
      // config
    }),
  ],
})
export class AppModule {}
*/

// Then use AxiosCompatibleHttpService which always returns AxiosLikeResponse<T>

// ==============================================
// SUMMARY
// ==============================================

/*
The fix improves type inference by:
1. Making HttpService.request() generic with <TOpaque = any>
2. Propagating the generic through the call chain
3. Changing ResponseData<null> to ResponseData<any> in return types

However, you still need to handle the union type because:
- The library supports both native and axios-compatible modes
- TypeScript can't know which mode you're using at compile time
- Type guards or axios-compatible mode are still the best solutions

The improvement is that ResponseData<any> is more flexible than
ResponseData<null>, making TypeScript slightly less strict about
the union type handling.
*/