import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { migrate } from '../../src/infrastructure/persistence/migrate';
import { createEnvironment, TestEnvironment } from '../support/harness';

/*
 * The schema itself must refuse invalid financial states, independently of
 * application code. These tests write raw SQL on purpose.
 */

let env: TestEnvironment;
let sql: SQL;

beforeAll(async () => {
  env = await createEnvironment('schema');
  sql = env.sql;
});
afterAll(async () => env?.dispose());

const uuid = () => Bun.randomUUIDv7();
const now = new Date();

async function insertWallet(balance = '0.00', currency = 'BRL') {
  const id = uuid();
  const playerId = crypto.randomUUID();
  await sql`insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
            values (${id}, ${playerId}, ${currency}, ${balance}, 1, ${now}, ${now})`;
  return { id, playerId };
}

async function insertTx(walletId: string, playerId: string, overrides: Record<string, unknown> = {}) {
  const row = {
    id: uuid(),
    provider_id: 'provider-a',
    external_transaction_id: `ext-${uuid()}`,
    idempotency_key: `key-${uuid()}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: walletId,
    player_id: playerId,
    round_id: 'r1',
    game_id: 'g1',
    kind: 'WIN',
    amount: '10.00',
    currency: 'BRL',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PROCESSED',
    failure_code: null,
    balance_after_amount: '10.00',
    attempts: 0,
    next_attempt_at: null,
    created_at: now,
    updated_at: now,
    processed_at: now,
    ...overrides,
  };
  await sql`insert into wager_transactions ${sql(row)}`;
  return row;
}

async function insertEntry(walletId: string, transactionId: string, direction: string, amount: string, before: string, after: string) {
  await sql`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
            values (${uuid()}, ${walletId}, ${transactionId}, ${direction}, ${amount}, 'BRL', ${before}, ${after}, ${now})`;
}

/** Credits a wallet consistently (tx + entry + balance) inside one SQL transaction. */
async function credit(walletId: string, playerId: string, amount: string, before: string, after: string, version: number) {
  await sql.begin(async (tx) => {
    const t = await insertTxWith(tx, walletId, playerId, { amount, balance_after_amount: after });
    await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
             values (${uuid()}, ${walletId}, ${t.id}, 'CREDIT', ${amount}, 'BRL', ${before}, ${after}, ${now})`;
    await tx`update wallets set balance_amount = ${after}, version = ${version} where id = ${walletId}`;
  });
}

async function insertTxWith(tx: SQL, walletId: string, playerId: string, overrides: Record<string, unknown>) {
  const id = uuid();
  await tx`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
             round_id, game_id, kind, amount, currency, status, balance_after_amount, created_at, updated_at, processed_at)
           values (${id}, 'provider-a', ${`ext-${id}`}, ${`key-${id}`}, ${'a'.repeat(64)}, ${walletId}, ${playerId},
             'r1', 'g1', 'WIN', ${overrides.amount as string}, 'BRL', 'PROCESSED', ${overrides.balance_after_amount as string}, ${now}, ${now}, ${now})`;
  return { id };
}

describe('migrations', () => {
  test('are reversible (down then up again)', async () => {
    const isolated = await createEnvironment('migrations');
    try {
      expect(await migrate(isolated.databaseUrl, 'down')).toEqual(['Migration20261023000000LedgerIntegrity']);
      expect(await migrate(isolated.databaseUrl, 'down')).toEqual(['Migration20261022000000InitialSchema']);
      const [{ count }] = await isolated.sql`select count(*)::int as count from information_schema.tables where table_name = 'wallets'`;
      expect(count).toBe(0);
      expect(await migrate(isolated.databaseUrl, 'up')).toEqual([
        'Migration20261022000000InitialSchema',
        'Migration20261023000000LedgerIntegrity',
      ]);
    } finally {
      await isolated.dispose();
    }
  });
});

describe('wallets', () => {
  test('one wallet per player and currency', async () => {
    const { playerId } = await insertWallet();
    const err = await sql`insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
                          values (${uuid()}, ${playerId}, 'BRL', 0, 1, ${now}, ${now})`.catch((e) => e);
    expect(String(err)).toContain('uq_wallets_player_currency');
    // Same player in another currency is fine.
    await sql`insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
              values (${uuid()}, ${playerId}, 'USD', 0, 1, ${now}, ${now})`;
  });

  test('balance can never be negative', async () => {
    const err = await insertWallet('-0.01').catch((e) => e);
    expect(String(err)).toContain('check');
  });

  test('a balance change without a matching ledger entry is refused at commit', async () => {
    const { id } = await insertWallet();
    const err = await sql`update wallets set balance_amount = 50, version = 2 where id = ${id}`.catch((e) => e);
    expect(String(err)).toContain('does not match ledger');
  });

  test('a balance change must bump the version by exactly one', async () => {
    const { id, playerId } = await insertWallet();
    const err = await credit(id, playerId, '10.00', '0.00', '10.00', 1).catch((e) => e);
    expect(String(err)).toContain('without a version bump');
    await credit(id, playerId, '10.00', '0.00', '10.00', 2);
    const [wallet] = await sql`select balance_amount::text as balance, version from wallets where id = ${id}`;
    expect(wallet).toEqual({ balance: '10.00', version: 2 });
  });

  test('identity columns are immutable and wallets cannot be deleted', async () => {
    const { id } = await insertWallet();
    expect(String(await sql`update wallets set player_id = ${crypto.randomUUID()} where id = ${id}`.catch((e) => e))).toContain('immutable');
    expect(String(await sql`delete from wallets where id = ${id}`.catch((e) => e))).toContain('not allowed');
  });
});

