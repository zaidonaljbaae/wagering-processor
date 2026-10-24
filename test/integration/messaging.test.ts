import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Clock, FaultInjector, UnitOfWork, UnitOfWorkOptions } from '../../src/application/ports';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { EventPublisher, OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { MikroUnitOfWork } from '../../src/infrastructure/persistence/database';
import {
  assertFinancialInvariants,
  collect,
  createEnvironment,
  createWallet,
  drainQueue,
  queueDepth,
  RunningApp,
  sendToQueue,
  startApp,
  submitWager,
  TestEnvironment,
  wagerBody,
  wagerMessage,
  waitFor,
} from '../support/harness';

let env: TestEnvironment;
let api: RunningApp;

beforeAll(async () => {
  env = await createEnvironment('messaging');
  api = await startApp(env);
});
afterAll(async () => {
  await assertFinancialInvariants(env.sql);
  await api?.close();
  await env?.dispose();
});

// Each test starts from empty queues so leftovers cannot leak between tests.
beforeEach(async () => {
  for (const queue of [env.queues.wager, env.queues.dlq, env.queues.events]) await drainQueue(env, queue, 0);
});

const txCount = async (externalId: string) =>
  (await env.sql`select count(*)::int as c from wager_transactions where external_transaction_id = ${externalId}`)[0].c as number;

describe('SQS consumer', () => {
  test('processes a message through the same use case and acks after commit', async () => {
    const consumer = await startApp(env, { CONSUMER_ENABLED: 'true' });
    try {
      const w = await createWallet(api.baseUrl, '100.00');
      const body = wagerBody({ ...w, kind: 'BET', amount: '30.00' });
      await sendToQueue(env, wagerMessage('msg-1', body), w.walletId);

      await waitFor(async () => (await txCount(body.externalTransactionId)) === 1, { message: 'transaction from SQS' });
      const [row] = await env.sql`select status, balance_after_amount::text as balance from wager_transactions where external_transaction_id = ${body.externalTransactionId}`;
      expect(row).toEqual({ status: 'PROCESSED', balance: '70.00' });
      const [inbox] = await env.sql`select consumer_name, processed_at is not null as processed from inbox_messages where message_id = 'msg-1'`;
      expect(inbox).toEqual({ consumer_name: 'wager-transactions-consumer', processed: true });
    } finally {
      await consumer.close();
    }
  });

  test('redelivery of the same message (inbox) and of the same operation (idempotency) has no extra effect', async () => {
    const consumer = await startApp(env, { CONSUMER_ENABLED: 'true' });
    try {
      const w = await createWallet(api.baseUrl, '100.00');
      const body = wagerBody({ ...w, kind: 'BET', amount: '10.00' });
      // Same messageId three times, plus a new messageId for the same operation.
      for (const id of ['dup-1', 'dup-1', 'dup-1', 'dup-2']) await sendToQueue(env, wagerMessage(id, body), w.walletId);
      // And the same operation over HTTP for good measure.
      await submitWager(api.baseUrl, body);

      await waitFor(async () => (await queueDepth(env, env.queues.wager)) === 0, { message: 'queue drained' });

      expect(await txCount(body.externalTransactionId)).toBe(1);
      const [wallet] = await env.sql`select balance_amount::text as balance from wallets where id = ${w.walletId}`;
      expect(wallet.balance).toBe('90.00');
    } finally {
      await consumer.close();
    }
  });

  test('an operation first seen over HTTP still leaves an inbox row for every later SQS delivery', async () => {
    const consumer = await startApp(env, { CONSUMER_ENABLED: 'true' });
    try {
      const w = await createWallet(api.baseUrl, '100.00');
      const body = wagerBody({ ...w, kind: 'BET', amount: '10.00' });
      await submitWager(api.baseUrl, body);
      for (const id of ['after-http-1', 'after-http-2']) await sendToQueue(env, wagerMessage(id, body), w.walletId);

      await waitFor(async () => (await queueDepth(env, env.queues.wager)) === 0, { message: 'queue drained' });

      const inbox = await env.sql`select message_id from inbox_messages where message_id like 'after-http-%' order by message_id`;
      expect(inbox.map((r: { message_id: string }) => r.message_id)).toEqual(['after-http-1', 'after-http-2']);
      expect(await txCount(body.externalTransactionId)).toBe(1);
      const [ledger] = await env.sql`select count(*)::int as c from wallet_ledger_entries where wallet_id = ${w.walletId} and direction = 'DEBIT'`;
      expect(ledger.c).toBe(1);
      const [wallet] = await env.sql`select balance_amount::text as balance from wallets where id = ${w.walletId}`;
      expect(wallet.balance).toBe('90.00');
      expect(await queueDepth(env, env.queues.dlq)).toBe(0);
    } finally {
      await consumer.close();
    }
  });

  test('invalid messages go to the DLQ with a reason; business rejections are acked', async () => {
    const consumer = await startApp(env, { CONSUMER_ENABLED: 'true' });
    try {
      const w = await createWallet(api.baseUrl, '5.00');
      const rejected = wagerBody({ ...w, kind: 'BET', amount: '50.00' });
      await sendToQueue(env, '{"not": "a wager"', 'g');
      await sendToQueue(env, wagerMessage('opening', { ...rejected, kind: 'OPENING' as 'BET', externalTransactionId: 'opening-1' }), 'g');
      await sendToQueue(env, wagerMessage('unknown-wallet', wagerBody({ walletId: crypto.randomUUID(), playerId: crypto.randomUUID(), kind: 'BET', amount: '1.00' })), 'g2');
      await sendToQueue(env, wagerMessage('rejected', rejected), w.walletId);

      const dead = await collect(env, env.queues.dlq, 3);
      const reasons = dead.map((m) => m.attributes.failureReason).sort();
      expect(reasons).toEqual(['INVALID_MESSAGE', 'MALFORMED_JSON', 'WALLET_NOT_FOUND']);

      await waitFor(async () => (await txCount(rejected.externalTransactionId)) === 1, { message: 'rejected recorded' });
      const [row] = await env.sql`select status, failure_code from wager_transactions where external_transaction_id = ${rejected.externalTransactionId}`;
      expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    } finally {
      await consumer.close();
    }
  });

  test('transient failures are retried with backoff and dead-lettered after the attempt limit', async () => {
    let failuresLeft = 2;
    class FlakyUnitOfWork extends MikroUnitOfWork {
      override run<T>(work: () => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
        if (failuresLeft-- > 0) {
          return Promise.reject(Object.assign(new Error('connection reset'), { code: '08006' }));
        }
        return super.run(work, options);
      }
    }

    const flaky = await startApp(env, { CONSUMER_ENABLED: 'true', CONSUMER_MAX_ATTEMPTS: '3' }, [
      { provide: UnitOfWork, useClass: FlakyUnitOfWork },
    ]);
    try {
      const w = await createWallet(api.baseUrl, '100.00');
      const body = wagerBody({ ...w, kind: 'BET', amount: '1.00' });
      await sendToQueue(env, wagerMessage('flaky-1', body), w.walletId);
      // Two failures then success on the third delivery.
      await waitFor(async () => (await txCount(body.externalTransactionId)) === 1, { timeoutMs: 30_000, message: 'retry success' });
      expect(failuresLeft).toBeLessThanOrEqual(0);

      // Now fail forever: the message must end in the DLQ, not loop.
      failuresLeft = Number.POSITIVE_INFINITY;
      const doomed = wagerBody({ ...w, kind: 'BET', amount: '1.00' });
      await sendToQueue(env, wagerMessage('flaky-2', doomed), w.walletId);
      const dead = await collect(env, env.queues.dlq, 1, 40_000);
      expect(dead[0]!.attributes.failureReason).toBe('RETRIES_EXHAUSTED');
      expect(await txCount(doomed.externalTransactionId)).toBe(0);
    } finally {
      failuresLeft = 0;
      await flaky.close();
    }
  }, 90_000);

  test('graceful shutdown waits for the message in progress', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    class SlowUnitOfWork extends MikroUnitOfWork {
      override async run<T>(work: () => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
        await gate;
        return super.run(work, options);
      }
    }
    const consumer = await startApp(env, { CONSUMER_ENABLED: 'true' }, [{ provide: UnitOfWork, useClass: SlowUnitOfWork }]);
    const w = await createWallet(api.baseUrl, '10.00');
    const body = wagerBody({ ...w, kind: 'BET', amount: '1.00' });
    await sendToQueue(env, wagerMessage('slow-1', body), w.walletId);
    await Bun.sleep(1_500); // message received and blocked in the use case

    const closing = consumer.close(); // SIGTERM path
    await Bun.sleep(200);
    release();
    await closing;
    expect(await txCount(body.externalTransactionId)).toBe(1);
    expect(await queueDepth(env, env.queues.wager)).toBe(0); // acked before exit
  });
});

