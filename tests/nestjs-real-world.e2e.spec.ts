import { Test, TestingModule } from '@nestjs/testing';
import { Injectable, Module, Controller, Get } from '@nestjs/common';
import { HttpModule, HttpService } from '../src';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

describe('Real-world NestJS Integration', () => {
  it('should work in a typical NestJS application structure', async () => {
    // API Service that uses HttpService
    @Injectable()
    class ApiService {
      constructor(private readonly httpService: HttpService) {}

      fetchData(url: string): Observable<any> {
        return this.httpService.get(url).pipe(
          map(response => response.data)
        );
      }
    }

    // Controller that uses the API Service
    @Controller('test')
    class TestController {
      constructor(private readonly apiService: ApiService) {}

      @Get()
      async getData() {
        return this.apiService.fetchData('https://api.example.com/data');
      }
    }

    // Feature module
    @Module({
      imports: [HttpModule.register({ timeout: 5000 })],
      controllers: [TestController],
      providers: [ApiService],
    })
    class FeatureModule {}

    // App module
    @Module({
      imports: [FeatureModule],
    })
    class AppModule {}

    // This should compile without the UnknownDependenciesException
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const apiService = module.get<ApiService>(ApiService);
    const httpService = module.get<HttpService>(HttpService);
    const controller = module.get<TestController>(TestController);

    expect(apiService).toBeDefined();
    expect(httpService).toBeDefined();
    expect(controller).toBeDefined();
  });

  it('should work with shared HttpModule configuration', async () => {
    // Shared HTTP module with common configuration
    @Module({
      imports: [
        HttpModule.register({
          timeout: 10000,
          headers: {
            'User-Agent': 'MyApp/1.0',
          },
        }),
      ],
      exports: [HttpModule],
    })
    class SharedHttpModule {}

    @Injectable()
    class UserService {
      constructor(private readonly httpService: HttpService) {}

      getUser(id: string) {
        return this.httpService.get(`/users/${id}`);
      }
    }

    @Injectable()
    class PostService {
      constructor(private readonly httpService: HttpService) {}

      getPosts() {
        return this.httpService.get('/posts');
      }
    }

    @Module({
      imports: [SharedHttpModule],
      providers: [UserService],
      exports: [UserService],
    })
    class UserModule {}

    @Module({
      imports: [SharedHttpModule],
      providers: [PostService],
      exports: [PostService],
    })
    class PostModule {}

    @Module({
      imports: [UserModule, PostModule],
    })
    class AppModule {}

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const userService = module.get<UserService>(UserService);
    const postService = module.get<PostService>(PostService);

    expect(userService).toBeDefined();
    expect(postService).toBeDefined();
  });

  it('should work with async configuration from ConfigService', async () => {
    @Injectable()
    class ConfigService {
      getHttpConfig() {
        return {
          timeout: 15000,
          baseURL: 'https://api.example.com',
        };
      }
    }

    @Module({
      providers: [ConfigService],
      exports: [ConfigService],
    })
    class ConfigModule {}

    @Injectable()
    class DataService {
      constructor(private readonly httpService: HttpService) {}

      fetchResource(path: string) {
        return this.httpService.get(path);
      }
    }

    @Module({
      imports: [
        ConfigModule,
        HttpModule.registerAsync({
          imports: [ConfigModule],
          useFactory: (configService: ConfigService) => configService.getHttpConfig(),
          inject: [ConfigService],
        }),
      ],
      providers: [DataService],
    })
    class AppModule {}

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const dataService = module.get<DataService>(DataService);
    const httpService = module.get<HttpService>(HttpService);

    expect(dataService).toBeDefined();
    expect(httpService).toBeDefined();
  });

  it('should work with multiple module imports without conflicts', async () => {
    // First API module with its own HTTP configuration
    @Module({
      imports: [HttpModule.register({ timeout: 3000 })],
      providers: [
        {
          provide: 'API1_SERVICE',
          useFactory: (httpService: HttpService) => ({
            fetch: () => httpService.get('/api1/data'),
          }),
          inject: [HttpService],
        },
      ],
      exports: ['API1_SERVICE'],
    })
    class Api1Module {}

    // Second API module with different HTTP configuration
    @Module({
      imports: [HttpModule.register({ timeout: 5000 })],
      providers: [
        {
          provide: 'API2_SERVICE',
          useFactory: (httpService: HttpService) => ({
            fetch: () => httpService.get('/api2/data'),
          }),
          inject: [HttpService],
        },
      ],
      exports: ['API2_SERVICE'],
    })
    class Api2Module {}

    @Module({
      imports: [Api1Module, Api2Module],
    })
    class AppModule {}

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const api1Service = module.get('API1_SERVICE');
    const api2Service = module.get('API2_SERVICE');

    expect(api1Service).toBeDefined();
    expect(api2Service).toBeDefined();
  });

  it('should handle axios-compatible configuration in a real app', async () => {
    // Using axios-style configuration
    const axiosConfig = {
      baseURL: 'https://jsonplaceholder.typicode.com',
      timeout: 5000,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      maxRedirects: 5,
      validateStatus: (status: number) => status < 500,
    };

    @Injectable()
    class JsonPlaceholderService {
      constructor(private readonly httpService: HttpService) {}

      getUsers() {
        return this.httpService.get('/users');
      }

      getUser(id: number) {
        return this.httpService.get(`/users/${id}`);
      }

      createUser(data: any) {
        return this.httpService.post('/users', data);
      }
    }

    @Module({
      imports: [HttpModule.register(axiosConfig)],
      providers: [JsonPlaceholderService],
      exports: [JsonPlaceholderService],
    })
    class JsonPlaceholderModule {}

    const module: TestingModule = await Test.createTestingModule({
      imports: [JsonPlaceholderModule],
    }).compile();

    const service = module.get<JsonPlaceholderService>(JsonPlaceholderService);
    expect(service).toBeDefined();

    // Verify the service can use all HTTP methods
    expect(service.getUsers).toBeDefined();
    expect(service.getUser).toBeDefined();
    expect(service.createUser).toBeDefined();
  });
});