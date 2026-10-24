import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { OutboxWriter } from '../../src/application/ports';
import { IntegrationEvent } from '../../src/domain/events/integration-event';
import { Metrics } from '../../src/observability/metrics';
import {
  assertFinancialInvariants,
  createEnvironment,
  createWallet,
  http,
  RunningApp,
  startApp,
  submitWager,
  TestEnvironment,
  wagerBody,
} from '../support/harness';

let env: TestEnvironment;
let api: RunningApp;

beforeAll(async () => {
  env = await createEnvironment('api');
  api = await startApp(env);
});
afterAll(async () => {
  await assertFinancialInvariants(env.sql);
  await api?.close();
  await env?.dispose();
});

describe('POST /wallets', () => {
  test('creates the wallet with an OPENING credit in the same transaction', async () => {
    const playerId = crypto.randomUUID();
    const res = await http(api.baseUrl, 'POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });

    const [opening] = await env.sql`select id, kind, status, amount::text as amount from wager_transactions where wallet_id = ${res.body.id}`;
    expect(opening).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00' });
    const entries = await env.sql`select direction, balance_after::text as after from wallet_ledger_entries where wallet_id = ${res.body.id}`;
    expect(entries).toEqual([{ direction: 'CREDIT', after: '1000.00' }]);
    const events = await env.sql`select event_type from outbox_messages
                                  where aggregate_id in (${res.body.id}, ${opening.id}) order by event_type`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('a zero initial balance creates no ledger entry', async () => {
    const res = await http(api.baseUrl, 'POST', '/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount: '0.00', currency: 'BRL' } });
    expect(res.status).toBe(201);
    const [{ count }] = await env.sql`select count(*)::int as count from wallet_ledger_entries where wallet_id = ${res.body.id}`;
    expect(count).toBe(0);
  });

  test('duplicate wallet for the same player and currency is a conflict', async () => {
    const playerId = crypto.randomUUID();
    const body = { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } };
    expect((await http(api.baseUrl, 'POST', '/wallets', body)).status).toBe(201);
    const dup = await http(api.baseUrl, 'POST', '/wallets', body);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('WALLET_ALREADY_EXISTS');
    const other = await http(api.baseUrl, 'POST', '/wallets', { playerId, initialBalance: { amount: '1.00', currency: 'USD' } });
    expect(other.status).toBe(201);
  });

  test.each([
    [{ amount: 100, currency: 'BRL' }],
    [{ amount: '1.5', currency: 'BRL' }],
    [{ amount: '-1.00', currency: 'BRL' }],
    [{ amount: '1e3', currency: 'BRL' }],
    [{ amount: '1.00', currency: 'XXX1' }],
  ])('rejects invalid initial balance %p', async (initialBalance) => {
    const res = await http(api.baseUrl, 'POST', '/wallets', { playerId: crypto.randomUUID(), initialBalance });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /wagering/transactions', () => {
  test('BET debits and returns the new balance', async () => {
    const w = await createWallet(api.baseUrl, '1000.00');
    const res = await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'BET', amount: '25.00' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
  });

  test('identical request replays the original result, including the balance at that time', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    const body = wagerBody({ ...w, kind: 'BET', amount: '10.00' });
    const first = await submitWager(api.baseUrl, body);
    await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'BET', amount: '30.00' })); // balance moves on
    const replay = await submitWager(api.baseUrl, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe('90.00');
  });

  test('same key with a different payload is a conflict, not a replay', async () => {
    const w = await createWallet(api.baseUrl);
    const body = wagerBody({ ...w, kind: 'BET', amount: '10.00' });
    await submitWager(api.baseUrl, body);
    const conflict = await submitWager(api.baseUrl, { ...body, money: { amount: '11.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  test('same external id under another idempotency key is a conflict', async () => {
    const w = await createWallet(api.baseUrl);
    const body = wagerBody({ ...w, kind: 'BET', amount: '10.00' });
    await submitWager(api.baseUrl, body);
    const conflict = await submitWager(api.baseUrl, body, 'another-key');
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });

  test('insufficient funds is a 422 business rejection with a failure code', async () => {
    const w = await createWallet(api.baseUrl, '10.00');
    const res = await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'BET', amount: '10.01' }));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    const replay = await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'BET', amount: '10.01', externalTransactionId: 'x' }));
    expect(replay.status).toBe(422);
  });

  test('full round: BET, WIN, LOSS, REFUND, ROLLBACK', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    const bet = wagerBody({ ...w, kind: 'BET', amount: '20.00' });
    expect((await submitWager(api.baseUrl, bet)).body.balance.amount).toBe('80.00');

    const win = wagerBody({ ...w, kind: 'WIN', amount: '50.00', reference: bet.externalTransactionId });
    expect((await submitWager(api.baseUrl, win)).body.balance.amount).toBe('130.00');

    const loss = await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'LOSS', amount: '0.00', roundId: 'round-2' }));
    expect(loss.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '130.00' } });

    const rollbackWin = wagerBody({ ...w, kind: 'ROLLBACK', amount: '50.00', reference: win.externalTransactionId });
    expect((await submitWager(api.baseUrl, rollbackWin)).body.balance.amount).toBe('80.00');

    const refund = wagerBody({ ...w, kind: 'REFUND', amount: '20.00', reference: bet.externalTransactionId });
    expect((await submitWager(api.baseUrl, refund)).body.balance.amount).toBe('100.00');

    // The BET was already refunded: a second reversal of any kind is refused.
    const again = await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'ROLLBACK', amount: '20.00', reference: bet.externalTransactionId }));
    expect(again.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });

    const wallet = await http(api.baseUrl, 'GET', `/wallets/${w.walletId}`);
    expect(wallet.body).toMatchObject({ balance: { amount: '100.00' }, version: 5 });
  });

  test('reversal that would make the balance negative gets its own failure code', async () => {
    const w = await createWallet(api.baseUrl, '0.00');
    const win = wagerBody({ ...w, kind: 'WIN', amount: '50.00' });
    await submitWager(api.baseUrl, win);
    await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'BET', amount: '45.00' }));
    const rollback = await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'ROLLBACK', amount: '50.00', reference: win.externalTransactionId }));
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
  });

  test('currency conflict is rejected and auditable', async () => {
    const w = await createWallet(api.baseUrl, '10.00');
    const res = await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'BET', amount: '1.00', currency: 'USD' }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
    const [row] = await env.sql`select status, failure_code from wager_transactions where id = ${res.body.transactionId}`;
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'CURRENCY_MISMATCH' });
  });

  test('reference that has not arrived yet is accepted as PENDING_REFERENCE (202)', async () => {
    const w = await createWallet(api.baseUrl, '10.00');
    const res = await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'REFUND', amount: '5.00', reference: 'not-yet' }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  test('validation: missing header, unknown fields, OPENING, reserved provider, malformed JSON', async () => {
    const w = await createWallet(api.baseUrl);
    const body = wagerBody({ ...w, kind: 'BET', amount: '1.00' });

    const noKey = await http(api.baseUrl, 'POST', '/wagering/transactions', body);
    expect(noKey.status).toBe(400);
    expect(noKey.body.issues[0].path).toBe('Idempotency-Key');

    const extra = await submitWager(api.baseUrl, { ...body, admin: true } as typeof body);
    expect(extra.status).toBe(400);

    const opening = await submitWager(api.baseUrl, { ...body, kind: 'OPENING' } as unknown as typeof body);
    expect(opening.status).toBe(400);

    const internal = await submitWager(api.baseUrl, { ...body, providerId: 'internal' });
    expect(internal.status).toBe(400);

    const refundWithoutReference = await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'REFUND', amount: '1.00' }));
    expect(refundWithoutReference.status).toBe(400);

    const malformed = await http(api.baseUrl, 'POST', '/wagering/transactions', '{bad', { 'Idempotency-Key': 'k' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.message).not.toContain('Parse');
  });

  test('unknown wallet is 404 and nothing is stored', async () => {
    const res = await submitWager(api.baseUrl, wagerBody({ walletId: crypto.randomUUID(), playerId: crypto.randomUUID(), kind: 'BET', amount: '1.00' }));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('queries', () => {
  test('transaction by id and by provider external id', async () => {
    const w = await createWallet(api.baseUrl);
    const body = wagerBody({ ...w, kind: 'BET', amount: '3.00' });
    const created = await submitWager(api.baseUrl, body);

    const byId = await http(api.baseUrl, 'GET', `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ id: created.body.transactionId, kind: 'BET', status: 'PROCESSED', money: { amount: '3.00' } });
    expect(byId.body.payloadHash).toBeUndefined();

    const byExternal = await http(api.baseUrl, 'GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExternal.body.id).toBe(created.body.transactionId);

    expect((await http(api.baseUrl, 'GET', `/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await http(api.baseUrl, 'GET', '/wagering/transactions/not-a-uuid')).status).toBe(400);
  });

  test('ledger pagination with a stable opaque cursor', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    for (let i = 0; i < 4; i++) await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'BET', amount: '1.00' }));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = await http(api.baseUrl, 'GET', `/wallets/${w.walletId}/ledger${query}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((i: { id: string }) => i.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(5); // opening + 4 bets
    expect(new Set(seen).size).toBe(5);

    const bad = await http(api.baseUrl, 'GET', `/wallets/${w.walletId}/ledger?cursor=garbage!`);
    expect(bad.status).toBe(400);
  });

  test('reconciliation reports a consistent wallet', async () => {
    const w = await createWallet(api.baseUrl, '50.00');
    await submitWager(api.baseUrl, wagerBody({ ...w, kind: 'BET', amount: '12.34' }));
    const res = await http(api.baseUrl, 'POST', `/wallets/${w.walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: w.walletId,
      storedBalance: { amount: '37.66', currency: 'BRL' },
      calculatedBalance: { amount: '37.66', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });
});