describe('transactional outbox', () => {
  /** Counts publishes and forwards them to an in-memory list instead of SQS. */
  class RecordingPublisher extends EventPublisher {
    static published: string[] = [];
    static failNext = 0;
    async publish(message: OutboxMessage): Promise<void> {
      if (RecordingPublisher.failNext > 0) {
        RecordingPublisher.failNext--;
        throw new Error('broker down');
      }
      await Bun.sleep(2); // widen race windows
      RecordingPublisher.published.push(message.id);
    }
  }

  async function seedEvents(count: number): Promise<string[]> {
    const w = await createWallet(api.baseUrl, '1000.00');
    for (let i = 0; i < count; i++) await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'BET', amount: '1.00' }));
    const rows = await env.sql`select id from outbox_messages where published_at is null`;
    return rows.map((r: { id: string }) => r.id);
  }

  test('concurrent publishers deliver every event exactly once (no crash)', async () => {
    await env.sql`update outbox_messages set published_at = now() where published_at is null`;
    const ids = await seedEvents(40);
    RecordingPublisher.published = [];

    const instances = await Promise.all(
      [1, 2, 3].map(() =>
        startApp(env, { OUTBOX_BATCH_SIZE: '7' }, [{ provide: EventPublisher, useClass: RecordingPublisher }]),
      ),
    );
    try {
      const publishers = instances.map((i) => i.app.get(OutboxPublisher));
      // Hammer the same table from three publishers at once until it is empty.
      await waitFor(
        async () => {
          await Promise.all(publishers.map((p) => p.publishBatch()));
          const [{ c }] = await env.sql`select count(*)::int as c from outbox_messages where published_at is null`;
          return c === 0;
        },
        { intervalMs: 0, message: 'outbox drained' },
      );
      expect(RecordingPublisher.published.length).toBe(ids.length);
      expect(new Set(RecordingPublisher.published)).toEqual(new Set(ids));
    } finally {
      await Promise.all(instances.map((i) => i.close()));
    }
  });

  test('a failed publish is retried later with backoff', async () => {
    await env.sql`update outbox_messages set published_at = now() where published_at is null`;
    const [id] = await seedEvents(1);
    RecordingPublisher.published = [];
    RecordingPublisher.failNext = 100; // every event of the batch fails once

    const instance = await startApp(env, { OUTBOX_RETRY_BASE_MS: '50', OUTBOX_RETRY_MAX_MS: '100' }, [
      { provide: EventPublisher, useClass: RecordingPublisher },
    ]);
    try {
      const publisher = instance.app.get(OutboxPublisher);
      await publisher.publishBatch();
      const [row] = await env.sql`select attempts, published_at, last_error from outbox_messages where id = ${id}`;
      expect(row.attempts).toBe(1);
      expect(row.published_at).toBeNull();
      expect(row.last_error).toContain('broker down');

      RecordingPublisher.failNext = 0;
      await waitFor(async () => {
        await publisher.publishBatch();
        const [r] = await env.sql`select published_at from outbox_messages where id = ${id}`;
        return r.published_at !== null;
      }, { message: 'retry published' });
      expect(RecordingPublisher.published).toContain(id!);
    } finally {
      await instance.close();
    }
  });

  test('crash after claim: lease expires and another instance publishes', async () => {
    await env.sql`update outbox_messages set published_at = now() where published_at is null`;
    const ids = await seedEvents(2);
    RecordingPublisher.published = [];

    // Instance A claims the rows and "dies" before publishing.
    class DyingFaults extends FaultInjector {
      hit(point: string): void {
        if (point === 'outbox_after_claim') throw new Error('process died');
      }
    }
    const a = await startApp(env, { OUTBOX_LEASE_MS: '800' }, [
      { provide: FaultInjector, useClass: DyingFaults },
      { provide: EventPublisher, useClass: RecordingPublisher },
    ]);
    const b = await startApp(env, { OUTBOX_LEASE_MS: '800' }, [{ provide: EventPublisher, useClass: RecordingPublisher }]);
    try {
      await a.app.get(OutboxPublisher).publishBatch().catch(() => undefined);
      const leased = await env.sql`select count(*)::int as c from outbox_messages where locked_until > now() and published_at is null`;
      expect(leased[0].c).toBe(ids.length);

      // B cannot take them while the lease holds...
      expect(await b.app.get(OutboxPublisher).publishBatch()).toBe(0);
      // ...and takes them once it expires.
      await Bun.sleep(900);
      expect(await b.app.get(OutboxPublisher).publishBatch()).toBe(ids.length);
      expect(new Set(RecordingPublisher.published)).toEqual(new Set(ids));
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('events reach SQS with eventId as the dedup id', async () => {
    await env.sql`update outbox_messages set published_at = now() where published_at is null`;
    const w = await createWallet(api.baseUrl, '10.00');
    await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'BET', amount: '4.00' }));
    const publisher = await startApp(env, { OUTBOX_ENABLED: 'true' });
    try {
      const events = await collect(env, env.queues.events, 4);
      const types = events.map((m) => m.attributes.eventType).sort();
      expect(types).toEqual(['WagerTransactionProcessed', 'WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged']);
      const change = events.map((m) => JSON.parse(m.body)).find((e) => e.eventType === 'WalletBalanceChanged' && e.data.direction === 'DEBIT');
      expect(change).toMatchObject({
        version: 1,
        aggregateId: w.walletId,
        data: { money: { amount: '4.00', currency: 'BRL' }, balanceBefore: { amount: '10.00' }, balanceAfter: { amount: '6.00' }, walletVersion: 2 },
      });
      expect(typeof change.correlationId).toBe('string');
    } finally {
      await publisher.close();
    }
  });
});

