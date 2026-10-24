import { NestExpressApplication } from '@nestjs/platform-express';
import { Provider } from '@nestjs/common';
import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { createApp } from '../../src/app';
import { AppConfig, loadConfig } from '../../src/config/app-config';
import { migrate } from '../../src/infrastructure/persistence/migrate';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs-gateway';
import { AppLogger } from '../../src/observability/logger';

/*
 * Integration test harness. Everything runs against real PostgreSQL and
 * LocalStack SQS (`bun run infra:up`); each test file gets its own database
 * and its own queues, so files are isolated and can be re-run.
 */

export const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://wagering:wagering-local@localhost:5432/wagering';
export const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566';

process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

export interface TestEnvironment {
  databaseUrl: string;
  sql: SQL;
  env: Record<string, string>;
  queues: { wager: string; dlq: string; events: string };
  sqs: SQSClient;
  dispose(): Promise<void>;
}

/** Fresh database (migrated) + fresh queues. */
export async function createEnvironment(name: string): Promise<TestEnvironment> {
  const suffix = `${name.replace(/[^a-z0-9]/gi, '').toLowerCase()}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dbName = `test_${suffix}`;

  const admin = new SQL(ADMIN_DATABASE_URL);
  await admin.unsafe(`create database ${dbName}`);
  await admin.close();

  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${dbName}`;
  const databaseUrl = url.toString();
  await migrate(databaseUrl, 'up');

  const queues = {
    wager: `${suffix}-wager.fifo`,
    dlq: `${suffix}-wager-dlq.fifo`,
    events: `${suffix}-events.fifo`,
  };
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: databaseUrl,
    AWS_REGION: 'us-east-1',
    AWS_ENDPOINT_URL: SQS_ENDPOINT,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_WAGER_QUEUE: queues.wager,
    SQS_WAGER_DLQ: queues.dlq,
    SQS_EVENTS_QUEUE: queues.events,
    PORT: '0',
    METRICS_PORT: '0',
    CONSUMER_WAIT_SECONDS: '1',
    CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '5',
    CONSUMER_RETRY_BASE_SECONDS: '1',
    CONSUMER_RETRY_MAX_SECONDS: '2',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_RETRY_BASE_MS: '100',
    PENDING_REFERENCE_RETRY_MAX_MS: '200',
    SHUTDOWN_GRACE_MS: '5000',
    DATABASE_POOL_MAX: '30',
  };

  const sqsGateway = new SqsGateway(testConfig(env));
  await sqsGateway.ensureQueues();
  sqsGateway.onApplicationShutdown();

  const sql = new SQL(databaseUrl, { max: 5 });
  const sqs = new SQSClient({ region: 'us-east-1', endpoint: SQS_ENDPOINT });

  return {
    databaseUrl,
    sql,
    env,
    queues,
    sqs,
    async dispose() {
      await sql.close();
      sqs.destroy();
      const cleanup = new SQL(ADMIN_DATABASE_URL);
      await cleanup.unsafe(`drop database if exists ${dbName} with (force)`).catch(() => undefined);
      await cleanup.close();
    },
  };
}

/** Background loops are off unless a test turns them on explicitly. */
export function testConfig(env: Record<string, string>, overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    APP_ROLE: 'all',
    CONSUMER_ENABLED: 'false',
    OUTBOX_ENABLED: 'false',
    PENDING_REFERENCE_ENABLED: 'false',
    ...env,
    ...overrides,
  });
}

export interface RunningApp {
  app: NestExpressApplication;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startApp(
  testEnv: TestEnvironment,
  overrides: Record<string, string> = {},
  providers: Provider[] = [],
): Promise<RunningApp> {
  const config = testConfig(testEnv.env, overrides);
  const logger = AppLogger.create({ level: config.logLevel, instanceId: config.instanceId });
  const app = await createApp(config, { logger, overrides: providers });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}

// ----------------------------------------------------------------- HTTP helpers

export interface HttpResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function http<T = any>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

export async function createWallet(baseUrl: string, amount = '100.00', currency = 'BRL') {
  const playerId = crypto.randomUUID();
  const res = await http(baseUrl, 'POST', '/wallets', { playerId, initialBalance: { amount, currency } });
  if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id as string, playerId };
}

export interface WagerInput {
  walletId: string;
  playerId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  amount: string;
  externalTransactionId?: string;
  reference?: string;
  roundId?: string;
  providerId?: string;
  currency?: string;
}

export function wagerBody(input: WagerInput) {
  return {
    providerId: input.providerId ?? 'provider-a',
    externalTransactionId: input.externalTransactionId ?? `ext-${crypto.randomUUID()}`,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: input.kind,
    money: { amount: input.amount, currency: input.currency ?? 'BRL' },
    ...(input.reference && { referenceExternalTransactionId: input.reference }),
  };
}

export function submitWager(baseUrl: string, body: ReturnType<typeof wagerBody>, idempotencyKey?: string) {
  return http(baseUrl, 'POST', '/wagering/transactions', body, {
    'Idempotency-Key': idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}`,
  });
}

// ------------------------------------------------------------------ SQS helpers

export async function queueUrl(sqs: SQSClient, name: string): Promise<string> {
  return (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
}

export function wagerMessage(messageId: string, body: ReturnType<typeof wagerBody>, idempotencyKey?: string): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}` },
  });
}