describe('ledger', () => {
  test('is append-only: no update, delete or truncate', async () => {
    const { id, playerId } = await insertWallet();
    await credit(id, playerId, '5.00', '0.00', '5.00', 2);
    expect(String(await sql`update wallet_ledger_entries set amount = 1 where wallet_id = ${id}`.catch((e) => e))).toContain('not allowed');
    expect(String(await sql`delete from wallet_ledger_entries where wallet_id = ${id}`.catch((e) => e))).toContain('not allowed');
    expect(String(await sql`truncate wallet_ledger_entries cascade`.catch((e) => e))).toContain('not allowed');
  });

  test('entry arithmetic is checked', async () => {
    const { id, playerId } = await insertWallet();
    const tx = await insertTx(id, playerId);
    const err = await insertEntry(id, tx.id, 'CREDIT', '10.00', '0.00', '11.00').catch((e) => e);
    expect(String(err)).toContain('ck_ledger_arithmetic');
  });

  test('entries form a chain: each starts where the previous ended', async () => {
    const { id, playerId } = await insertWallet();
    await credit(id, playerId, '5.00', '0.00', '5.00', 2);
    const tx = await insertTx(id, playerId);
    const err = await insertEntry(id, tx.id, 'CREDIT', '10.00', '0.00', '10.00').catch((e) => e);
    expect(String(err)).toContain('ledger chain broken');
  });

  test('an entry without the matching wallet update is refused at commit', async () => {
    const { id, playerId } = await insertWallet();
    await credit(id, playerId, '100.00', '0.00', '100.00', 2);
    // A valid WIN and a valid 100 -> 110 entry, but the wallet is left at 100.
    const err = await sql
      .begin(async (t) => {
        const win = await insertTxWith(t, id, playerId, { amount: '10.00', balance_after_amount: '110.00' });
        await t`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
                values (${uuid()}, ${id}, ${win.id}, 'CREDIT', 10, 'BRL', 100, 110, ${now})`;
      })
      .catch((e) => e);
    expect(String(err)).toContain('does not match ledger');
    const [{ entries }] = await sql`select count(*)::int as entries from wallet_ledger_entries where wallet_id = ${id}`;
    expect(entries).toBe(1);
  });

  test('an entry must point to a processed transaction of the same wallet', async () => {
    const { id, playerId } = await insertWallet();
    const other = await insertWallet();
    const foreign = await insertTx(other.id, other.playerId);
    expect(String(await insertEntry(id, foreign.id, 'CREDIT', '10.00', '0.00', '10.00').catch((e) => e))).toContain('fk_ledger_tx_wallet');

    const rejected = await insertTx(id, playerId, { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: null });
    const err = await sql
      .begin(async (t) => {
        await t`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
                values (${uuid()}, ${id}, ${rejected.id}, 'CREDIT', 10, 'BRL', 0, 10, ${now})`;
        await t`update wallets set balance_amount = 10, version = 2 where id = ${id}`;
      })
      .catch((e) => e);
    expect(String(err)).toContain('in status REJECTED');
  });

  test('entry currency must be the wallet currency', async () => {
    const { id, playerId } = await insertWallet();
    const tx = await insertTx(id, playerId);
    const err = await sql`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
                          values (${uuid()}, ${id}, ${tx.id}, 'CREDIT', 10, 'USD', 0, 10, ${now})`.catch((e) => e);
    expect(String(err)).toContain('fk_ledger_wallet_currency');
  });

  test('at most one entry per transaction and wallet', async () => {
    const { id, playerId } = await insertWallet();
    const tx = await insertTx(id, playerId);
    await sql.begin(async (t) => {
      await t`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
              values (${uuid()}, ${id}, ${tx.id}, 'CREDIT', 1, 'BRL', 0, 1, ${now})`;
      const err = await t`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
                          values (${uuid()}, ${id}, ${tx.id}, 'CREDIT', 1, 'BRL', 1, 2, ${now})`.catch((e) => e);
      expect(String(err)).toContain('uq_ledger_wallet_tx');
      throw new Error('rollback');
    }).catch(() => undefined);
  });
});

