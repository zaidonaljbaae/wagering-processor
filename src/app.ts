import 'reflect-metadata';
import { Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';
import { SqsGateway } from './infrastructure/messaging/sqs-gateway';
import { accessLogMiddleware, correlationMiddleware } from './interfaces/http/middleware';
import { AppLogger, NestLoggerAdapter } from './observability/logger';
import { Metrics } from './observability/metrics';

export interface CreateAppOptions {
  logger?: AppLogger;
  metrics?: Metrics;
  overrides?: Provider[];
}

/** Builds a fully configured (but not yet listening) application. */
export async function createApp(config: AppConfig, options: CreateAppOptions = {}): Promise<NestExpressApplication> {
  const logger = options.logger ?? AppLogger.create({ level: config.logLevel, instanceId: config.instanceId });

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({
      config,
      logger,
      ...(options.metrics && { metrics: options.metrics }),
      ...(options.overrides && { overrides: options.overrides }),
    }),
    { logger: new NestLoggerAdapter(logger), bodyParser: false, abortOnError: false },
  );

  // Security baseline: strict headers, no fingerprinting, small JSON bodies only, no CORS (server-to-server API).
  app.use(helmet());
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.set('query parser', 'simple');
  app.useBodyParser('json', { limit: '16kb', strict: true, type: 'application/json' });
  app.use(correlationMiddleware);
  app.use(accessLogMiddleware(logger));

  if (config.sqs.autoCreateQueues) {
    await app.get(SqsGateway).ensureQueues();
  }
  return app;
}
