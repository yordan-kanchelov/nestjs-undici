import { Injectable, Inject } from '@nestjs/common';
import { HttpService } from '../src/modules/http/services/http.service';
import { AxiosCompatibleHttpService } from '../src/modules/http/services/http.service';
import { AXIOS_COMPATIBLE_HTTP_SERVICE } from '../src/modules/http/constants';
import { lastValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';

// ==============================================
// THE PROBLEM
// ==============================================

// When you use HttpModule.registerAxiosCompatible(), it provides AxiosCompatibleHttpService
// But if you inject HttpService, TypeScript doesn't know this!

@Injectable()
class ProblematicService {
  constructor(private httpService: HttpService) {}
  //                              ^^^^^^^^^^^ 
  // TypeScript thinks this is the base HttpService with union return type
  
  async getData() {
    const response = await lastValueFrom(
      this.httpService.get<any>('/api/data')
    );
    // ❌ TypeScript error: Property 'data' does not exist
    // return response.data;
  }
}

// ==============================================
// SOLUTION 1: Inject the Correct Service Type (RECOMMENDED)
// ==============================================

@Injectable()
class Solution1Service {
  // ✅ Tell TypeScript you're expecting AxiosCompatibleHttpService
  constructor(private httpService: AxiosCompatibleHttpService) {}
  
  async getData() {
    const response = await lastValueFrom(
      this.httpService.get<any>('/api/data')
    );
    return response.data; // ✅ No error! TypeScript knows it's AxiosLikeResponse
  }
}

// ==============================================
// SOLUTION 2: Use the Specific Injection Token
// ==============================================

@Injectable()
class Solution2Service {
  constructor(
    @Inject(AXIOS_COMPATIBLE_HTTP_SERVICE)
    private httpService: AxiosCompatibleHttpService
  ) {}
  
  async getData() {
    const response = await lastValueFrom(
      this.httpService.get<any>('/api/data')
    );
    return response.data; // ✅ Perfect type inference!
  }
}

// ==============================================
// SOLUTION 3: Type Assertion (Quick Fix)
// ==============================================

@Injectable()
class Solution3Service {
  constructor(private httpService: HttpService) {}
  
  async getData() {
    // Cast to the correct type
    const axiosService = this.httpService as AxiosCompatibleHttpService;
    
    const response = await lastValueFrom(
      axiosService.get<any>('/api/data')
    );
    return response.data; // ✅ Works with type assertion
  }
}

// ==============================================
// SOLUTION 4: Runtime Type Guard
// ==============================================

function isAxiosCompatibleService(service: any): service is AxiosCompatibleHttpService {
  return service.constructor.name === 'AxiosCompatibleHttpService';
}

@Injectable()
class Solution4Service {
  constructor(private httpService: HttpService) {}
  
  async getData() {
    if (isAxiosCompatibleService(this.httpService)) {
      const response = await lastValueFrom(
        this.httpService.get<any>('/api/data')
      );
      return response.data; // ✅ Type guard narrows the type
    }
    
    // Fallback for non-axios mode
    throw new Error('Service not in axios compatibility mode');
  }
}

// ==============================================
// SOLUTION 5: Module-Level Type Configuration
// ==============================================

// Create a typed module wrapper
export class TypedHttpModule {
  static registerAxiosCompatible(options?: any) {
    return {
      module: HttpModule,
      imports: [HttpModule.registerAxiosCompatible(options)],
      providers: [
        {
          provide: HttpService,
          useClass: AxiosCompatibleHttpService,
        },
      ],
      exports: [HttpService],
    };
  }
}

// Then in your module:
/*
@Module({
  imports: [TypedHttpModule.registerAxiosCompatible()],
  providers: [MyService],
})
export class AppModule {}
*/

// Now you can inject HttpService but tell TypeScript it's AxiosCompatibleHttpService:
@Injectable()
class Solution5Service {
  constructor(private httpService: HttpService) {}
  
  async getData() {
    // Use type assertion at the module level
    const service = this.httpService as AxiosCompatibleHttpService;
    const response = await lastValueFrom(service.get<any>('/api/data'));
    return response.data; // ✅ Works!
  }
}

// ==============================================
// ADVANCED: Conditional Types
// ==============================================

// Create a conditional type helper
type HttpServiceType<T> = T extends { axiosCompatible: true }
  ? AxiosCompatibleHttpService
  : HttpService;

// Use in a service with configuration
interface ServiceConfig {
  axiosCompatible?: boolean;
}

@Injectable()
class ConditionalService<TConfig extends ServiceConfig = { axiosCompatible: false }> {
  constructor(
    private httpService: HttpServiceType<TConfig>
  ) {}
  
  // Methods would use conditional types based on TConfig
}

// ==============================================
// BEST PRACTICE RECOMMENDATION
// ==============================================

/*
The cleanest approach is Solution 1 or 2:

1. When using axios compatibility mode, inject AxiosCompatibleHttpService directly:
   constructor(private httpService: AxiosCompatibleHttpService) {}

2. Or use the specific injection token:
   constructor(@Inject(AXIOS_COMPATIBLE_HTTP_SERVICE) private httpService: AxiosCompatibleHttpService) {}

This makes your code's intent clear and provides full type safety.

If you need to support both modes dynamically, use a factory pattern:
*/

@Injectable()
class FlexibleService {
  private axiosService?: AxiosCompatibleHttpService;
  
  constructor(
    private httpService: HttpService,
    @Inject(AXIOS_COMPATIBLE_HTTP_SERVICE) @Optional()
    axiosCompatibleService?: AxiosCompatibleHttpService
  ) {
    this.axiosService = axiosCompatibleService;
  }
  
  async getData() {
    if (this.axiosService) {
      // Using axios compatible mode
      const response = await lastValueFrom(this.axiosService.get<any>('/api/data'));
      return response.data;
    } else {
      // Using native mode
      const response = await lastValueFrom(this.httpService.get<any>('/api/data'));
      if ('data' in response) {
        return response.data;
      }
      // Handle native response
      return undefined;
    }
  }
}

// ==============================================
// FOR YOUR SPECIFIC CODE
// ==============================================

interface PlayerSessionDTO {
  playerSessionId: string;
  name: string;
}

@Injectable()
export class PlayerService {
  constructor(
    // ✅ Simply change the type declaration!
    private readonly httpService: AxiosCompatibleHttpService,
    private readonly logger: any,
    private readonly metricService: any,
  ) {}

  private async getAllPlayers(): Promise<Map<string, PlayerSessionDTO> | undefined> {
    const url = '/api/players';

    return await lastValueFrom(
      this.httpService.get<PlayerSessionDTO[]>(url).pipe(
        catchError((ex) => {
          this.logger.error("Error while getting players");
          return of(undefined);
        }),
        retry({ count: 3, delay: 500 }),
        map((response) => response?.data), // ✅ No type error!
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

// Make sure your module uses axios compatible mode:
/*
@Module({
  imports: [
    HttpModule.registerAxiosCompatible({
      timeout: 5000,
      headers: {
        'User-Agent': 'Your-App',
      },
    }),
  ],
  providers: [PlayerService],
})
export class PlayerModule {}
*/

import { Optional } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { catchError, retry } from 'rxjs/operators';