import { FailureCode } from '../failure-code';
import { MoneyProps } from '../money';
import { WagerTransaction, WagerTransactionKind } from '../wager-transaction';
import { Wallet } from '../wallet';
import { LedgerDirection, WalletLedgerEntry } from '../wallet-ledger-entry';
import { EventContext, IntegrationEvent } from './integration-event';

interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
}

function transactionData(tx: WagerTransaction): TransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  };
}

function envelope<T>(aggregateId: string, data: T, ctx: EventContext) {
  return {
    eventId: ctx.eventId,
    aggregateId,
    correlationId: ctx.correlationId,
    ...(ctx.causationId !== undefined && { causationId: ctx.causationId }),
    occurredAt: ctx.occurredAt,
    data,
  };
}

export interface WagerTransactionProcessedData extends TransactionEventData {
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Any applied transaction, including LOSS (which does not move the balance). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      envelope(
        tx.id,
        {
          ...transactionData(tx),
          referenceTransactionId: tx.referenceTransactionId ?? null,
          balanceAfter: tx.balanceAfter!.toJSON(),
          processedAt: tx.processedAt!.toISOString(),
        },
        ctx,
      ),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(envelope(tx.id, { ...transactionData(tx), failureCode: tx.failureCode! }, ctx));
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      envelope(tx.id, { ...transactionData(tx), nextAttemptAt: tx.nextAttemptAt!.toISOString() }, ctx),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitted only when the balance actually changes. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      envelope(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
        ctx,
      ),
    );
  }
}
