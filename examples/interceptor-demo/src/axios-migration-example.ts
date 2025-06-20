import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
import { lastValueFrom } from 'rxjs';
import { map, catchError, retry } from 'rxjs/operators';
import { of } from 'rxjs';

// Example DTO
interface GinPortalConfigDTO {
  id: string;
  name: string;
  status: 'active' | 'inactive';
}

/**
 * This example shows how existing Axios code works without ANY changes
 * in v0.4.0+ (axios-compatible responses are now the default)
 */
@Injectable()
export class ConfigService {
  private readonly activateConfigPath = 'https://jsonplaceholder.typicode.com/posts';
  private readonly logger = console;

  constructor(private readonly httpService: HttpService) {}

  /**
   * This method uses the EXACT SAME CODE that would work with @nestjs/axios
   * In v0.4.0+, no special configuration needed - it just works!
   */
  async activateConfigs(): Promise<GinPortalConfigDTO[] | undefined> {
    this.logger.log("Activate configs on IDLE state");

    return await lastValueFrom(
      this.httpService.post<GinPortalConfigDTO[]>(this.activateConfigPath, null).pipe(
        catchError((ex) => {
          this.logger.error(
            `Failed to activate configs: ${ex instanceof Error ? ex.message : JSON.stringify(ex)}`,
          );
          // In real app: catchUnknownError(ex, this.logger, this.metricService);
          return of(undefined);
        }),
        retry({ count: 3, delay: 500 }),
        map((response: any) => response?.data), // 👈 Works exactly like Axios!
      ),
    );
  }

  /**
   * Another example showing GET request with type safety
   */
  async getConfig(id: string): Promise<GinPortalConfigDTO | undefined> {
    try {
      const response = await lastValueFrom(
        this.httpService.get<GinPortalConfigDTO>(`${this.activateConfigPath}/${id}`)
      );
      
      // Axios-style response structure
      console.log('Status:', response.status);        // 200
      console.log('Status Text:', response.statusText); // "OK"  
      console.log('Headers:', response.headers);
      console.log('Data:', response.data);             // Parsed JSON data
      
      return response.data;
    } catch (error) {
      this.logger.error('Failed to get config:', error);
      return undefined;
    }
  }
}

@Module({
  imports: [
    // In v0.4.0+, all responses are axios-compatible
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 5,
    }),
  ],
  providers: [ConfigService],
})
export class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  console.log('\n🚀 Testing Axios-compatible mode...\n');

  // Test POST request (returns array in this example)
  const configs = await configService.activateConfigs();
  console.log('Activated configs:', configs?.length);

  // Test GET request
  const singleConfig = await configService.getConfig('1');
  console.log('Single config:', singleConfig);

  await app.close();
}

bootstrap().catch(console.error);