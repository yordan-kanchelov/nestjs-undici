// Picks the HTTP client package by `CLIENT=axios|undici` (set by docker-compose,
// k6-scripts, or benchmarks/e2e/run.js). app.module.ts and app.service.ts import
// `HttpModule`/`HttpService` from here and are otherwise identical for both clients -
// "change one import" is literally the only difference between the two apps.
const client = process.env.CLIENT === 'undici' ? require('nestjs-axios-undici') : require('@nestjs/axios');

export const HttpModule = client.HttpModule as typeof import('@nestjs/axios').HttpModule;
export const HttpService = client.HttpService as typeof import('@nestjs/axios').HttpService;
// eslint-disable-next-line @typescript-eslint/no-redeclare -- value + instance type, same name (like a class import)
export type HttpService = InstanceType<typeof HttpService>;
