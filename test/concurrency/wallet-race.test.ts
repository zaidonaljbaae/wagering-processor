import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

/*
 * Real parallelism: concurrent HTTP requests spread over three application
 * instances (separate Nest apps, separate connection pools) sharing one
 * PostgreSQL. No mocks, no sequential simulation.
 */

let env: TestEnvironment;
let apps: RunningApp[];

beforeAll(async () => {
  env = await createEnvironment('race');
  apps = await Promise.all([1, 2, 3].map(() => startApp(env)));
});
afterAll(async () => {
  await assertFinancialInvariants(env.sql);
  await Promise.all(apps.map((a) => a.close()));
  await env?.dispose();
});

const pick = (i: number) => apps[i % apps.length]!.baseUrl;

async function ledgerDebits(walletId: string) {
  const [{ c }] = await env.sql`select count(*)::int as c from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
  return c as number;
}

describe('same wallet, concurrent requests', () => {
  test('the same bet sent 50 times in parallel debits exactly once', async () => {
    const w = await createWallet(pick(0), '100.00');
    const body = wagerBody({ ...w, kind: 'BET', amount: '10.00' });

    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submitWager(pick(i), body)));

    expect(results.filter((r) => r.status !== 200).map((r) => r.body)).toEqual([]);
    const ids = new Set(results.map((r) => r.body.transactionId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.every((r) => r.body.balance.amount === '90.00')).toBe(true);
    expect(await ledgerDebits(w.walletId)).toBe(1);
    const [wallet] = await env.sql`select balance_amount::text as b, version from wallets where id = ${w.walletId}`;
    expect(wallet).toEqual({ b: '90.00', version: 2 });
  });

  test('mandatory scenario: 100.00 balance, two concurrent 80.00 bets (repeated 25 times)', async () => {
    for (let round = 0; round < 25; round++) {
      const w = await createWallet(pick(round), '100.00');
      const a = wagerBody({ ...w, kind: 'BET', amount: '80.00' });
      const b = wagerBody({ ...w, kind: 'BET', amount: '80.00' });

      const [ra, rb] = await Promise.all([submitWager(pick(round), a), submitWager(pick(round + 1), b)]);
      const statuses = [ra.body.status, rb.body.status].sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      const rejected = [ra, rb].find((r) => r.body.status === 'REJECTED')!;
      expect(rejected.status).toBe(422);
      expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');

      // Retries (in parallel, on other instances) must not duplicate anything.
      const retries = await Promise.all([submitWager(pick(round + 2), a), submitWager(pick(round), b), submitWager(pick(round + 1), a)]);
      expect(retries.every((r) => r.body.idempotentReplay === true)).toBe(true);

      const [wallet] = await env.sql`select balance_amount::text as b from wallets where id = ${w.walletId}`;
      expect(wallet.b).toBe('20.00');
      expect(await ledgerDebits(w.walletId)).toBe(1);
    }
  });

  test('a hot wallet under mixed concurrent load never goes negative and stays consistent', async () => {
    const w = await createWallet(pick(0), '50.00');
    const bets = Array.from({ length: 60 }, () => wagerBody({ ...w, kind: 'BET', amount: '3.00' }));
    const wins = Array.from({ length: 20 }, () => wagerBody({ ...w, kind: 'WIN', amount: '1.50' }));
    const all = [...bets, ...wins].sort(() => Math.random() - 0.5);

    const results = await Promise.all(all.map((body, i) => submitWager(pick(i), body)));
    expect(results.every((r) => r.status === 200 || r.status === 422)).toBe(true);

    const processedBets = results.filter((r, i) => all[i]!.kind === 'BET' && r.body.status === 'PROCESSED').length;
    const rejectedBets = results.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS').length;
    expect(processedBets + rejectedBets).toBe(60);

    const expected = (5000 - processedBets * 300 + 20 * 150) / 100;
    const res = await http(pick(1), 'GET', `/wallets/${w.walletId}`);
    expect(res.body.balance.amount).toBe(expected.toFixed(2));
    expect(res.body.version).toBe(1 + processedBets + 20);

    const recon = await http(pick(2), 'POST', `/wallets/${w.walletId}/reconciliation`);
    expect(recon.body.consistent).toBe(true);
  });
});

describe('different wallets', () => {
  test('are processed in parallel and independently', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, i) => createWallet(pick(i), '100.00')));
    const requests = wallets.flatMap((w) => Array.from({ length: 10 }, () => wagerBody({ ...w, kind: 'BET', amount: '7.00' })));

    const started = performance.now();
    const results = await Promise.all(requests.map((body, i) => submitWager(pick(i), body)));
    const elapsed = performance.now() - started;

    // 100.00 / 7.00 -> 10 bets fit only if 70.00 <= 100.00: all ten succeed for every wallet.
    expect(results.every((r) => r.body.status === 'PROCESSED')).toBe(true);
    for (const w of wallets) {
      const [row] = await env.sql`select balance_amount::text as b, version from wallets where id = ${w.walletId}`;
      expect(row).toEqual({ b: '30.00', version: 11 });
    }
    // Sanity bound only (not a benchmark): 200 requests must not be serialized behind one lock.
    expect(elapsed).toBeLessThan(20_000);
  });
});