export async function sendToQueue(env: TestEnvironment, body: string, groupId: string, dedupId = crypto.randomUUID()) {
  await env.sqs.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(env.sqs, env.queues.wager),
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

export interface DrainedMessage {
  body: string;
  attributes: Record<string, string | undefined>;
}

/**
 * Receives and deletes everything currently visible. Deleting matters on FIFO
 * queues: an unacknowledged message blocks the rest of its group.
 */
export async function drainQueue(env: TestEnvironment, queue: string, waitSeconds = 1): Promise<DrainedMessage[]> {
  const url = await queueUrl(env.sqs, queue);
  const out: DrainedMessage[] = [];
  for (;;) {
    const res = await env.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds, MessageAttributeNames: ['All'] }),
    );
    if (!res.Messages?.length) return out;
    for (const m of res.Messages) {
      out.push({
        body: m.Body ?? '',
        attributes: Object.fromEntries(Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue])),
      });
    }
    await env.sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: url,
        Entries: res.Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
      }),
    );
  }
}

/** Drains repeatedly until at least `count` messages were collected. */
export async function collect(env: TestEnvironment, queue: string, count: number, timeoutMs = 30_000): Promise<DrainedMessage[]> {
  const collected: DrainedMessage[] = [];
  await waitFor(async () => {
    collected.push(...(await drainQueue(env, queue, 1)));
    return collected.length >= count;
  }, { timeoutMs, intervalMs: 0, message: `${count} messages on ${queue}` });
  return collected;
}

/** Visible + in-flight + delayed messages (does not consume anything). */
export async function queueDepth(env: TestEnvironment, queue: string): Promise<number> {
  const res = await env.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(env.sqs, queue),
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
    }),
  );
  const a = res.Attributes ?? {};
  return Number(a.ApproximateNumberOfMessages ?? 0) + Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) + Number(a.ApproximateNumberOfMessagesDelayed ?? 0);
}

export async function purge(env: TestEnvironment, queue: string) {
  await env.sqs.send(new PurgeQueueCommand({ QueueUrl: await queueUrl(env.sqs, queue) })).catch(() => undefined);
}

// --------------------------------------------------------------------- waiting

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  { timeoutMs = 20_000, intervalMs = 100, message = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value as T;
    } catch (err) {
      last = err;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${message}${last ? `: ${String(last)}` : ''}`);
}

// ------------------------------------------------------------------ invariants

/**
 * The invariant every test ends with: for every wallet, the stored balance
 * equals the balance rebuilt from the ledger, and the ledger is coherent with
 * the transactions table.
 */
export async function assertFinancialInvariants(sql: SQL): Promise<void> {
  const mismatched = await sql`
    select w.id, w.balance_amount::text as stored,
           coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as rebuilt
      from wallets w
      left join wallet_ledger_entries l on l.wallet_id = w.id
     group by w.id, w.balance_amount
    having w.balance_amount <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`;
  if (mismatched.length > 0) {
    throw new Error(`wallet.balance != ledger for ${JSON.stringify(mismatched)}`);
  }

  // Balance-moving processed transactions have exactly one entry; everything else has none.
  const incoherent = await sql`
    select t.id, t.kind, t.status, count(l.id)::int as entries
      from wager_transactions t
      left join wallet_ledger_entries l on l.transaction_id = t.id
     group by t.id, t.kind, t.status
    having count(l.id) <> case when t.status = 'PROCESSED' and t.kind <> 'LOSS' then 1 else 0 end`;
  if (incoherent.length > 0) {
    throw new Error(`transactions without the expected ledger entries: ${JSON.stringify(incoherent)}`);
  }

  const negative = await sql`select id from wallets where balance_amount < 0`;
  if (negative.length > 0) throw new Error('negative balance found');
}

export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port!;
  server.stop(true);
  return port;
}

// ----------------------------------------------------------- real processes

export interface Instance {
  name: string;
  baseUrl: string;
  proc: ReturnType<typeof Bun.spawn>;
  output: string[];
  /** Resolves with the exit code. */
  exited: Promise<number>;
  stop(signal?: NodeJS.Signals): Promise<number>;
}

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * Starts the real service (`bun src/main.ts`) as a separate OS process, the
 * closest thing to another container. Waits until it answers /health/live,
 * unless `waitReady` is false (processes expected to crash early).
 */
export async function spawnInstance(
  testEnv: TestEnvironment,
  name: string,
  overrides: Record<string, string> = {},
  { waitReady = true } = {},
): Promise<Instance> {
  const port = await freePort();
  const proc = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...testEnv.env,
      APP_ROLE: 'all',
      CONSUMER_ENABLED: 'false',
      OUTBOX_ENABLED: 'false',
      PENDING_REFERENCE_ENABLED: 'false',
      INSTANCE_ID: name,
      ...overrides,
      PORT: String(port),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output.push(decoder.decode(chunk));
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);

  const instance: Instance = {
    name,
    baseUrl: `http://127.0.0.1:${port}`,
    proc,
    output,
    exited: proc.exited,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      return proc.exited;
    },
  };

  if (waitReady) {
    await waitFor(
      async () => {
        if (proc.exitCode !== null) throw new Error(`${name} exited early: ${output.join('').slice(-2000)}`);
        const res = await fetch(`${instance.baseUrl}/health/live`).catch(() => undefined);
        return res?.ok;
      },
      { timeoutMs: 30_000, intervalMs: 200, message: `${name} to start` },
    );
  }
  return instance;
}