describe('wager_transactions', () => {
  test('idempotency key and external id are unique per provider', async () => {
    const { id, playerId } = await insertWallet();
    const tx = await insertTx(id, playerId, { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: null });
    expect(String(await insertTx(id, playerId, { idempotency_key: tx.idempotency_key, status: 'REJECTED', failure_code: 'X', processed_at: null }).catch((e) => e))).toContain('uq_tx_idempotency');
    expect(String(await insertTx(id, playerId, { external_transaction_id: tx.external_transaction_id, status: 'REJECTED', failure_code: 'X', processed_at: null }).catch((e) => e))).toContain('uq_tx_external');
    // Another provider may reuse the same identifiers.
    await insertTx(id, playerId, { provider_id: 'provider-b', idempotency_key: tx.idempotency_key, external_transaction_id: tx.external_transaction_id, status: 'REJECTED', failure_code: 'X', processed_at: null });
  });

  test('terminal transactions are frozen and nothing can be deleted', async () => {
    const { id, playerId } = await insertWallet();
    const tx = await insertTx(id, playerId, { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: null });
    expect(String(await sql`update wager_transactions set status = 'PROCESSED' where id = ${tx.id}`.catch((e) => e))).toContain('terminal');
    expect(String(await sql`delete from wager_transactions where id = ${tx.id}`.catch((e) => e))).toContain('not allowed');
  });

  test('business columns stay immutable while pending', async () => {
    const { id, playerId } = await insertWallet();
    const tx = await insertTx(id, playerId, {
      kind: 'REFUND',
      reference_external_transaction_id: 'missing',
      status: 'PENDING_REFERENCE',
      next_attempt_at: now,
      processed_at: null,
    });
    expect(String(await sql`update wager_transactions set amount = 999 where id = ${tx.id}`.catch((e) => e))).toContain('immutable');
    await sql`update wager_transactions set attempts = 1 where id = ${tx.id}`; // bookkeeping is allowed
  });

  test('reversals require a reference and a reference can be reversed only once', async () => {
    const { id, playerId } = await insertWallet();
    expect(String(await insertTx(id, playerId, { kind: 'REFUND', status: 'REJECTED', failure_code: 'X', processed_at: null }).catch((e) => e))).toContain('ck_tx_reference_required');

    const bet = await insertTx(id, playerId, { kind: 'BET', status: 'REJECTED', failure_code: 'X', processed_at: null });
    await insertTx(id, playerId, { kind: 'REFUND', reference_external_transaction_id: bet.external_transaction_id, reference_transaction_id: bet.id });
    const err = await insertTx(id, playerId, {
      kind: 'ROLLBACK',
      reference_external_transaction_id: bet.external_transaction_id,
      reference_transaction_id: bet.id,
    }).catch((e) => e);
    expect(String(err)).toContain('uq_tx_single_reversal');
  });

  test('only a rejected transaction may carry a currency other than its wallet', async () => {
    const { id, playerId } = await insertWallet();
    expect(String(await insertTx(id, playerId, { currency: 'USD' }).catch((e) => e))).toContain('is in USD but wallet');
    // CURRENCY_MISMATCH is stored as a rejection for audit.
    await insertTx(id, playerId, { currency: 'USD', status: 'REJECTED', failure_code: 'CURRENCY_MISMATCH', processed_at: null });
    // A pending one cannot be promoted to PROCESSED in the wrong currency either.
    const pending = await insertTx(id, playerId, {
      kind: 'REFUND',
      currency: 'USD',
      reference_external_transaction_id: 'missing',
      status: 'PENDING_REFERENCE',
      next_attempt_at: now,
      processed_at: null,
    });
    const err = await sql`update wager_transactions set status = 'PROCESSED', processed_at = ${now} where id = ${pending.id}`.catch((e) => e);
    expect(String(err)).toContain('is in USD but wallet');
  });

  test('status, failure code and processed_at stay consistent', async () => {
    const { id, playerId } = await insertWallet();
    expect(String(await insertTx(id, playerId, { status: 'REJECTED', processed_at: null }).catch((e) => e))).toContain('ck_tx_failure_code');
    expect(String(await insertTx(id, playerId, { status: 'PROCESSED', processed_at: null }).catch((e) => e))).toContain('ck_tx_processed_at');
    expect(String(await insertTx(id, playerId, { kind: 'BET', amount: '0.00' }).catch((e) => e))).toContain('ck_tx_positive_amount');
  });
});

describe('inbox', () => {
  test('one row per (consumer, message)', async () => {
    await sql`insert into inbox_messages values ('c', 'm-1', ${'a'.repeat(64)}, ${now}, ${now})`;
    const err = await sql`insert into inbox_messages values ('c', 'm-1', ${'a'.repeat(64)}, ${now}, ${now})`.catch((e) => e);
    expect(String(err)).toContain('duplicate key');
    await sql`insert into inbox_messages values ('other-consumer', 'm-1', ${'a'.repeat(64)}, ${now}, ${now})`;
  });
});
