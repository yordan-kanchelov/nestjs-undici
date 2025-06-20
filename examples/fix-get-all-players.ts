import { Injectable, Inject } from '@nestjs/common';
import { HttpService } from '../src/modules/http/services/http.service';
import { AxiosCompatibleHttpService } from '../src/modules/http/services/http.service';
import { AXIOS_COMPATIBLE_HTTP_SERVICE } from '../src/modules/http/constants';
import { firstValueFrom, of } from 'rxjs';
import { catchError, retry, map } from 'rxjs/operators';
import { AxiosLikeResponse } from '../src/modules/http/interfaces/axios-compatible.interface';
import urlJoin from 'url-join';

interface PlayerSessionDTO {
  playerSessionId: string;
  name: string;
  // ... other properties
}

// ==============================================
// OPTION 1: Fix with Type Guard (Minimal Change)
// ==============================================
@Injectable()
export class PlayerServiceWithTypeGuard {
  constructor(
    private readonly httpService: HttpService,
    private readonly logger: any,
    private readonly metricService: any,
  ) {}

  private servicesConfig = {
    PLAYER_GAME_SETUP_URL: 'https://api.example.com',
    GIN: 'test-gin'
  };

  private isAxiosLikeResponse<T>(response: any): response is AxiosLikeResponse<T> {
    return response && 'data' in response;
  }

  private async getAllPlayers(): Promise<Map<string, PlayerSessionDTO> | undefined> {
    const PLAYER_SESSION_PATH = '/players';
    const url: string = urlJoin(
      this.servicesConfig.PLAYER_GAME_SETUP_URL,
      PLAYER_SESSION_PATH,
      `?gin=${this.servicesConfig.GIN}`,
    );

    return await firstValueFrom(
      this.httpService.get<PlayerSessionDTO[]>(url).pipe(
        catchError((ex) => {
          this.logger.error(() => "Error while getting players from [Player Setup service]");
          // catchUnknownError(ex, this.logger, this.metricService);
          return of(undefined);
        }),
        retry({ count: 3, delay: 500 }),
        map((response) => {
          // ✅ Fix: Use type guard to safely access data
          if (response && this.isAxiosLikeResponse<PlayerSessionDTO[]>(response)) {
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
// OPTION 2: Use Axios Compatible Service (Recommended)
// ==============================================
@Injectable()
export class PlayerServiceAxiosCompatible {
  constructor(
    @Inject(AXIOS_COMPATIBLE_HTTP_SERVICE)
    private readonly httpService: AxiosCompatibleHttpService,
    private readonly logger: any,
    private readonly metricService: any,
  ) {}

  private servicesConfig = {
    PLAYER_GAME_SETUP_URL: 'https://api.example.com',
    GIN: 'test-gin'
  };

  private async getAllPlayers(): Promise<Map<string, PlayerSessionDTO> | undefined> {
    const PLAYER_SESSION_PATH = '/players';
    const url: string = urlJoin(
      this.servicesConfig.PLAYER_GAME_SETUP_URL,
      PLAYER_SESSION_PATH,
      `?gin=${this.servicesConfig.GIN}`,
    );

    return await firstValueFrom(
      this.httpService.get<PlayerSessionDTO[]>(url).pipe(
        catchError((ex) => {
          this.logger.error(() => "Error while getting players from [Player Setup service]");
          // catchUnknownError(ex, this.logger, this.metricService);
          return of(undefined);
        }),
        retry({ count: 3, delay: 500 }),
        map((response) => response?.data), // ✅ No type error! Always AxiosLikeResponse
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
// OPTION 3: Create a Helper Method
// ==============================================
@Injectable()
export class PlayerServiceWithHelper {
  constructor(
    private readonly httpService: HttpService,
    private readonly logger: any,
    private readonly metricService: any,
  ) {}

  private servicesConfig = {
    PLAYER_GAME_SETUP_URL: 'https://api.example.com',
    GIN: 'test-gin'
  };

  // Helper method to extract data safely
  private extractResponseData<T>(response: any): T | undefined {
    if (!response) return undefined;
    
    // Check if it's an axios-like response
    if ('data' in response) {
      return response.data;
    }
    
    // Handle native undici response (would need actual parsing logic)
    if ('body' in response && response.statusCode === 200) {
      try {
        // This is simplified - actual implementation would depend on response type
        return JSON.parse(response.body.toString());
      } catch {
        return undefined;
      }
    }
    
    return undefined;
  }

  private async getAllPlayers(): Promise<Map<string, PlayerSessionDTO> | undefined> {
    const PLAYER_SESSION_PATH = '/players';
    const url: string = urlJoin(
      this.servicesConfig.PLAYER_GAME_SETUP_URL,
      PLAYER_SESSION_PATH,
      `?gin=${this.servicesConfig.GIN}`,
    );

    return await firstValueFrom(
      this.httpService.get<PlayerSessionDTO[]>(url).pipe(
        catchError((ex) => {
          this.logger.error(() => "Error while getting players from [Player Setup service]");
          // catchUnknownError(ex, this.logger, this.metricService);
          return of(undefined);
        }),
        retry({ count: 3, delay: 500 }),
        map((response) => this.extractResponseData<PlayerSessionDTO[]>(response)), // ✅ Clean helper
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
// MODULE CONFIGURATION
// ==============================================

// To use Option 2 (Axios Compatible), configure your module like this:
/*
import { Module } from '@nestjs/common';
import { HttpModule } from 'nestjs-undici-interceptors';

@Module({
  imports: [
    HttpModule.registerAxiosCompatible({
      // Your configuration
      timeout: 5000,
      headers: {
        'User-Agent': 'Your-App',
      },
    }),
  ],
  providers: [PlayerServiceAxiosCompatible],
})
export class PlayerModule {}
*/

// Or use the register method for more control:
/*
@Module({
  imports: [
    HttpModule.register({
      // Your configuration
      interceptors: [
        // Add the axios response adapter manually if needed
        new AxiosResponseAdapterInterceptor(),
      ],
    }),
  ],
  providers: [PlayerServiceWithTypeGuard],
})
export class PlayerModule {}
*/