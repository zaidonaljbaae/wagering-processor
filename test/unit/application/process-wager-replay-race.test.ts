import { describe, expect, test } from 'bun:test';
import { ExternalTransactionConflictError } from '../../../src/application/errors';
import { PendingReferencePolicy } from '../../../src/application/pending-reference-policy';
import {
  Clock,
  IdGenerator,
  InboxRepository,
  LedgerRepository,
  OutboxWriter,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../../../src/application/ports';
import { ProcessWagerTransaction } from '../../../src/application/process-wager-transaction';
import { WagerRequest, wagerPayloadHash } from '../../../src/application/wager-request';
import { AppConfig } from '../../../src/config/app-config';
import { Money } from '../../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../../src/domain/wager-transaction';
import { Metrics } from '../../../src/observability/metrics';

/*
 * Regression: found by the load test. The lock-free replay lookup reads by
 * idempotency key, then by external id. If the original request commits
 * between the two reads, the second read returns the original itself; that
 * is a replay, not an EXTERNAL_TRANSACTION_CONFLICT.
 */

const request: WagerRequest = {
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: { amount: '5.00', currency: 'BRL' },
};

function committedOriginal(idempotencyKey: string): WagerTransaction {
  const tx = WagerTransaction.create({
    id: 'original-id',
    providerId: request.providerId,
    externalTransactionId: request.externalTransactionId,
    idempotencyKey,
    payloadHash: wagerPayloadHash(request),
    walletId: request.walletId,
    playerId: request.playerId,
    roundId: request.roundId,
    gameId: request.gameId,
    kind: WagerTransactionKind.Bet,
    money: Money.from(request.money),
    createdAt: new Date(),
  });
  tx.markProcessed(undefined, new Date(), Money.from({ amount: '95.00', currency: 'BRL' }));
  return tx;
}

/** Key lookup misses (not committed yet); external-id lookup hits (committed meanwhile). */
function useCaseWithInterleaving(original: WagerTransaction): ProcessWagerTransaction {
  const transactions = {
    findByIdempotencyKey: async () => undefined,
    findByExternalId: async () => original,
  } as unknown as WagerTransactionRepository;
  const unreachable = new Proxy({}, { get: () => () => Promise.reject(new Error('must not reach the database write path')) });
  const config = { pendingReference: { maxAttempts: 3, retryBaseMs: 10, retryMaxMs: 20 } } as AppConfig;

  return new ProcessWagerTransaction(
    unreachable as UnitOfWork,
    unreachable as WalletRepository,
    transactions,
    unreachable as LedgerRepository,
    unreachable as OutboxWriter,
    unreachable as InboxRepository,
    { now: () => new Date() } as Clock,
    { next: () => crypto.randomUUID() } as IdGenerator,
    new Metrics({ defaultMetrics: false }),
    new PendingReferencePolicy(config),
  );
}

describe('replay lookup race', () => {
  test('a row found only by external id but with the same key is a replay', async () => {
    const key = 'provider-a:ext-1';
    const result = await useCaseWithInterleaving(committedOriginal(key)).execute({
      request,
      idempotencyKey: key,
      correlation: { correlationId: 'c' },
      source: 'http',
    });
    expect(result).toEqual({
      transactionId: 'original-id',
      status: 'PROCESSED' as never,
      balance: { amount: '95.00', currency: 'BRL' },
      idempotentReplay: true,
    });
  });

  test('a row with the same external id and another key is still a conflict', async () => {
    const run = useCaseWithInterleaving(committedOriginal('another-key')).execute({
      request,
      idempotencyKey: 'provider-a:ext-1',
      correlation: { correlationId: 'c' },
      source: 'http',
    });
    await expect(run).rejects.toBeInstanceOf(ExternalTransactionConflictError);
  });
});
