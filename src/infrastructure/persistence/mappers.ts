import { FailureCode, isFailureCode } from '../../domain/failure-code';
import { Money } from '../../domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from './schemas';

/* Record <-> aggregate translation. Reads always go through `rehydrate`. */

export function walletToDomain(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: Money.rehydrate(r.balanceAmount, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecord(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balanceAmount: w.balance.toString(),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function transactionToDomain(r: WagerTransactionRecord): WagerTransaction {
  const failureCode = r.failureCode ?? undefined;
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId ?? undefined,
    gameId: r.gameId ?? undefined,
    kind: r.kind as WagerTransactionKind,
    money: Money.rehydrate(r.amount, r.currency),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: failureCode && isFailureCode(failureCode) ? (failureCode as FailureCode) : undefined,
    processedAt: r.processedAt ?? undefined,
    balanceAfter: r.balanceAfterAmount !== null ? Money.rehydrate(r.balanceAfterAmount, r.currency) : undefined,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt ?? undefined,
  });
}

/** Mutable columns only: what may change while a transaction is PENDING_REFERENCE. */
export function transactionStateColumns(tx: WagerTransaction) {
  return {
    status: tx.status,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    balanceAfterAmount: tx.balanceAfter?.toString() ?? null,
    attempts: tx.attempts,
    nextAttemptAt: tx.nextAttemptAt ?? null,
    updatedAt: tx.updatedAt,
    processedAt: tx.processedAt ?? null,
  };
}

export function transactionToRecord(tx: WagerTransaction): WagerTransactionRecord {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    amount: tx.money.toString(),
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    createdAt: tx.createdAt,
    ...transactionStateColumns(tx),
  };
}

export function ledgerEntryToDomain(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: Money.rehydrate(r.amount, r.currency),
    balanceBefore: Money.rehydrate(r.balanceBefore, r.currency),
    balanceAfter: Money.rehydrate(r.balanceAfter, r.currency),
    createdAt: r.createdAt,
  });
}

export function outboxToRecord(m: OutboxMessage): OutboxRecord {
  return {
    id: m.id,
    aggregateId: m.aggregateId,
    eventType: m.eventType,
    // Deep, plain-JSON copy: the event payload is frozen and MikroORM walks
    // (and may rewrite) parameters in place.
    payload: JSON.parse(JSON.stringify(m.payload)) as Record<string, unknown>,
    occurredAt: m.occurredAt,
    attempts: m.attempts,
    nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
    lockedUntil: null,
    publishedAt: m.publishedAt ?? null,
    lastError: null,
  };
}

export function outboxToDomain(r: OutboxRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    publishedAt: r.publishedAt ?? undefined,
  });
}

export function ledgerEntryToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: e.money.toString(),
    currency: e.money.currency,
    balanceBefore: e.balanceBefore.toString(),
    balanceAfter: e.balanceAfter.toString(),
    createdAt: e.createdAt,
  };
}
