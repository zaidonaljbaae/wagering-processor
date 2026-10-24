import { IntegrationEvent } from '../domain/events/integration-event';
import { InboxMessage } from '../domain/messaging/inbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

/*
 * Ports used by the use cases. They are abstract classes (not interfaces) so
 * Nest can use them as injection tokens without extra string symbols.
 */

export abstract class Clock {
  abstract now(): Date;
}

export abstract class IdGenerator {
  /** Time-ordered unique id (UUIDv7). */
  abstract next(): string;
}

export interface UnitOfWorkOptions {
  readOnly?: boolean;
  /** Snapshot isolation for consistent multi-statement reads (reconciliation). */
  repeatableRead?: boolean;
}

/** Runs `work` inside one SQL transaction. Repositories called inside join it. */
export abstract class UnitOfWork {
  abstract run<T>(work: () => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}

export abstract class WalletRepository {
  abstract findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE. Must be called inside a unit of work. */
  abstract findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  abstract insert(wallet: Wallet): Promise<void>;
  /** Persists balance + version, guarded by the version read under the lock. */
  abstract saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface PendingReferenceRef {
  id: string;
  walletId: string;
}

export abstract class WagerTransactionRepository {
  abstract findById(id: string): Promise<WagerTransaction | undefined>;
  abstract findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** True when a PROCESSED REFUND/ROLLBACK already points to `referenceTransactionId`. */
  abstract hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  abstract insert(tx: WagerTransaction): Promise<void>;
  /** Persists a transition out of PENDING_REFERENCE. */
  abstract updateFromPendingReference(tx: WagerTransaction): Promise<void>;
  abstract findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceRef[]>;
}

export interface LedgerPageItem {
  seq: string;
  entry: WalletLedgerEntry;
}

export interface LedgerSummary {
  /** credits - debits, as a decimal string. */
  calculatedBalance: string;
  entries: number;
}

export abstract class LedgerRepository {
  abstract append(entry: WalletLedgerEntry): Promise<void>;
  abstract page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPageItem[]>;
  abstract summarize(walletId: string): Promise<LedgerSummary>;
}

export abstract class OutboxWriter {
  abstract enqueue(events: ReadonlyArray<IntegrationEvent<unknown>>): Promise<void>;
}

export abstract class InboxRepository {
  /** Records the message as processed; returns false when it was already recorded (duplicate). */
  abstract tryRecord(message: InboxMessage): Promise<boolean>;
}

/** Test hook to simulate crashes at precise points. No-op in normal runs. */
export abstract class FaultInjector {
  abstract hit(point: FaultPoint): void;
}

export type FaultPoint = 'after_commit_before_ack' | 'outbox_after_claim';
