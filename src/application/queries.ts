import { Injectable } from '@nestjs/common';
import { FailureCode } from '../domain/failure-code';
import { MoneyProps } from '../domain/money';
import { WagerTransaction } from '../domain/wager-transaction';
import { NotFoundError, RequestValidationError, WalletNotFoundError } from './errors';
import { LedgerRepository, WagerTransactionRepository, WalletRepository } from './ports';
import { toWalletView, WalletView } from './wallet-use-cases';

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: FailureCode | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export function toTransactionView(tx: WagerTransaction): TransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    balanceAfter: tx.balanceAfter?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

const CURSOR_PATTERN = /^v1:(\d{1,19})$/;

/** Opaque, stable keyset cursor: base64url("v1:<seq>"). */
export const ledgerCursor = {
  encode(seq: string): string {
    return Buffer.from(`v1:${seq}`, 'utf8').toString('base64url');
  },
  decode(cursor: string): string {
    const match = /^[A-Za-z0-9_-]{1,64}$/.test(cursor)
      ? CURSOR_PATTERN.exec(Buffer.from(cursor, 'base64url').toString('utf8'))
      : null;
    if (!match) {
      throw new RequestValidationError([{ path: 'cursor', message: 'invalid cursor' }]);
    }
    return match[1]!;
  },
};

@Injectable()
export class WageringQueries {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  async wallet(walletId: string): Promise<WalletView> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }

  async ledgerPage(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const afterSeq = cursor !== undefined ? ledgerCursor.decode(cursor) : undefined;
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);

    // Fetch one extra row to know whether another page exists.
    const rows = await this.ledger.page(walletId, afterSeq, limit + 1);
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(({ entry }) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? ledgerCursor.encode(last.seq) : null,
    };
  }

  async transaction(transactionId: string): Promise<TransactionView> {
    const tx = await this.transactions.findById(transactionId);
    if (!tx) throw new NotFoundError(`Transaction ${transactionId} not found`);
    return toTransactionView(tx);
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.transactions.findByExternalId(providerId, externalTransactionId);
    if (!tx) throw new NotFoundError('Transaction not found');
    return toTransactionView(tx);
  }
}
