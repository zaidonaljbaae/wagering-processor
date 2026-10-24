import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, DomainValidationError, InsufficientFundsError, UnbalancedLedgerEntryError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-01-01T00:00:00Z');
let seq = 0;
const movement = () => ({ transactionId: `tx-${++seq}`, entryId: `entry-${seq}`, at: now });

function openWallet(initial = '100.00') {
  return Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(initial), opening: movement(), now });
}

describe('Wallet', () => {
  test('opens at version 1 with an OPENING credit entry for a positive balance', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('100.00');
  });

  test('opens without a ledger entry when the initial balance is zero', () => {
    const { wallet, openingEntry } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('0.00'), now });
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test('requires an opening movement for a positive initial balance', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), now })).toThrow(DomainValidationError);
  });

  test('debit and credit move the balance, bump the version and return a balanced entry', () => {
    const { wallet } = openWallet('100.00');

    const debit = wallet.debit(brl('30.00'), movement());
    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('70.00');

    const credit = wallet.credit(brl('5.50'), movement());
    expect(wallet.balance.toString()).toBe('75.50');
    expect(wallet.version).toBe(3);
    expect(credit.isBalanced()).toBe(true);
  });

  test('never goes negative and leaves state untouched on failure', () => {
    const { wallet } = openWallet('10.00');
    expect(wallet.canDebit(brl('10.01'))).toBe(false);
    expect(() => wallet.debit(brl('10.01'), movement())).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('allows debiting the exact balance', () => {
    const { wallet } = openWallet('10.00');
    wallet.debit(brl('10.00'), movement());
    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('rejects movements in another currency', () => {
    const { wallet } = openWallet();
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit(usd, movement())).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd, movement())).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('rejects zero movements (they would create an empty ledger line)', () => {
    const { wallet } = openWallet();
    expect(() => wallet.credit(brl('0.00'), movement())).toThrow(DomainValidationError);
  });

  test('rehydrate restores state without re-validation', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: now,
      updatedAt: now,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe('42.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    createdAt: now,
  };

  test('validates arithmetic on create', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('16.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejects a debit that would go negative', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('1.00'),
      balanceBefore: brl('5.00'),
      balanceAfter: brl('4.00'),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { money: Money }).money = brl('2.00');
    }).toThrow(TypeError);
  });
});
