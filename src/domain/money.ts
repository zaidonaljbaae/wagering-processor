import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Wire format used by every contract (HTTP, SQS, events). */
export interface MoneyProps {
  amount: string;
  currency: string;
}

export const MONEY_SCALE = 2;

// Isolated Decimal constructor so global configuration elsewhere can't affect money math.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 40 });

// Exactly two decimal places, no sign, no leading zeros, no exponent. 18 integer digits
// matches NUMERIC(20,2) in the database.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const ISO_4217 = new Set(Intl.supportedValuesOf('currency'));

export function isValidCurrency(currency: string): boolean {
  return CURRENCY_PATTERN.test(currency) && ISO_4217.has(currency);
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (!value.isFinite() || value.decimalPlaces() > MONEY_SCALE) {
      throw new InvalidMoneyError(`Amount must be finite with at most ${MONEY_SCALE} decimal places`);
    }
  }

  /**
   * Parses an amount coming from an input contract. Only non-negative, fixed
   * scale decimal strings are accepted ("25.00"); everything else is rejected
   * instead of being silently rounded.
   */
  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError('Amount must be a non-negative decimal string with exactly 2 decimal places');
    }
    return new Money(new D(props.amount), Money.assertCurrency(props.currency));
  }

  /**
   * Rebuilds a value read from storage. Postgres NUMERIC may be returned
   * without trailing zeros and may legitimately be negative in intermediate
   * calculations (e.g. reconciliation differences).
   */
  static rehydrate(amount: string, currency: string): Money {
    if (typeof amount !== 'string' || !/^-?\d+(\.\d+)?$/.test(amount)) {
      throw new InvalidMoneyError('Stored amount is not a plain decimal string');
    }
    return new Money(new D(amount), Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new D(0), Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Fixed scale decimal string, e.g. "25.00" or "-3.10". */
  toString(): string {
    // toFixed on -0 yields "-0.00"; normalise it.
    return this.value.isZero() ? (0).toFixed(MONEY_SCALE) : this.value.toFixed(MONEY_SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !isValidCurrency(currency)) {
      throw new InvalidMoneyError('Currency must be an ISO-4217 code');
    }
    return currency;
  }
}
