import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  const port = Number(process.env.PORT) || 3008;
  await app.listen(port, '0.0.0.0');
  Logger.log(`🚀 Raw undici floor app running on: http://localhost:${port}/${globalPrefix}`);
  process.send?.('ready');
}

bootstrap();
