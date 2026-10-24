import { Injectable } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { ConcurrencyConflictError, UniqueViolationError } from '../../application/errors';
import {
  InboxRepository,
  LedgerPageItem,
  LedgerRepository,
  LedgerSummary,
  OutboxWriter,
  PendingReferenceRef,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { IntegrationEvent } from '../../domain/events/integration-event';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { Database } from './database';
import { uniqueViolationConstraint } from './db-errors';
import {
  ledgerEntryToDomain,
  ledgerEntryToRecord,
  outboxToRecord,
  transactionStateColumns,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from './mappers';
import { LedgerEntrySchema, OutboxSchema, WagerTransactionSchema, WalletSchema } from './schemas';

interface LedgerRow {
  id: string;
  seq: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

async function translateUnique<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    const constraint = uniqueViolationConstraint(err);
    if (constraint) throw new UniqueViolationError(constraint);
    throw err;
  }
}

@Injectable()
export class MikroWalletRepository extends WalletRepository {
  constructor(private readonly db: Database) {
    super();
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.db.em().findOne(WalletSchema, { id }, { disableIdentityMap: true });
    return record ? walletToDomain(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    if (!this.db.inTransaction()) {
      throw new Error('findByIdForUpdate requires an active unit of work');
    }
    // Row-level lock on this wallet only; other wallets proceed in parallel.
    const record = await this.db
      .em()
      .findOne(WalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return record ? walletToDomain(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await translateUnique(() => this.db.em().insert(WalletSchema, walletToRecord(wallet)));
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.db.em().nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`Wallet ${wallet.id} changed under the lock (expected v${expectedVersion})`);
    }
  }
}

@Injectable()
export class MikroWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly db: Database) {
    super();
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.db.em().count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await translateUnique(() => this.db.em().insert(WagerTransactionSchema, transactionToRecord(tx)));
  }

  async updateFromPendingReference(tx: WagerTransaction): Promise<void> {
    const affected = await translateUnique(() =>
      this.db
        .em()
        .nativeUpdate(
          WagerTransactionSchema,
          { id: tx.id, status: WagerTransactionStatus.PendingReference },
          transactionStateColumns(tx),
        ),
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`Transaction ${tx.id} is no longer PENDING_REFERENCE`);
    }
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceRef[]> {
    const rows = await this.db
      .em()
      .find(
        WagerTransactionSchema,
        { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
        { fields: ['id', 'walletId'], orderBy: { nextAttemptAt: 'asc' }, limit, disableIdentityMap: true },
      );
    return rows.map((r) => ({ id: r.id, walletId: r.walletId }));
  }

  private async findOne(where: Record<string, unknown>): Promise<WagerTransaction | undefined> {
    const record = await this.db.em().findOne(WagerTransactionSchema, where, { disableIdentityMap: true });
    return record ? transactionToDomain(record) : undefined;
  }
}

@Injectable()
export class MikroLedgerRepository extends LedgerRepository {
  constructor(private readonly db: Database) {
    super();
  }

  async append(entry: WalletLedgerEntry): Promise<void> {
    await translateUnique(() => this.db.em().insert(LedgerEntrySchema, ledgerEntryToRecord(entry)));
  }

  async page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPageItem[]> {
    // seq is a database identity column: strictly increasing, so it makes a stable keyset cursor.
    const rows = await this.db.em().execute<LedgerRow[]>(
      `select id, seq::text as seq, wallet_id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after, created_at
         from wallet_ledger_entries
        where wallet_id = ? and seq > ?
        order by seq asc
        limit ?`,
      [walletId, afterSeq ?? '0', limit],
    );
    return rows.map((r) => ({
      seq: r.seq,
      entry: ledgerEntryToDomain({
        id: r.id,
        walletId: r.wallet_id,
        transactionId: r.transaction_id,
        direction: r.direction,
        amount: r.amount,
        currency: r.currency,
        balanceBefore: r.balance_before,
        balanceAfter: r.balance_after,
        createdAt: new Date(r.created_at),
      }),
    }));
  }

  async summarize(walletId: string): Promise<LedgerSummary> {
    const [row] = await this.db.em().execute<Array<{ calculated: string; entries: string }>>(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as calculated,
              count(*)::text as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    return { calculatedBalance: row?.calculated ?? '0.00', entries: Number(row?.entries ?? 0) };
  }
}

@Injectable()
export class MikroInboxRepository extends InboxRepository {
  constructor(private readonly db: Database) {
    super();
  }

  async tryRecord(message: InboxMessage): Promise<boolean> {
    if (!this.db.inTransaction()) {
      throw new Error('Inbox writes must share the business transaction');
    }
    // The row commits together with the business effect, so it is recorded
    // as processed right away.
    message.markProcessed(message.receivedAt);
    const rows = await this.db.em().execute<Array<{ message_id: string }>>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt],
    );
    return rows.length === 1;
  }
}

@Injectable()
export class MikroOutboxWriter extends OutboxWriter {
  constructor(private readonly db: Database) {
    super();
  }

  async enqueue(events: ReadonlyArray<IntegrationEvent<unknown>>): Promise<void> {
    if (events.length === 0) return;
    if (!this.db.inTransaction()) {
      throw new Error('Outbox writes must share the business transaction');
    }
    const records = events.map((event) => outboxToRecord(OutboxMessage.enqueue(event)));
    await this.db.em().insertMany(OutboxSchema, records);
  }
}
