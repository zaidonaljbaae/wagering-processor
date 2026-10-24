import { describe, expect, test } from 'bun:test';
import { DomainValidationError, InvalidTransactionStateError } from '../../../src/domain/errors';
import { FailureCode } from '../../../src/domain/failure-code';
import { Money } from '../../../src/domain/money';
import { settle } from '../../../src/domain/wager-settlement';
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-01-01T00:00:00Z');
let seq = 0;
const nextId = () => `id-${++seq}`;

function wallet(balance = '100.00'): Wallet {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balance: brl(balance),
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function tx(kind: Kind, amount: string, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${nextId()}`;
  return WagerTransaction.create({
    id: nextId(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'hash',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount),
    createdAt: now,
    ...overrides,
  });
}

function run(w: Wallet, t: WagerTransaction, reference?: WagerTransaction, alreadyReversed = false) {
  return settle({ wallet: w, transaction: t, reference, referenceAlreadyReversed: alreadyReversed, ledgerEntryId: nextId(), at: now });
}

/** A processed transaction to be used as a reference. */
function processed(kind: Kind, amount: string, w = wallet('1000.00')): WagerTransaction {
  const t = tx(kind, amount);
  expect(run(w, t).status).toBe(Status.Processed);
  return t;
}

describe('BET', () => {
  test('debits the wallet and produces one DEBIT entry', () => {
    const w = wallet('100.00');
    const bet = tx(Kind.Bet, '25.00');
    const outcome = run(w, bet);
    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) throw new Error('unreachable');
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toString()).toBe('75.00');
    expect(bet.status).toBe(Status.Processed);
    expect(bet.balanceAfter?.toString()).toBe('75.00');
  });

  test('is rejected with INSUFFICIENT_FUNDS and leaves the wallet untouched', () => {
    const w = wallet('10.00');
    const bet = tx(Kind.Bet, '10.01');
    expect(run(w, bet)).toEqual({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(w.balance.toString()).toBe('10.00');
    expect(w.version).toBe(1);
    expect(bet.balanceAfter?.toString()).toBe('10.00');
  });

  test('cannot carry a reference', () => {
    expect(() => tx(Kind.Bet, '1.00', { referenceExternalTransactionId: 'x' })).toThrow(DomainValidationError);
  });
});

describe('WIN', () => {
  test('credits the wallet', () => {
    const w = wallet('100.00');
    const outcome = run(w, tx(Kind.Win, '50.00'));
    expect(outcome.status).toBe(Status.Processed);
    expect(w.balance.toString()).toBe('150.00');
  });

  test('may reference the BET of the same round', () => {
    const w = wallet('100.00');
    const bet = processed(Kind.Bet, '10.00', w);
    const win = tx(Kind.Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(w, win, bet).status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test('referencing a BET from another round is a mismatch', () => {
    const w = wallet('100.00');
    const bet = processed(Kind.Bet, '10.00', w);
    const win = tx(Kind.Win, '30.00', { roundId: 'round-2', referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(w, win, bet)).toEqual({ status: Status.Rejected, failureCode: FailureCode.ReferenceMismatch });
  });
});

describe('LOSS', () => {
  test('is processed without moving the balance or creating an entry', () => {
    const w = wallet('100.00');
    const loss = tx(Kind.Loss, '0.00');
    expect(run(w, loss)).toEqual({ status: Status.Processed, entry: undefined });
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
    expect(loss.affectsBalance()).toBe(false);
  });
});

describe('REFUND', () => {
  test('requires a reference', () => {
    expect(() => tx(Kind.Refund, '10.00')).toThrow(DomainValidationError);
  });

  test('credits back a processed BET', () => {
    const w = wallet('100.00');
    const bet = processed(Kind.Bet, '40.00', w);
    const refund = tx(Kind.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const outcome = run(w, refund, bet);
    expect(outcome.status).toBe(Status.Processed);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('can only reference a BET', () => {
    const w = wallet('100.00');
    const win = processed(Kind.Win, '10.00', w);
    const refund = tx(Kind.Refund, '10.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(run(w, refund, win)).toEqual({ status: Status.Rejected, failureCode: FailureCode.InvalidReferenceKind });
  });

  test('must match the referenced amount', () => {
    const w = wallet('100.00');
    const bet = processed(Kind.Bet, '40.00', w);
    const refund = tx(Kind.Refund, '39.99', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(w, refund, bet)).toEqual({ status: Status.Rejected, failureCode: FailureCode.ReferenceAmountMismatch });
  });

  test('cannot reverse the same BET twice', () => {
    const w = wallet('100.00');
    const bet = processed(Kind.Bet, '40.00', w);
    const refund = tx(Kind.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(w, refund, bet, true)).toEqual({ status: Status.Rejected, failureCode: FailureCode.ReferenceAlreadyReversed });
    expect(w.balance.toString()).toBe('60.00');
  });

  test('waits when the reference has not arrived yet', () => {
    const w = wallet('100.00');
    const refund = tx(Kind.Refund, '40.00', { referenceExternalTransactionId: 'not-yet' });
    expect(run(w, refund, undefined)).toEqual({ status: Status.PendingReference });
    expect(refund.status).toBe(Status.Pending); // scheduling is the caller's job
  });

  test('is rejected when the reference was itself rejected', () => {
    const w = wallet('5.00');
    const bet = tx(Kind.Bet, '40.00');
    run(w, bet); // rejected: insufficient funds
    const refund = tx(Kind.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(w, refund, bet)).toEqual({ status: Status.Rejected, failureCode: FailureCode.ReferenceNotProcessed });
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits the wallet', () => {
    const w = wallet('100.00');
    const bet = processed(Kind.Bet, '25.00', w);
    const rollback = tx(Kind.Rollback, '25.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const outcome = run(w, rollback, bet);
    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) throw new Error('unreachable');
    expect(outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('of a WIN debits the wallet', () => {
    const w = wallet('100.00');
    const win = processed(Kind.Win, '50.00', w);
    const rollback = tx(Kind.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    const outcome = run(w, rollback, win);
    if (outcome.status !== Status.Processed) throw new Error('expected processed');
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('of a REFUND debits the wallet', () => {
    const w = wallet('100.00');
    const bet = processed(Kind.Bet, '20.00', w);
    const refund = tx(Kind.Refund, '20.00', { referenceExternalTransactionId: bet.externalTransactionId });
    run(w, refund, bet);
    const rollback = tx(Kind.Rollback, '20.00', { referenceExternalTransactionId: refund.externalTransactionId });
    expect(run(w, rollback, refund).status).toBe(Status.Processed);
    expect(w.balance.toString()).toBe('80.00');
  });

  test('cannot reference a LOSS', () => {
    const w = wallet('100.00');
    const loss = tx(Kind.Loss, '0.00');
    run(w, loss);
    const rollback = tx(Kind.Rollback, '0.01', { referenceExternalTransactionId: loss.externalTransactionId });
    expect(run(w, rollback, loss)).toEqual({ status: Status.Rejected, failureCode: FailureCode.InvalidReferenceKind });
  });

  test('that would make the balance negative is rejected with a distinct code', () => {
    const w = wallet('100.00');
    const win = processed(Kind.Win, '50.00', w);
    w.debit(brl('140.00'), { transactionId: 'spent', entryId: nextId(), at: now }); // player spent the win
    const rollback = tx(Kind.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(run(w, rollback, win)).toEqual({ status: Status.Rejected, failureCode: FailureCode.ReversalInsufficientFunds });
    expect(w.balance.toString()).toBe('10.00');
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
  });
});

describe('cross-cutting rules', () => {
  test('currency conflict is rejected', () => {
    const w = wallet('100.00');
    const bet = tx(Kind.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) });
    expect(run(w, bet)).toEqual({ status: Status.Rejected, failureCode: FailureCode.CurrencyMismatch });
    expect(w.version).toBe(1);
  });

  test('a player cannot use somebody else\'s wallet', () => {
    const bet = tx(Kind.Bet, '1.00', { playerId: 'player-2' });
    expect(run(wallet(), bet)).toEqual({ status: Status.Rejected, failureCode: FailureCode.WalletPlayerMismatch });
  });

  test('OPENING cannot be created from external input', () => {
    expect(() => tx(Kind.Opening, '1.00')).toThrow(DomainValidationError);
  });

  test('zero amounts are only valid for LOSS', () => {
    expect(() => tx(Kind.Bet, '0.00')).toThrow(DomainValidationError);
    expect(() => tx(Kind.Win, '0.00')).toThrow(DomainValidationError);
  });
});

describe('WagerTransaction state machine', () => {
  test('terminal states cannot transition', () => {
    const bet = processed(Kind.Bet, '1.00');
    expect(bet.isTerminal()).toBe(true);
    expect(() => bet.reject(FailureCode.InsufficientFunds, now, brl('0.00'))).toThrow(InvalidTransactionStateError);
    expect(() => bet.fail(FailureCode.ProcessingFailed, now)).toThrow(InvalidTransactionStateError);
    expect(() => bet.markProcessed(undefined, now, brl('0.00'))).toThrow(InvalidTransactionStateError);
  });

  test('pending reference bookkeeping', () => {
    const refund = tx(Kind.Refund, '1.00', { referenceExternalTransactionId: 'x' });
    expect(() => refund.scheduleReferenceRetry(now, now)).toThrow(InvalidTransactionStateError);
    refund.markPendingReference(now, new Date(now.getTime() + 1000), brl('5.00'));
    expect(refund.status).toBe(Status.PendingReference);
    refund.scheduleReferenceRetry(now, new Date(now.getTime() + 2000));
    expect(refund.attempts).toBe(1);
    refund.reject(FailureCode.ReferenceNotFound, now, brl('5.00'));
    expect(refund.isTerminal()).toBe(true);
  });

  test('same idempotency key with a different payload is detected through the hash', () => {
    const bet = tx(Kind.Bet, '1.00', { payloadHash: 'abc' });
    expect(bet.matchesPayload('abc')).toBe(true);
    expect(bet.matchesPayload('abd')).toBe(false);
  });
});
