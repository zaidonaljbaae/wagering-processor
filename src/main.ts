import 'reflect-metadata';
import { createApp } from './app';
import { loadConfig } from './config/app-config';
import { AppLogger, errorFields } from './observability/logger';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = AppLogger.create({ level: config.logLevel, instanceId: config.instanceId });
  const app = await createApp(config, { logger });
  await app.listen(config.http.port, '0.0.0.0');
  logger.info('service started', { role: config.role, port: config.http.port, auth: config.auth.mode });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown requested', { signal });
    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out, exiting');
      process.exit(1);
    }, config.consumer.shutdownGraceMs + 10_000);
    forceExit.unref();
    try {
      // Stop consumers/workers (beforeApplicationShutdown), then close HTTP and the DB pool.
      await app.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('shutdown failed', errorFields(err));
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err: unknown) => {
  // Config errors list keys only; no secrets end up here.
  console.error(JSON.stringify({ level: 'fatal', msg: 'startup failed', ...errorFields(err) }));
  process.exit(1);
});
