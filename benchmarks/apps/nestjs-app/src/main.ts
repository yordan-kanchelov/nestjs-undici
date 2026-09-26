import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app/app.module';

// One app source for every benchmark row: `PLATFORM=express|fastify` picks the
// server, `CLIENT=axios|undici` (read by app/client.ts) picks the HTTP client,
// and `INTERCEPTOR=1` (read by app/app.service.ts) adds the shared axiosRef
// interceptor. Started by docker-compose, k6-scripts, or benchmarks/e2e/run.js.
async function bootstrap() {
  const platform = process.env.PLATFORM === 'fastify' ? 'fastify' : 'express';
  const app =
    platform === 'fastify'
      ? await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())
      : await NestFactory.create(AppModule);

  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  const port = Number(process.env.PORT) || 3002;
  await app.listen(port, '0.0.0.0');

  const client = process.env.CLIENT === 'undici' ? 'nestjs-axios-undici' : '@nestjs/axios';
  const interceptor = process.env.INTERCEPTOR === '1' ? ' + interceptor' : '';
  Logger.log(`🚀 ${platform} + ${client}${interceptor} running on: http://localhost:${port}/${globalPrefix}`);

  // Lets an orchestrator (benchmarks/e2e/run.js) know the app is ready without polling.
  process.send?.('ready');
}

bootstrap();