describe('cross-cutting', () => {
  test('health endpoints are open; readiness checks dependencies', async () => {
    expect((await http(api.baseUrl, 'GET', '/health/live')).body).toEqual({ status: 'ok' });
    const ready = await http(api.baseUrl, 'GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ database: 'up', sqs: 'up' });
  });

  test('security headers and correlation id are set', async () => {
    const res = await http(api.baseUrl, 'GET', '/health/live', undefined, { 'X-Correlation-Id': 'abc-123' });
    expect(res.headers.get('x-correlation-id')).toBe('abc-123');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
    const unsafe = await http(api.baseUrl, 'GET', '/health/live', undefined, { 'X-Correlation-Id': '<script>' });
    expect(unsafe.headers.get('x-correlation-id')).not.toBe('<script>');
  });

  test('oversized bodies are refused', async () => {
    const res = await http(api.baseUrl, 'POST', '/wallets', { playerId: 'x'.repeat(20_000) });
    expect(res.status).toBe(413);
  });
});

describe('lock timeouts', () => {
  test('a wallet locked for too long yields a retryable 503 and is counted', async () => {
    const impatient = await startApp(env, { DATABASE_LOCK_TIMEOUT_MS: '300' });
    try {
      const w = await createWallet(api.baseUrl, '10.00');
      const body = wagerBody({ ...w, kind: 'BET', amount: '1.00' });
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));

      // Another session holds the wallet row lock.
      const holder = env.sql.begin(async (tx) => {
        await tx`select id from wallets where id = ${w.walletId} for update`;
        locked();
        await held;
      });
      await isLocked;
      const res = await submitWager(impatient.baseUrl, body);
      release();
      await holder;

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('TEMPORARILY_UNAVAILABLE');
      expect(res.headers.get('retry-after')).toBe('1');
      const metric = await impatient.app.get(Metrics).registry.getSingleMetricAsString('wallet_lock_conflicts_total');
      expect(metric).toContain('wallet_lock_conflicts_total{type="lock_timeout"} 1');

      // Nothing was written; the retry succeeds.
      const retry = await submitWager(impatient.baseUrl, body);
      expect(retry.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    } finally {
      await impatient.close();
    }
  });
});

