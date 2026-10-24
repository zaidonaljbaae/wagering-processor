import { Injectable } from '@nestjs/common';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/wagering-events';
import { EventContext } from '../domain/events/integration-event';
import { Money, MoneyProps } from '../domain/money';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { AppLogger } from '../observability/logger';
import { Metrics } from '../observability/metrics';
import { UniqueViolationError, WalletAlreadyExistsError, WalletNotFoundError } from './errors';
import {
  Clock,
  IdGenerator,
  LedgerRepository,
  OutboxWriter,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from './ports';
import { canonicalJson, sha256Hex } from './wager-request';
import { CorrelationContext } from './wager-results';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

@Injectable()
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: { playerId: string; initialBalance: MoneyProps }, correlation: CorrelationContext): Promise<WalletView> {
    const initialBalance = Money.from(input.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();
    const opening = initialBalance.isPositive()
      ? { transactionId: this.ids.next(), entryId: this.ids.next(), at: now }
      : undefined;

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance,
      ...(opening && { opening }),
      now,
    });

    try {
      await this.uow.run(async () => {
        await this.wallets.insert(wallet);
        if (!opening || !openingEntry) return;

        // The opening credit is a real transaction with its own ledger line,
        // committed atomically with the wallet itself.
        const tx = WagerTransaction.opening({
          id: opening.transactionId,
          walletId,
          playerId: wallet.playerId,
          money: initialBalance,
          payloadHash: sha256Hex(canonicalJson({ walletId, playerId: wallet.playerId, money: initialBalance.toJSON() })),
          at: now,
        });
        await this.transactions.insert(tx);
        await this.ledger.append(openingEntry);

        const ctx = (): EventContext => ({
          eventId: this.ids.next(),
          correlationId: correlation.correlationId,
          ...(correlation.causationId !== undefined && { causationId: correlation.causationId }),
          occurredAt: now,
        });
        await this.outbox.enqueue([WagerTransactionProcessed.from(tx, ctx()), WalletBalanceChanged.from(wallet, openingEntry, ctx())]);
      });
    } catch (err) {
      if (err instanceof UniqueViolationError && err.constraint === 'uq_wallets_player_currency') {
        throw new WalletAlreadyExistsError();
      }
      throw err;
    }
    return toWalletView(wallet);
  }
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialized balance with the balance rebuilt from the ledger.
 * Never fixes anything: a divergence is logged, counted and reported.
 */
@Injectable()
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    // One snapshot for both reads, without blocking writers.
    const { wallet, summary } = await this.uow.run(
      async () => {
        const wallet = await this.wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError(walletId);
        return { wallet, summary: await this.ledger.summarize(walletId) };
      },
      { readOnly: true, repeatableRead: true },
    );

    const calculated = Money.rehydrate(summary.calculatedBalance, wallet.currency);
    const difference = wallet.balance.subtract(calculated);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.reconciliationMismatches.inc();
      this.logger.error('wallet reconciliation mismatch', {
        walletId,
        difference: difference.toString(),
        checkedEntries: summary.entries,
      });
    }

    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: summary.entries,
    };
  }
}

