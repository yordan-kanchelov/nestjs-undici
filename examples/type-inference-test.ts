import { Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { Dispatcher } from 'undici';

// Mock types to demonstrate the issue
interface PlayerSessionDTO {
  playerSessionId: string;
  name: string;
}

interface AxiosLikeResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
}

// This simulates the HttpService.get() return type
type HttpServiceResponse<T> = Observable<AxiosLikeResponse<T> | Dispatcher.ResponseData>;

// Mock HttpService
class HttpService {
  get<T>(url: string): HttpServiceResponse<T> {
    // Could return either type depending on configuration
    return of({} as AxiosLikeResponse<T> | Dispatcher.ResponseData);
  }
}

// ==============================================
// PROBLEM: Type inference error demonstration
// ==============================================

function problemExample() {
  const httpService = new HttpService();
  
  httpService.get<PlayerSessionDTO[]>('/api/players').pipe(
    map((response) => {
      // ❌ ERROR: Property 'data' does not exist on type 'ResponseData<null> | AxiosLikeResponse<PlayerSessionDTO[]>'
      // TypeScript can't guarantee 'data' exists because Dispatcher.ResponseData doesn't have it
      return response.data; // This will cause the error
    })
  );
}

// ==============================================
// SOLUTION 1: Type Guards
// ==============================================

// Type guard to check if response is AxiosLikeResponse
function isAxiosLikeResponse<T>(response: any): response is AxiosLikeResponse<T> {
  return 'data' in response && 'status' in response && 'statusText' in response;
}

function solution1TypeGuard() {
  const httpService = new HttpService();
  
  httpService.get<PlayerSessionDTO[]>('/api/players').pipe(
    map((response) => {
      // ✅ Use type guard to narrow the type
      if (isAxiosLikeResponse<PlayerSessionDTO[]>(response)) {
        return response.data; // Now TypeScript knows 'data' exists
      } else {
        // Handle Dispatcher.ResponseData case
        // You need to parse the body manually
        throw new Error('Non-axios response not handled');
      }
    })
  );
}

// ==============================================
// SOLUTION 2: Extract Data Helper
// ==============================================

// Helper function to safely extract data from either response type
function extractData<T>(response: AxiosLikeResponse<T> | Dispatcher.ResponseData): T | undefined {
  if (isAxiosLikeResponse<T>(response)) {
    return response.data;
  } else {
    // For Dispatcher.ResponseData, you'd need to parse the body
    // This is a simplified example
    console.warn('Attempting to extract data from non-axios response');
    return undefined;
  }
}

function solution2Helper() {
  const httpService = new HttpService();
  
  httpService.get<PlayerSessionDTO[]>('/api/players').pipe(
    map((response) => extractData(response)), // ✅ Clean and reusable
    map((players) => {
      if (players) {
        return players.reduce((acc, player) => {
          return acc.set(player.playerSessionId, player);
        }, new Map<string, PlayerSessionDTO>());
      }
      return undefined;
    })
  );
}

// ==============================================
// SOLUTION 3: Use Axios Compatible Mode
// ==============================================

// When using HttpModule.registerAxiosCompatible(), the service always returns AxiosLikeResponse
class AxiosCompatibleHttpService {
  get<T>(url: string): Observable<AxiosLikeResponse<T>> {
    // Always returns AxiosLikeResponse when in compatibility mode
    return of({} as AxiosLikeResponse<T>);
  }
}

function solution3AxiosCompatible() {
  const httpService = new AxiosCompatibleHttpService();
  
  httpService.get<PlayerSessionDTO[]>('/api/players').pipe(
    map((response) => response.data), // ✅ No error! Type is guaranteed to be AxiosLikeResponse
    map((players) => {
      if (players) {
        return players.reduce((acc, player) => {
          return acc.set(player.playerSessionId, player);
        }, new Map<string, PlayerSessionDTO>());
      }
      return undefined;
    })
  );
}

// ==============================================
// SOLUTION 4: Cast to Expected Type (Less Safe)
// ==============================================

function solution4TypeCasting() {
  const httpService = new HttpService();
  
  httpService.get<PlayerSessionDTO[]>('/api/players').pipe(
    map((response) => {
      // ⚠️ Type assertion - use with caution
      const axiosResponse = response as AxiosLikeResponse<PlayerSessionDTO[]>;
      return axiosResponse.data;
    })
  );
}

// ==============================================
// RECOMMENDED APPROACH FOR YOUR CODE
// ==============================================

// Apply to your getAllPlayers method:
class YourService {
  private httpService = new HttpService();

  private async getAllPlayers(): Promise<Map<string, PlayerSessionDTO> | undefined> {
    const url = '/api/players';

    return await firstValueFrom(
      this.httpService.get<PlayerSessionDTO[]>(url).pipe(
        catchError((ex) => {
          console.error("Error while getting players");
          return of(undefined);
        }),
        retry({ count: 3, delay: 500 }),
        map((response) => {
          // ✅ Use type guard for safety
          if (response && isAxiosLikeResponse<PlayerSessionDTO[]>(response)) {
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
}

// ==============================================
// MODULE CONFIGURATION EXAMPLES
// ==============================================

// Example 1: Configure for axios compatibility (recommended)
/*
@Module({
  imports: [
    HttpModule.registerAxiosCompatible({
      // Your config
    }),
  ],
})
export class AppModule {}
*/

// Example 2: Use the AxiosCompatibleHttpService directly
/*
@Injectable()
export class YourService {
  constructor(
    @Inject(AXIOS_COMPATIBLE_HTTP_SERVICE) 
    private readonly httpService: AxiosCompatibleHttpService
  ) {}
  
  // Now httpService.get() always returns AxiosLikeResponse<T>
}
*/

// Helper functions for testing
function firstValueFrom<T>(obs: Observable<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    obs.subscribe({
      next: resolve,
      error: reject
    });
  });
}

function catchError<T>(handler: (error: any) => Observable<T>) {
  return (source: Observable<T>) => source;
}

function retry(config: { count: number; delay: number }) {
  return <T>(source: Observable<T>) => source;
}