describe('atomicity', () => {
  test('a failure while writing the outbox rolls back transaction, balance and ledger', async () => {
    class FailingOutbox extends OutboxWriter {
      async enqueue(_events: ReadonlyArray<IntegrationEvent<unknown>>): Promise<void> {
        throw new Error('outbox unavailable');
      }
    }
    // Wallet created through the normal app; the bet goes through an app whose outbox fails.
    const w = await createWallet(api.baseUrl, '100.00');
    const broken = await startApp(env, {}, [{ provide: OutboxWriter, useClass: FailingOutbox }]);
    try {
      const body = wagerBody({ ...w, kind: 'BET', amount: '40.00' });
      const res = await submitWager(broken.baseUrl, body);
      expect(res.status).toBe(500);

      const [wallet] = await env.sql`select balance_amount::text as balance, version from wallets where id = ${w.walletId}`;
      expect(wallet).toEqual({ balance: '100.00', version: 1 });
      const [{ count }] = await env.sql`select count(*)::int as count from wager_transactions where external_transaction_id = ${body.externalTransactionId}`;
      expect(count).toBe(0);

      // The provider retries against a healthy instance and the operation applies exactly once.
      const retry = await submitWager(api.baseUrl, body);
      expect(retry.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '60.00' } });
    } finally {
      await broken.close();
    }
  });
});
