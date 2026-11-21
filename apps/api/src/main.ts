// UNVERIFIED (NestJS not installable in the authoring environment).
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module.ts';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.use(helmet());
  app.useBodyParser('json', { limit: '12mb' });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(','), credentials: true });
  app.set('trust proxy', 1);
  await app.listen(Number(process.env.API_PORT ?? 4000), '0.0.0.0');
}
void bootstrap();
