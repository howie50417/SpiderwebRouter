import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cors from '@fastify/cors';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { loadRuntimeConfig } from './config/runtime-config';
import { fastifyLoggerOptions, appLogger } from './common/logger';
import { SafeExceptionFilter } from './common/exception.filter';
import { OpenApiService } from './docs/openapi.service';

async function bootstrap(): Promise<void> {
  const config = loadRuntimeConfig({ refresh: true });
  const adapter = new FastifyAdapter({
    logger: fastifyLoggerOptions,
    genReqId: () => randomUUID(),
    bodyLimit: 75 * 1024 * 1024,
    trustProxy: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });
  await app.register(cors as never, {
    origin: config.publicBaseUrl,
    credentials: true,
    allowedHeaders: ['authorization', 'content-type', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
  });
  app.useGlobalFilters(new SafeExceptionFilter());
  const openApiConfig = new DocumentBuilder()
    .setTitle('SpiderwebRouter API')
    .setDescription(
      'OpenAI-compatible inference API and authenticated administration control plane.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'SpiderwebRouter API key' },
      'apiKey',
    )
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'Keycloak JWT' }, 'keycloak')
    .build();
  const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
  for (const [path, pathItem] of Object.entries(openApiDocument.paths)) {
    if (!path.startsWith('/v1/') || !pathItem) continue;
    for (const operation of Object.values(pathItem)) {
      if (!operation || typeof operation !== 'object' || !('responses' in operation)) continue;
      operation.servers = [
        { url: '/api/me/docs-test', description: 'Authenticated console session (Try It)' },
        { url: '/', description: 'Production API (SpiderwebRouter API key)' },
      ];
    }
  }
  app.get(OpenApiService).setDocument(openApiDocument);
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  appLogger.info({ port: config.port }, 'api_started');
}

bootstrap().catch((error: unknown) => {
  appLogger.fatal({ err: error }, 'api_start_failed');
  process.exitCode = 1;
});
