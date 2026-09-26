// Type-level consumer check, compiled by check-types.mjs as consumer-types.cts (CommonJS)
// and consumer-types.mts (ESM) against the installed tarball.
import { Injectable, Module } from '@nestjs/common';
import { firstValueFrom, map, Observable } from 'rxjs';
import {
  AxiosError,
  HttpInterceptor,
  HttpInterceptorHandler,
  HttpInterceptorRequest,
  HttpModule,
  HttpModuleOptions,
  HttpModuleOptionsFactory,
  HttpService,
  isAxiosError,
} from 'nestjs-axios-undici';

interface User {
  id: number;
  name: string;
}

@Injectable()
class AuthInterceptor implements HttpInterceptor {
  intercept(request: HttpInterceptorRequest, next: HttpInterceptorHandler) {
    return next.handle(request);
  }
}

@Injectable()
class OptionsFactory implements HttpModuleOptionsFactory {
  createHttpOptions(): HttpModuleOptions {
    return {
      baseURL: 'http://x',
      timeout: 1000,
      interceptors: [AuthInterceptor],
    };
  }
}

@Module({
  imports: [
    HttpModule.register({ baseURL: 'http://x', maxRedirects: 5 }),
    HttpModule.registerAsync({ useClass: OptionsFactory }),
    HttpModule.registerAsync({
      useFactory: async () => ({ baseURL: 'http://x' }),
      inject: [],
    }),
  ],
})
export class AppModule {}

@Injectable()
export class UsersClient {
  constructor(private readonly http: HttpService) {}

  list(): Observable<User[]> {
    return this.http.get<User[]>('/users').pipe(map(response => response.data));
  }

  async run(): Promise<number> {
    const response = await firstValueFrom(
      this.http.get<User>('/a', { params: { q: 1 }, timeout: 5 }),
    );
    const id: number = response.data.id;
    const status: number = response.status;
    this.http.axiosRef.interceptors.request.use(config => config);
    await this.http.axiosRef.post<{ ok: boolean }>('/b', { a: 1 });
    try {
      await firstValueFrom(this.http.post('/c', {}));
    } catch (error) {
      if (isAxiosError(error)) {
        const code: string | undefined = error.code;
        void code;
      }
      if (error instanceof AxiosError) void error.response?.status;
    }
    return id + status;
  }

  // Guards against the package's types silently resolving to `any`
  async notAny(): Promise<void> {
    const response = await firstValueFrom(this.http.get<User>('/a'));
    // @ts-expect-error -- User['name'] is a string
    const name: number = response.data.name;
    // @ts-expect-error -- HttpService has no such method
    this.http.fetchEverything();
    void name;
  }
}
