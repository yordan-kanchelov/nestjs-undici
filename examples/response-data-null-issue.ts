import { Observable } from 'rxjs';
import { Dispatcher } from 'undici';
import { AxiosLikeResponse } from '../src/modules/http/interfaces/axios-compatible.interface';

// ==============================================
// UNDERSTANDING THE ISSUE
// ==============================================

// Undici's ResponseData is defined like this:
// interface ResponseData<TOpaque = any> {
//   statusCode: number;
//   headers: IncomingHttpHeaders;
//   body: BodyMixin & BodyStream;
//   trailers: Record<string, string>;
//   opaque: TOpaque;  // <-- This is why there's a generic parameter
//   context: object;
// }

// When undici's request function is called without specifying the generic:
// request(url, options): Promise<Dispatcher.ResponseData<null>>
//                                                         ^^^^
// It defaults to null because TOpaque = null by default

// ==============================================
// THE PROBLEM IN YOUR CODE
// ==============================================

type ProblematicReturnType<T> = Observable<Dispatcher.ResponseData<null> | AxiosLikeResponse<T>>;
//                                                                 ^^^^
// This <null> makes TypeScript more strict about the union type

// When you try to access .data:
function demonstrateProblem<T>(response: Dispatcher.ResponseData<null> | AxiosLikeResponse<T>) {
  // ❌ ERROR: Property 'data' does not exist on type 'ResponseData<null> | AxiosLikeResponse<T>'
  // return response.data;
  
  // TypeScript is correct - ResponseData<null> doesn't have a 'data' property
}

// ==============================================
// SOLUTION 1: Type Guards (Safe Approach)
// ==============================================

// Type guard to check if it's an AxiosLikeResponse
function isAxiosLikeResponse<T>(
  response: Dispatcher.ResponseData<any> | AxiosLikeResponse<T>
): response is AxiosLikeResponse<T> {
  return 'data' in response && 'status' in response && 'statusText' in response;
}

// Alternative simpler type guard
function hasDataProperty<T>(
  response: any
): response is { data: T } {
  return response && 'data' in response;
}

// Using the type guard in your code:
function fixedGetAllPlayersWithTypeGuard<T>(response: Dispatcher.ResponseData<null> | AxiosLikeResponse<T>) {
  if (isAxiosLikeResponse(response)) {
    return response.data; // ✅ TypeScript knows this is safe
  }
  
  // Handle the ResponseData case
  // You would need to parse response.body here
  return undefined;
}

// ==============================================
// SOLUTION 2: Use Axios Compatible Service
// ==============================================

// The AxiosCompatibleHttpService always returns AxiosLikeResponse
class AxiosCompatibleHttpService {
  get<T>(url: string): Observable<AxiosLikeResponse<T>> {
    // No union type - always returns AxiosLikeResponse
    return {} as Observable<AxiosLikeResponse<T>>;
  }
}

// Your code becomes simpler:
function fixedGetAllPlayersAxiosMode() {
  const httpService = new AxiosCompatibleHttpService();
  
  return httpService.get<any[]>('/api/players').pipe(
    map(response => response.data), // ✅ No error - always has data property
  );
}

// ==============================================
// SOLUTION 3: Response Transformer
// ==============================================

// Create a transformer that normalizes responses
function normalizeResponse<T>(
  response: Dispatcher.ResponseData<null> | AxiosLikeResponse<T>
): AxiosLikeResponse<T> | undefined {
  if (isAxiosLikeResponse(response)) {
    return response;
  }
  
  // Transform ResponseData to AxiosLikeResponse format
  if ('statusCode' in response && 'body' in response) {
    // Note: This is simplified - actual implementation would need to handle body parsing
    return {
      data: undefined as any, // Would parse response.body here
      status: response.statusCode,
      statusText: '', // Would derive from status code
      headers: response.headers,
      config: {} as any,
    };
  }
  
  return undefined;
}

// ==============================================
// SOLUTION 4: Operator to Handle Response
// ==============================================

import { map, OperatorFunction } from 'rxjs';

// Create a custom RxJS operator
function extractData<T>(): OperatorFunction<
  Dispatcher.ResponseData<null> | AxiosLikeResponse<T>,
  T | undefined
> {
  return map((response) => {
    if (!response) return undefined;
    
    // Check for axios-like response
    if ('data' in response) {
      return (response as AxiosLikeResponse<T>).data;
    }
    
    // Handle ResponseData - you'd implement actual body parsing here
    console.warn('Received non-axios response, body parsing not implemented');
    return undefined;
  });
}

// Usage in your service:
function fixedGetAllPlayersWithOperator() {
  const httpService = {} as { get<T>(url: string): ProblematicReturnType<T> };
  
  return httpService.get<any[]>('/api/players').pipe(
    extractData(), // ✅ Clean and reusable
    map(players => {
      if (players) {
        return new Map(players.map(p => [p.playerSessionId, p]));
      }
      return undefined;
    })
  );
}

// ==============================================
// RECOMMENDED FIX FOR YOUR CODE
// ==============================================

interface PlayerSessionDTO {
  playerSessionId: string;
  name: string;
}

// Option A: Quick fix with type guard
export async function getAllPlayersQuickFix(
  httpService: { get<T>(url: string): ProblematicReturnType<T> },
  url: string
): Promise<Map<string, PlayerSessionDTO> | undefined> {
  return await firstValueFrom(
    httpService.get<PlayerSessionDTO[]>(url).pipe(
      catchError((ex) => {
        console.error("Error while getting players");
        return of(undefined);
      }),
      retry({ count: 3, delay: 500 }),
      map((response) => {
        // ✅ Simple type guard check
        if (response && 'data' in response) {
          return response.data;
        }
        return undefined;
      }),
      map((players) => {
        if (players) {
          return players.reduce((acc, player) => {
            return acc.set(player.playerSessionId, player);
          }, new Map<string, PlayerSessionDTO>());
        }
        return undefined;
      }),
    ),
  );
}

// Option B: Best practice - use axios compatible mode
// In your module:
/*
@Module({
  imports: [
    HttpModule.registerAxiosCompatible({
      // config
    }),
  ],
})
export class YourModule {}
*/

// Then inject the compatible service:
/*
constructor(
  @Inject(AXIOS_COMPATIBLE_HTTP_SERVICE)
  private readonly httpService: AxiosCompatibleHttpService,
) {}
*/

// Your method stays exactly the same but with no type errors:
/*
return await firstValueFrom(
  this.httpService.get<PlayerSessionDTO[]>(url).pipe(
    // ... rest of your pipeline
    map((response) => response?.data), // ✅ Always works!
  )
);
*/

// ==============================================
// WHY THIS HAPPENS - TECHNICAL DETAILS
// ==============================================

/*
The issue stems from how TypeScript handles union types and undici's generic ResponseData:

1. Undici defines: ResponseData<TOpaque = null>
2. When used without generic: ResponseData defaults to ResponseData<null>
3. The union Dispatcher.ResponseData<null> | AxiosLikeResponse<T> is strict
4. TypeScript can't guarantee 'data' exists on both types
5. Even though you "know" you'll get an AxiosLikeResponse, TypeScript doesn't

The fix is to either:
- Narrow the type with guards
- Use a service that guarantees the response type
- Transform all responses to a common format
*/

// Helper functions used in examples
import { catchError, retry, firstValueFrom, of } from 'rxjs';

function firstValueFrom<T>(obs: Observable<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    obs.subscribe({
      next: resolve,
      error: reject,
    });
  });
}