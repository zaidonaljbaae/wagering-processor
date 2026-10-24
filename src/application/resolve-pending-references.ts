import { Injectable } from '@nestjs/common';
import { FailureCode } from '../domain/failure-code';
import { settle } from '../domain/wager-settlement';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { AppLogger, errorFields, logContext } from '../observability/logger';
import { Metrics } from '../observability/metrics';
import { PendingReferencePolicy } from './pending-reference-policy';
import {
  Clock,
  IdGenerator,
  LedgerRepository,
  OutboxWriter,
  PendingReferenceRef,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from './ports';
import { eventsFor } from './wager-results';

export type PendingResolution = 'processed' | 'rejected' | 'expired' | 'rescheduled' | 'skipped';

/**
 * Re-evaluates PENDING_REFERENCE transactions whose next attempt is due.
 * Safe to run on every instance at once: each transaction is handled under
 * its wallet lock and re-read before acting, so a second worker just skips it.
 */
@Injectable()
export class ResolvePendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly policy: PendingReferencePolicy,
    private readonly logger: AppLogger,
  ) {}

  /** Processes one batch; returns how many transactions reached a terminal state. */
  async runOnce(batchSize: number): Promise<number> {
    const due = await this.transactions.findDuePendingReferences(this.clock.now(), batchSize);
    let settled = 0;
    for (const ref of due) {
      try {
        const outcome = await logContext.run({ transactionId: ref.id, walletId: ref.walletId }, () => this.resolve(ref));
        if (outcome === 'processed' || outcome === 'rejected' || outcome === 'expired') settled++;
      } catch (err) {
        // One bad row must not block the rest; it stays due and is retried next round.
        this.logger.error('pending reference resolution failed', { transactionId: ref.id, ...errorFields(err) });
      }
    }
    return settled;
  }

  async resolve(ref: PendingReferenceRef): Promise<PendingResolution> {
    return this.uow.run(async () => {
      const wallet = await this.wallets.findByIdForUpdate(ref.walletId);
      const tx = await this.transactions.findById(ref.id);
      const now = this.clock.now();
      if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return 'skipped';
      if (tx.nextAttemptAt && tx.nextAttemptAt > now) return 'skipped'; // another worker got here first

      const reference = await this.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId!);
      const referenceAlreadyReversed = reference ? await this.transactions.hasProcessedReversal(reference.id) : false;
      const versionBefore = wallet.version;
      const outcome = settle({
        wallet,
        transaction: tx,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: this.ids.next(),
        at: now,
      });

      let resolution: PendingResolution;
      if (outcome.status === WagerTransactionStatus.PendingReference) {
        if (this.policy.isExhausted(tx.attempts + 1)) {
          tx.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
          this.metrics.pendingReferenceExpired.inc();
          resolution = 'expired';
        } else {
          tx.scheduleReferenceRetry(now, this.policy.nextAttemptAt(now, tx.attempts + 1));
          this.metrics.retries.inc({ component: 'pending_reference' });
          resolution = 'rescheduled';
        }
      } else {
        resolution = outcome.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
      }

      await this.transactions.updateFromPendingReference(tx);
      const entry = outcome.status === WagerTransactionStatus.Processed ? outcome.entry : undefined;
      if (entry) {
        await this.wallets.saveBalance(wallet, versionBefore);
        await this.ledger.append(entry);
      }
      // A reschedule is bookkeeping, not news: only terminal outcomes publish events.
      if (resolution !== 'rescheduled') {
        await this.outbox.enqueue(eventsFor(tx, wallet, entry, { correlationId: tx.id, causationId: tx.id }, this.ids, now));
        this.metrics.transactions.inc({ status: tx.status, kind: tx.kind, source: 'pending_reference' });
        this.logger.info('pending reference resolved', { resolution, status: tx.status, failureCode: tx.failureCode });
      }
      return resolution;
    });
  }
}
