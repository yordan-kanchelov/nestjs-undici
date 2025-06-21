import { Test, TestingModule } from '@nestjs/testing';
import { Injectable, Module, DynamicModule, Global, OnModuleInit } from '@nestjs/common';
import { HttpModule, HttpService } from '../src';
import * as http from 'http';
import * as https from 'https';

describe('Multiple HttpModule Imports Issue', () => {
  it('should handle multiple HttpModule imports in the same app', async () => {
    // First module that uses HttpModule
    @Module({
      imports: [HttpModule.register({ timeout: 1000 })],
      providers: [{
        provide: 'SERVICE_A',
        useFactory: (httpService: HttpService) => ({ name: 'A', httpService }),
        inject: [HttpService],
      }],
      exports: ['SERVICE_A'],
    })
    class ModuleA {}

    // Second module that uses HttpModule
    @Module({
      imports: [HttpModule.register({ timeout: 2000 })],
      providers: [{
        provide: 'SERVICE_B',
        useFactory: (httpService: HttpService) => ({ name: 'B', httpService }),
        inject: [HttpService],
      }],
      exports: ['SERVICE_B'],
    })
    class ModuleB {}

    // HttpConfigModule that also uses HttpModule
    @Global()
    @Module({})
    class HttpConfigModule implements OnModuleInit {
      public static forRoot(): DynamicModule {
        const httpModule = HttpModule.register({
          timeout: 5000,
          maxRedirects: 5,
          httpAgent: new http.Agent({ keepAlive: true }),
          httpsAgent: new https.Agent({ keepAlive: true }),
        });

        return {
          module: HttpConfigModule,
          imports: [httpModule],
          exports: [httpModule],
        };
      }

      constructor(private readonly httpService: HttpService) {}

      public onModuleInit() {
        console.log('HttpConfigModule initialized');
      }
    }

    // App module that imports all of them
    @Module({
      imports: [
        HttpConfigModule.forRoot(),
        ModuleA,
        ModuleB,
      ],
    })
    class AppModule {}

    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    await module.init();

    const serviceA = module.get('SERVICE_A');
    const serviceB = module.get('SERVICE_B');
    
    expect(serviceA).toBeDefined();
    expect(serviceB).toBeDefined();
    expect(serviceA.httpService).toBeInstanceOf(HttpService);
    expect(serviceB.httpService).toBeInstanceOf(HttpService);

    await module.close();
  });

  it('should reproduce the UNDICI_INSTANCE_TOKEN error', async () => {
    // Try to create a scenario that causes the error
    @Module({
      imports: [HttpModule], // Import the module class directly
      providers: [{
        provide: 'BROKEN_SERVICE',
        useFactory: (httpService: HttpService) => ({ httpService }),
        inject: [HttpService],
      }],
    })
    class BrokenModule {}

    try {
      const module = await Test.createTestingModule({
        imports: [BrokenModule],
      }).compile();
      
      await module.close();
      console.log('No error - this pattern works');
    } catch (error) {
      console.log('Error reproduced:', error.message);
      expect(error.message).toContain('UNDICI_INSTANCE_TOKEN');
    }
  });

  it('should test HttpModule import without register()', async () => {
    // This might be the issue - importing HttpModule without calling register()
    @Global()
    @Module({})
    class ConfigModule {
      static forRoot(): DynamicModule {
        return {
          module: ConfigModule,
          imports: [HttpModule], // Importing the class without register()
          exports: [HttpModule],
        };
      }
    }

    try {
      const module = await Test.createTestingModule({
        imports: [ConfigModule.forRoot()],
      }).compile();
      
      // Try to get HttpService
      const httpService = module.get(HttpService);
      console.log('HttpService retrieved:', !!httpService);
      
      await module.close();
    } catch (error) {
      console.log('Error with bare HttpModule import:', error.message);
    }
  });
});