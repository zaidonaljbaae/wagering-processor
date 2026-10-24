import { EventContext } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wagering-events';
import { IntegrationEvent } from '../domain/events/integration-event';
import { FailureCode } from '../domain/failure-code';
import { MoneyProps } from '../domain/money';
import { WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { IdGenerator } from './ports';

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Balance observed when the outcome was decided; stable across replays. */
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export function toWagerResult(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.balanceAfter?.toJSON() ?? null,
    ...(tx.failureCode && { failureCode: tx.failureCode }),
    idempotentReplay,
  };
}

export interface CorrelationContext {
  correlationId: string;
  causationId?: string;
}

/** Builds the integration events that describe what just happened to `tx`. */
export function eventsFor(
  tx: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  correlation: CorrelationContext,
  ids: IdGenerator,
  at: Date,
): IntegrationEvent<unknown>[] {
  const ctx = (): EventContext => ({
    eventId: ids.next(),
    correlationId: correlation.correlationId,
    ...(correlation.causationId !== undefined && { causationId: correlation.causationId }),
    occurredAt: at,
  });

  switch (tx.status) {
    case WagerTransactionStatus.Processed: {
      const events: IntegrationEvent<unknown>[] = [WagerTransactionProcessed.from(tx, ctx())];
      if (entry) events.push(WalletBalanceChanged.from(wallet, entry, ctx()));
      return events;
    }
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(tx, ctx())];
    case WagerTransactionStatus.PendingReference:
      return [WagerTransactionPendingReference.from(tx, ctx())];
    default:
      return [];
  }
}
