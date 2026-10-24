import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  assertFinancialInvariants,
  collect,
  createEnvironment,
  createWallet,
  drainQueue,
  http,
  Instance,
  queueDepth,
  sendToQueue,
  spawnInstance,
  submitWager,
  TestEnvironment,
  wagerBody,
  wagerMessage,
  waitFor,
} from '../support/harness';

/*
 * Each instance is a separate OS process running the real entry point
 * (`bun src/main.ts`), sharing PostgreSQL and SQS, the same topology as
 * several containers. Crashes are real process kills.
 */

let env: TestEnvironment;
let running: Instance[] = [];

const WORKER = { CONSUMER_ENABLED: 'true', OUTBOX_ENABLED: 'true', PENDING_REFERENCE_ENABLED: 'true' };

beforeAll(async () => {
  env = await createEnvironment('processes');
});
afterEach(async () => {
  await Promise.all(running.map((i) => i.stop('SIGKILL')));
  running = [];
  for (const queue of [env.queues.wager, env.queues.dlq, env.queues.events]) await drainQueue(env, queue, 0);
});
afterAll(async () => {
  await assertFinancialInvariants(env.sql);
  await env?.dispose();
});

async function spawn(name: string, overrides: Record<string, string> = {}, options?: { waitReady?: boolean }) {
  const instance = await spawnInstance(env, name, overrides, options);
  running.push(instance);
  return instance;
}

async function balance(walletId: string): Promise<string> {
  const [row] = await env.sql`select balance_amount::text as b from wallets where id = ${walletId}`;
  return row.b;
}

async function outboxPending(): Promise<number> {
  const [{ c }] = await env.sql`select count(*)::int as c from outbox_messages where published_at is null`;
  return c;
}

describe('multiple instances', () => {
  test('three processes share HTTP and SQS load without losing or duplicating money', async () => {
    const instances = await Promise.all(['p1', 'p2', 'p3'].map((n) => spawn(n, WORKER)));
    const wallets = await Promise.all([0, 1, 2, 3].map((i) => createWallet(instances[i % 3]!.baseUrl, '500.00')));

    // HTTP: 30 bets of 5.00 per wallet, spread over the three processes.
    const httpBodies = wallets.flatMap((w) => Array.from({ length: 30 }, () => wagerBody({ ...w, kind: 'BET', amount: '5.00' })));
    // SQS: 10 wins of 2.00 per wallet, each message delivered twice.
    const sqsBodies = wallets.flatMap((w) => Array.from({ length: 10 }, () => wagerBody({ ...w, kind: 'WIN', amount: '2.00' })));

    await Promise.all([
      ...httpBodies.map((b, i) => submitWager(instances[i % 3]!.baseUrl, b)),
      ...sqsBodies.flatMap((b, i) => [
        sendToQueue(env, wagerMessage(`multi-${i}`, b), b.walletId),
        sendToQueue(env, wagerMessage(`multi-${i}`, b), b.walletId),
      ]),
    ]);

    await waitFor(async () => (await queueDepth(env, env.queues.wager)) === 0, { timeoutMs: 60_000, message: 'queue drained' });
    await waitFor(async () => (await outboxPending()) === 0, { timeoutMs: 30_000, message: 'outbox drained' });

    for (const w of wallets) {
      // 500 - 30 * 5 + 10 * 2 = 370
      expect(await balance(w.walletId)).toBe('370.00');
      const recon = await http(instances[0]!.baseUrl, 'POST', `/wallets/${w.walletId}/reconciliation`);
      expect(recon.body.consistent).toBe(true);
    }
    const [{ c }] = await env.sql`select count(*)::int as c from inbox_messages where message_id like 'multi-%'`;
    expect(c).toBe(sqsBodies.length);
    await assertFinancialInvariants(env.sql);
  }, 120_000);
});

