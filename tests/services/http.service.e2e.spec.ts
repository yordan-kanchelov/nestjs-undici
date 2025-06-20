import { Test, TestingModule } from '@nestjs/testing';
import { UNDICI_PACKAGE_JSON } from '../../src/shared/constants/URL';
import { HttpModule, HttpService } from '../../src';

describe('HttpService', () => {
    let service: HttpService;
    let baseURL: string;

    beforeAll(async () => {
        const module: TestingModule = await Test.createTestingModule({
            imports: [HttpModule.register({})], // Default is now axios-compatible
        }).compile();

        service = module.get<HttpService>(HttpService);
        baseURL = UNDICI_PACKAGE_JSON.href;
    });

    it('GET', () => {
        const result = service.request(baseURL, {
            method: 'GET',
        });

        result.subscribe(response => {
            expect(response?.status).toBe(200); // axios-compatible property
        });
    });
});
