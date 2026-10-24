import { Injectable } from '@nestjs/common';
import { InboxMessage } from '../domain/messaging/inbox-message';
import { Money } from '../domain/money';
import { settle } from '../domain/wager-settlement';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { logContext } from '../observability/logger';
import { Metrics, Source } from '../observability/metrics';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  UniqueViolationError,
  WalletNotFoundError,
} from './errors';
import { PendingReferencePolicy } from './pending-reference-policy';
import {
  Clock,
  IdGenerator,
  InboxRepository,
  LedgerRepository,
  OutboxWriter,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from './ports';
import { WagerRequest, wagerPayloadHash } from './wager-request';
import { CorrelationContext, eventsFor, toWagerResult, WagerResult } from './wager-results';

export interface ProcessWagerCommand {
  request: WagerRequest;
  idempotencyKey: string;
  correlation: CorrelationContext;
  source: Source;
  /** Present when the command comes from a queue: deduplicated by (consumerName, messageId). */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

type DuplicateReason = 'idempotency' | 'inbox' | 'race';

class DuplicateMessage extends Error {}

/**
 * Single entry point for provider transactions, used by both HTTP and SQS.
 *
 * Concurrency model: the wallet row is locked (SELECT ... FOR UPDATE) for the
 * whole transaction, so all operations on one wallet are serialized while
 * different wallets run in parallel. Idempotency is checked again *under* the
 * lock, which is what makes 50 identical concurrent requests produce one debit.
 * Unique constraints remain the last line of defence.
 */
@Injectable()
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxWriter,
    private readonly inbox: InboxRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly pendingPolicy: PendingReferencePolicy,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<WagerResult> {
    const { request, idempotencyKey, source } = command;
    const stopTimer = this.metrics.processingDuration.startTimer({ source });
    logContext.assign({ providerId: request.providerId, walletId: request.walletId });

    try {
      // Validate everything that can be validated before touching the database.
      const now = this.clock.now();
      const candidate = WagerTransaction.create({
        id: this.ids.next(),
        providerId: request.providerId,
        externalTransactionId: request.externalTransactionId,
        idempotencyKey,
        payloadHash: wagerPayloadHash(request),
        walletId: request.walletId,
        playerId: request.playerId,
        roundId: request.roundId,
        gameId: request.gameId,
        kind: request.kind as WagerTransactionKind,
        money: Money.from(request.money),
        ...(request.referenceExternalTransactionId !== undefined && {
          referenceExternalTransactionId: request.referenceExternalTransactionId,
        }),
        createdAt: now,
      });

      // Fast path without locks: most HTTP duplicates end here. Queue messages
      // skip it, because every delivery must leave its inbox row even when the
      // operation itself is a replay (e.g. first seen over HTTP).
      if (!command.inbox) {
        const known = await this.findReplay(candidate, source, 'idempotency');
        if (known) return known;
      }

      try {
        const result = await this.uow.run(() => this.processLocked(candidate, command, now));
        this.metrics.transactions.inc({ status: result.status, kind: candidate.kind, source });
        return result;
      } catch (err) {
        if (err instanceof DuplicateMessage || err instanceof UniqueViolationError) {
          // Lost a race with another delivery of the same message or transaction.
          const reason = err instanceof DuplicateMessage ? 'inbox' : 'race';
          const replay = await this.findReplay(candidate, source, reason);
          if (replay) return replay;
        }
        throw err;
      }
    } finally {
      stopTimer();
    }
  }

  private async processLocked(tx: WagerTransaction, command: ProcessWagerCommand, now: Date): Promise<WagerResult> {
    const stopLockTimer = this.metrics.lockWait.startTimer();
    const wallet = await this.wallets.findByIdForUpdate(tx.walletId);
    stopLockTimer();
    if (!wallet) {
      throw new WalletNotFoundError(tx.walletId);
    }

    if (command.inbox) {
      const fresh = await this.inbox.tryRecord(InboxMessage.receive({ ...command.inbox, receivedAt: now }));
      if (!fresh) throw new DuplicateMessage();
    }

    // Re-check under the lock: a concurrent request may have committed meanwhile.
    // For queue messages this is also the first idempotency check.
    const known = await this.findReplay(tx, command.source, command.inbox ? 'idempotency' : 'race');
    if (known) return known;

    const reference = tx.hasReference()
      ? await this.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId!)
      : undefined;
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

    if (outcome.status === WagerTransactionStatus.PendingReference) {
      tx.markPendingReference(now, this.pendingPolicy.nextAttemptAt(now, 0), wallet.balance);
    }

    // Insert order follows the foreign keys: transaction before its ledger entry.
    await this.transactions.insert(tx);
    const entry = outcome.status === WagerTransactionStatus.Processed ? outcome.entry : undefined;
    if (entry) {
      await this.wallets.saveBalance(wallet, versionBefore);
      await this.ledger.append(entry);
    }
    await this.outbox.enqueue(eventsFor(tx, wallet, entry, command.correlation, this.ids, now));

    logContext.assign({ transactionId: tx.id });
    return toWagerResult(tx, false);
  }

  /**
   * Looks for an earlier transaction with the same idempotency key (replay or
   * conflict) or the same external id under another key (conflict).
   */
  private async findReplay(
    candidate: WagerTransaction,
    source: Source,
    reason: DuplicateReason,
  ): Promise<WagerResult | undefined> {
    const existing =
      (await this.transactions.findByIdempotencyKey(candidate.providerId, candidate.idempotencyKey)) ??
      (await this.transactions.findByExternalId(candidate.providerId, candidate.externalTransactionId));
    if (!existing) return undefined;

    logContext.assign({ transactionId: existing.id });
    // The two lookups are separate statements: the original may commit between
    // them, so a row found by external id can still be this very request.
    if (existing.idempotencyKey !== candidate.idempotencyKey) {
      this.metrics.idempotencyConflicts.inc({ source });
      throw new ExternalTransactionConflictError(existing.id);
    }
    if (!existing.matchesPayload(candidate.payloadHash)) {
      this.metrics.idempotencyConflicts.inc({ source });
      throw new IdempotencyConflictError(existing.id);
    }
    this.metrics.duplicates.inc({ source, reason });
    return toWagerResult(existing, true);
  }
}
