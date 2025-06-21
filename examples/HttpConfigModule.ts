import * as http from "http";
import * as https from "https";

import { HttpModule, HttpService, HttpInterceptorRequest, HttpInterceptorHandler } from "nestjs-undici-interceptors";
import { DynamicModule, Global, Module, OnModuleInit } from "@nestjs/common";
import { context, propagation } from "@opentelemetry/api";
import { Observable } from "rxjs";

export type HttpConfig = {
  timeout?: number;
  maxRedirects?: number;
  keepAlive?: boolean;
  keepAliveMilliseconds?: number;
  maxSockets?: number;
  maxFreeSockets?: number;
};

@Global()
@Module({})
export class HttpConfigModule implements OnModuleInit {
  public static forRoot(config?: HttpConfig): DynamicModule {
    const httpModule = HttpModule.register({
      timeout: config?.timeout ?? 5000,
      maxRedirects: config?.maxRedirects ?? 5,
      httpAgent: new http.Agent({
        keepAlive: config?.keepAlive ?? true,
        // keepAliveMsecs: config?.keepAliveMilliseconds ?? 5000,
        // maxSockets: config?.maxSockets ?? 2000,
        // maxFreeSockets: config?.maxFreeSockets ?? 200,
      }),
      httpsAgent: new https.Agent({
        keepAlive: config?.keepAlive ?? true,
        // keepAliveMsecs: config?.keepAliveMilliseconds ?? 5000,
        // maxSockets: config?.maxSockets ?? 2000,
        // maxFreeSockets: config?.maxFreeSockets ?? 200,
      }),
    });

    return {
      module: HttpConfigModule,
      imports: [httpModule],
      exports: [httpModule],
    };
  }

  private readonly httpService: HttpService;

  constructor(httpService: HttpService) {
    this.httpService = httpService;
  }

  public onModuleInit() {
    // Add interceptor to inject OpenTelemetry trace context
    this.httpService.addInterceptor(
      (request: HttpInterceptorRequest, next: HttpInterceptorHandler): Observable<any> => {
        // Inject OpenTelemetry trace context into headers
        const traceHeaders: Record<string, string> = {};
        propagation.inject(context.active(), traceHeaders);

        // Merge trace headers with existing headers
        const updatedRequest: HttpInterceptorRequest = {
          ...request,
          options: {
            ...request.options,
            headers: {
              ...(request.options.headers as Record<string, string>),
              ...traceHeaders,
            },
          },
        };

        return next.handle(updatedRequest);
      }
    );
  }
}