describe('crash recovery', () => {
  test('worker killed after commit and before ack: redelivery is absorbed by the inbox', async () => {
    const w = await createWallet((await spawn('api')).baseUrl, '100.00');
    const body = wagerBody({ ...w, kind: 'BET', amount: '40.00' });

    const doomed = await spawn('doomed', { CONSUMER_ENABLED: 'true', FAULT_POINT: 'after_commit_before_ack', CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '3' });
    await sendToQueue(env, wagerMessage('crash-1', body), w.walletId);

    await doomed.exited; // killed by the fault injector right after COMMIT
    const [row] = await env.sql`select status from wager_transactions where external_transaction_id = ${body.externalTransactionId}`;
    expect(row.status).toBe('PROCESSED');
    expect(await balance(w.walletId)).toBe('60.00');
    expect(await queueDepth(env, env.queues.wager)).toBe(1); // never acked

    // A healthy replacement receives the same message again.
    await spawn('replacement', { CONSUMER_ENABLED: 'true' });
    await waitFor(async () => (await queueDepth(env, env.queues.wager)) === 0, { timeoutMs: 30_000, message: 'redelivery acked' });

    expect(await balance(w.walletId)).toBe('60.00');
    const [{ c }] = await env.sql`select count(*)::int as c from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id
                                  where t.external_transaction_id = ${body.externalTransactionId}`;
    expect(c).toBe(1);
  }, 90_000);

  test('publisher killed after claiming: another instance publishes once the lease expires', async () => {
    const api = await spawn('api');
    const w = await createWallet(api.baseUrl, '10.00');
    await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'BET', amount: '1.00' }));
    const pending = await outboxPending();
    expect(pending).toBeGreaterThan(0);

    // Commit happened; the publisher dies after claiming and before publishing.
    const doomed = await spawn('doomed-publisher', { OUTBOX_ENABLED: 'true', OUTBOX_LEASE_MS: '2000', FAULT_POINT: 'outbox_after_claim' }, { waitReady: false });
    await doomed.exited;
    expect(await outboxPending()).toBe(pending);

    await spawn('publisher', { OUTBOX_ENABLED: 'true', OUTBOX_LEASE_MS: '2000' });
    await waitFor(async () => (await outboxPending()) === 0, { timeoutMs: 30_000, message: 'outbox drained after lease expiry' });

    const events = await collect(env, env.queues.events, pending);
    const ids = events.map((e) => JSON.parse(e.body).eventId);
    expect(new Set(ids).size).toBe(pending);
  }, 90_000);

  test('restart under load: an instance killed mid-traffic, restarted, final state consistent', async () => {
    const a = await spawn('a', WORKER);
    let b = await spawn('b', WORKER);
    const w = await createWallet(a.baseUrl, '1000.00');

    const bodies = Array.from({ length: 80 }, () => wagerBody({ ...w, kind: 'BET', amount: '1.00' }));
    for (const [i, body] of bodies.entries()) await sendToQueue(env, wagerMessage(`restart-${i}`, body), w.walletId);

    // Kill b while it is consuming, then bring it back.
    await waitFor(async () => {
      const [{ c }] = await env.sql`select count(*)::int as c from wager_transactions where wallet_id = ${w.walletId} and kind = 'BET'`;
      return c >= 10;
    }, { message: 'some progress before the crash' });
    await b.stop('SIGKILL');
    running = running.filter((i) => i !== b);
    b = await spawn('b-restarted', WORKER);

    await waitFor(async () => (await queueDepth(env, env.queues.wager)) === 0, { timeoutMs: 90_000, message: 'all messages acked' });
    await waitFor(async () => (await outboxPending()) === 0, { timeoutMs: 30_000, message: 'outbox drained' });

    expect(await balance(w.walletId)).toBe('920.00');
    const [{ c }] = await env.sql`select count(*)::int as c from wager_transactions where wallet_id = ${w.walletId} and kind = 'BET'`;
    expect(c).toBe(80);
    await assertFinancialInvariants(env.sql);
  }, 150_000);
});
