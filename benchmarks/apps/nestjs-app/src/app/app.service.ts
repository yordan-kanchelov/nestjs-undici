import { Injectable, OnModuleInit } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { HttpService } from './client';

interface RequestConfigWithMetadata {
  metadata?: { start: number };
  headers?: Record<string, string>;
}

@Injectable()
export class AppService implements OnModuleInit {
  constructor(private readonly httpService: HttpService) {}

  onModuleInit() {
    if (process.env.INTERCEPTOR !== '1') return;

    // Same axiosRef request + response interceptor for both clients: adds a
    // header and times the call. No stdout logging - that would dominate the
    // measurement instead of the client itself (see plan/reports/docs-critic.md).
    this.httpService.axiosRef.interceptors.request.use((config: RequestConfigWithMetadata) => {
      config.metadata = { start: Date.now() };
      config.headers = { ...config.headers, 'x-request-start': String(Date.now()) };
      return config as never;
    });
    this.httpService.axiosRef.interceptors.response.use((response) => {
      const start = (response.config as RequestConfigWithMetadata).metadata?.start ?? Date.now();
      response.headers['x-duration'] = String(Date.now() - start);
      return response;
    });
  }

  async getData(): Promise<{ data: unknown[]; duration: number; timestamp: string }> {
    const mockServiceUrl = process.env.MOCK_SERVICE_URL || 'http://localhost:3001/api/data';

    const requests = Array.from({ length: 5 }, () => firstValueFrom(this.httpService.get(mockServiceUrl)));

    const startTime = Date.now();
    const results = await Promise.all(requests);
    const endTime = Date.now();

    return {
      data: results.map((res) => res.data),
      duration: endTime - startTime,
      timestamp: new Date().toISOString(),
    };
  }
}
