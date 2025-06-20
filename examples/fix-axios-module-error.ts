import { Module, DynamicModule } from '@nestjs/common';
import { HttpModule } from '../src/modules/http/http.module';
import { HttpService } from '../src/modules/http/services/http.service';
import { AxiosCompatibleHttpService } from '../src/modules/http/services/http.service';
import * as http from 'http';
import * as https from 'https';

// ==============================================
// THE PROBLEM
// ==============================================

// ❌ This will cause the error you're seeing:
@Module({})
class ProblematicHttpConfigModule {
  static forRoot(config?: any): DynamicModule {
    return {
      module: ProblematicHttpConfigModule,
      imports: [
        HttpModule.register({  // ← Using register() provides HttpService
          timeout: config?.timeout ?? 5000,
        }),
      ],
      providers: [
        // Some service that tries to inject AxiosCompatibleHttpService
        {
          provide: 'SOME_SERVICE',
          useFactory: (httpService: AxiosCompatibleHttpService) => { // ❌ ERROR!
            // AxiosCompatibleHttpService is not provided by HttpModule.register()
            return httpService;
          },
          inject: [AxiosCompatibleHttpService], // ❌ Not available!
        },
      ],
    };
  }
}

// ==============================================
// SOLUTION 1: Use registerAxiosCompatible() (RECOMMENDED)
// ==============================================

@Module({})
export class FixedHttpConfigModule {
  static forRoot(config?: any): DynamicModule {
    return {
      module: FixedHttpConfigModule,
      imports: [
        // ✅ Use registerAxiosCompatible instead
        HttpModule.registerAxiosCompatible({
          timeout: config?.timeout ?? 5000,
          maxRedirects: config?.maxRedirects ?? 5,
          httpAgent: new http.Agent({
            keepAlive: config?.keepAlive ?? true,
          }),
          httpsAgent: new https.Agent({
            keepAlive: config?.keepAlive ?? true,
          }),
        }),
      ],
      exports: [HttpModule],
    };
  }
}

// Now services can inject either HttpService or AxiosCompatibleHttpService:
@Injectable()
class ServiceUsingAxiosMode {
  constructor(
    // ✅ Both of these will work:
    private httpService: HttpService,  // Works - it's actually AxiosCompatibleHttpService
    // OR
    private axiosService: AxiosCompatibleHttpService  // Also works!
  ) {}
}

// ==============================================
// SOLUTION 2: Inject HttpService Instead
// ==============================================

@Module({})
export class AlternativeHttpConfigModule {
  static forRoot(config?: any): DynamicModule {
    return {
      module: AlternativeHttpConfigModule,
      imports: [
        HttpModule.register({  // Regular register()
          timeout: config?.timeout ?? 5000,
        }),
      ],
      providers: [
        {
          provide: 'HTTP_CONFIG_SERVICE',
          useFactory: (httpService: HttpService) => { // ✅ Use HttpService
            // Work with the base HttpService
            return {
              httpService,
              makeRequest: (url: string) => httpService.get(url),
            };
          },
          inject: [HttpService], // ✅ This is available
        },
      ],
      exports: [HttpModule, 'HTTP_CONFIG_SERVICE'],
    };
  }
}

// ==============================================
// SOLUTION 3: Manual Provider Setup
// ==============================================

@Module({})
export class ManualAxiosCompatibleModule {
  static forRoot(config?: any): DynamicModule {
    const httpModule = HttpModule.register({
      timeout: config?.timeout ?? 5000,
    });

    return {
      module: ManualAxiosCompatibleModule,
      imports: [httpModule],
      providers: [
        // Manually provide AxiosCompatibleHttpService
        {
          provide: AxiosCompatibleHttpService,
          useFactory: () => {
            // Create instance with interceptors
            const service = new AxiosCompatibleHttpService(
              {} as any, // Undici instance
              { interceptors: [] }, // Options
            );
            return service;
          },
        },
      ],
      exports: [httpModule, AxiosCompatibleHttpService],
    };
  }
}

// ==============================================
// SOLUTION 4: Type-Safe Module Pattern
// ==============================================

// Create a wrapper that ensures type safety
@Module({})
export class TypeSafeHttpModule {
  // For axios compatibility mode
  static forRootAxios(config?: any): DynamicModule {
    return {
      module: TypeSafeHttpModule,
      imports: [
        HttpModule.registerAxiosCompatible(config),
      ],
      exports: [HttpModule],
    };
  }

  // For native mode
  static forRootNative(config?: any): DynamicModule {
    return {
      module: TypeSafeHttpModule,
      imports: [
        HttpModule.register(config),
      ],
      exports: [HttpModule],
    };
  }
}

// ==============================================
// COMPLETE WORKING EXAMPLE
// ==============================================

// Your app module:
@Module({
  imports: [
    // Choose one:
    FixedHttpConfigModule.forRoot({ timeout: 10000 }), // Axios compatible
    // OR
    TypeSafeHttpModule.forRootAxios({ timeout: 10000 }), // Explicit axios mode
  ],
  providers: [PlayerService],
})
export class AppModule {}

// Your service:
@Injectable()
export class PlayerService {
  constructor(
    // When using axios compatible mode, you can inject either:
    private httpService: HttpService,  // This works (it's actually AxiosCompatibleHttpService)
    // OR be explicit:
    private axiosService: AxiosCompatibleHttpService  // This also works
  ) {}

  async getAllPlayers() {
    // With axios compatible mode, this always works:
    const response = await lastValueFrom(
      this.httpService.get('/api/players')
    );
    return response.data; // ✅ No type error in axios mode
  }
}

// ==============================================
// DEBUGGING TIPS
// ==============================================

/*
If you're still getting the error:

1. Check your module imports:
   - Are you using HttpModule.registerAxiosCompatible()?
   - Or are you using HttpModule.register()?

2. Check your injections:
   - If using register(), inject HttpService
   - If using registerAxiosCompatible(), you can inject either HttpService or AxiosCompatibleHttpService

3. Check the module hierarchy:
   - Make sure HttpModule is imported in the same module where you're trying to inject the service
   - Or export it from the parent module

4. Debug the providers:
   console.log(module.providers); // See what's actually provided
*/

import { Injectable } from '@nestjs/common';
import { lastValueFrom } from 'rxjs';