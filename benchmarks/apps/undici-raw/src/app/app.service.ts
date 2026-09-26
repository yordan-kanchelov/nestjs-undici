import { Injectable } from '@nestjs/common';
import { request } from 'undici';

// The floor: no HttpModule/HttpService at all, just undici directly. Shows how
// much of the gap between the two HttpService rows is the Nest wrapper versus
// the HTTP client underneath it.
@Injectable()
export class AppService {
  async getData(): Promise<{ data: unknown[]; duration: number; timestamp: string }> {
    const mockServiceUrl = process.env.MOCK_SERVICE_URL || 'http://localhost:3001/api/data';

    const requests = Array.from({ length: 5 }, async () => {
      const res = await request(mockServiceUrl);
      return res.body.json();
    });

    const startTime = Date.now();
    const results = await Promise.all(requests);
    const endTime = Date.now();

    return {
      data: results,
      duration: endTime - startTime,
      timestamp: new Date().toISOString(),
    };
  }
}
