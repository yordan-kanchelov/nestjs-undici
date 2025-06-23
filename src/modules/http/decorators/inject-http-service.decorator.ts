import { Inject } from '@nestjs/common';
import { HttpService } from '../services/http.service';

/**
 * Type-safe decorator for injecting HttpService
 * 
 * Usage:
 * ```typescript
 * constructor(@InjectHttpService() private httpService: HttpService) {}
 * // or for axios compatibility:
 * constructor(@InjectHttpService() private httpService: AxiosCompatibleHttpService) {}
 * ```
 */
export const InjectHttpService = () => Inject(HttpService);