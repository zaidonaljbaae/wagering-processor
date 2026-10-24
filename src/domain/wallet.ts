import { CurrencyMismatchError, DomainValidationError, InsufficientFundsError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identifiers and timestamp for a single balance movement. */
export interface Movement {
  transactionId: string;
  entryId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Required when initialBalance > 0: the OPENING credit must be on the ledger. */
  opening?: Movement;
  now: Date;
}

/**
 * Aggregate root for a player's balance in one currency.
 *
 * Every balance change goes through debit()/credit(), which return the ledger
 * entry describing it. There is no other way to touch the balance, so the
 * "every change has a ledger entry" invariant holds by construction.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet. A positive initial balance yields the OPENING ledger entry;
   * the wallet still starts at version 1 because the opening is part of its creation.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new DomainValidationError('Initial balance cannot be negative');
    }

    const currency = initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, initialBalance, 1, props.now, props.now);
    if (initialBalance.isZero()) {
      return { wallet };
    }

    if (!props.opening) {
      throw new DomainValidationError('A positive initial balance requires an OPENING movement');
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: initialBalance,
      createdAt: props.opening.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence; does not re-validate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, movement: Movement): WalletLedgerEntry {
    this.assertMovable(money);
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(`Wallet ${this.id} has insufficient funds`);
    }
    return this.apply(LedgerDirection.Debit, money, this._balance.subtract(money), movement);
  }

  credit(money: Money, movement: Movement): WalletLedgerEntry {
    this.assertMovable(money);
    return this.apply(LedgerDirection.Credit, money, this._balance.add(money), movement);
  }

  private apply(direction: LedgerDirection, money: Money, balanceAfter: Money, movement: Movement): WalletLedgerEntry {
    // Build (and validate) the entry before mutating, so a failure leaves the wallet untouched.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new DomainValidationError('Movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