describe('pending references', () => {
  test('REFUND before its BET is applied once the BET arrives', async () => {
    const worker = await startApp(env, { PENDING_REFERENCE_ENABLED: 'true' });
    try {
      const w = await createWallet(api.baseUrl, '100.00');
      const bet = wagerBody({ ...w, kind: 'BET', amount: '25.00' });
      const refund = wagerBody({ ...w, kind: 'REFUND', amount: '25.00', reference: bet.externalTransactionId });

      expect((await submitWager(api.baseUrl, refund)).status).toBe(202);
      await submitWager(api.baseUrl, bet);

      const resolved = await waitFor(async () => {
        const [row] = await env.sql`select status, reference_transaction_id from wager_transactions where external_transaction_id = ${refund.externalTransactionId}`;
        return row.status === 'PROCESSED' ? row : undefined;
      }, { message: 'refund processed' });
      expect(resolved.reference_transaction_id).not.toBeNull();
      const [wallet] = await env.sql`select balance_amount::text as balance from wallets where id = ${w.walletId}`;
      expect(wallet.balance).toBe('100.00');

      const replay = await submitWager(api.baseUrl, refund);
      expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
    } finally {
      await worker.close();
    }
  });

  test('a reference that never arrives is rejected after the retry limit, with an event', async () => {
    const worker = await startApp(env, { PENDING_REFERENCE_ENABLED: 'true', PENDING_REFERENCE_MAX_ATTEMPTS: '3' });
    try {
      const w = await createWallet(api.baseUrl, '100.00');
      const rollback = wagerBody({ ...w, kind: 'ROLLBACK', amount: '5.00', reference: 'never' });
      await submitWager(api.baseUrl, rollback);

      const row = await waitFor(async () => {
        const [r] = await env.sql`select id, status, failure_code, attempts from wager_transactions where external_transaction_id = ${rollback.externalTransactionId}`;
        return r.status === 'REJECTED' ? r : undefined;
      }, { message: 'pending expired' });
      expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
      const events = await env.sql`select event_type from outbox_messages where aggregate_id = ${row.id} order by occurred_at`;
      expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
    } finally {
      await worker.close();
    }
  });

  test('a stale clock cannot make two resolvers apply the same refund', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    const bet = wagerBody({ ...w, kind: 'BET', amount: '10.00' });
    const refund = wagerBody({ ...w, kind: 'REFUND', amount: '10.00', reference: bet.externalTransactionId });
    await submitWager(api.baseUrl, refund);
    await submitWager(api.baseUrl, bet);

    class FutureClock extends Clock {
      now(): Date {
        return new Date(Date.now() + 60_000);
      }
    }
    const resolvers = await Promise.all([1, 2, 3].map(() => startApp(env, {}, [{ provide: Clock, useClass: FutureClock }])));
    try {
      const { ResolvePendingReferences } = await import('../../src/application/resolve-pending-references');
      await Promise.all(resolvers.map((r) => r.app.get(ResolvePendingReferences).runOnce(50)));
      const [row] = await env.sql`select status from wager_transactions where external_transaction_id = ${refund.externalTransactionId}`;
      expect(row.status).toBe('PROCESSED');
      const [{ c }] = await env.sql`select count(*)::int as c from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id
                                    where t.external_transaction_id = ${refund.externalTransactionId}`;
      expect(c).toBe(1);
    } finally {
      await Promise.all(resolvers.map((r) => r.close()));
    }
  });
});

