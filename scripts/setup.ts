import 'reflect-metadata';
import { loadConfig } from '../src/config/app-config';
import { migrate } from '../src/infrastructure/persistence/migrate';
import { SqsGateway } from '../src/infrastructure/messaging/sqs-gateway';

/**
 * One-shot environment setup for local/dev: applies migrations and creates the
 * SQS queues (main FIFO queue with DLQ redrive + events queue).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const applied = await migrate(config.database.url, 'up');
  console.log(JSON.stringify({ msg: 'migrations applied', migrations: applied }));

  const sqs = new SqsGateway(config);
  await sqs.ensureQueues();
  sqs.onApplicationShutdown();
  console.log(JSON.stringify({ msg: 'queues ready', queues: [config.sqs.wagerQueue, config.sqs.wagerDlq, config.sqs.eventsQueue] }));
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'setup failed', error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
