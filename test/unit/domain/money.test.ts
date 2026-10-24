import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('parsing', () => {
    test.each(['0.00', '25.00', '1000.10', '999999999999999999.99'])('accepts %s', (amount) => {
      expect(brl(amount).toString()).toBe(amount);
    });

    test.each([
      ['empty string', ''],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['scientific notation', '1e3'],
      ['scientific notation with decimals', '1.00e2'],
      ['more than 2 decimals', '1.005'],
      ['fewer than 2 decimals', '1.5'],
      ['no decimals', '25'],
      ['negative', '-1.00'],
      ['explicit plus sign', '+1.00'],
      ['leading zeros', '01.00'],
      ['whitespace', ' 1.00'],
      ['comma separator', '1,00'],
      ['hex', '0x10'],
      ['too many integer digits', '1000000000000000000.00'],
    ])('rejects %s', (_label, amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    test('rejects non-string amounts (numbers are never accepted for money)', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    test.each(['brl', 'BR', 'BRLL', 'XYZ', ''])('rejects currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  });

  describe('arithmetic', () => {
    test('is exact where binary floating point is not', () => {
      expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
      expect(brl('1.00').subtract(brl('0.90')).toString()).toBe('0.10');
    });

    test('keeps a fixed scale of 2', () => {
      expect(brl('10.00').add(brl('0.50')).toString()).toBe('10.50');
      expect(Money.zero('BRL').toString()).toBe('0.00');
    });

    test('handles large values without precision loss', () => {
      const big = brl('999999999999999999.98');
      expect(big.add(brl('0.01')).toString()).toBe('999999999999999999.99');
    });

    test('negate and sign queries', () => {
      const negative = brl('5.00').negate();
      expect(negative.toString()).toBe('-5.00');
      expect(negative.isNegative()).toBe(true);
      expect(brl('5.00').isPositive()).toBe(true);
      expect(brl('0.00').negate().toString()).toBe('0.00');
      expect(brl('0.00').isZero()).toBe(true);
    });

    test('subtract can go negative internally', () => {
      expect(brl('1.00').subtract(brl('2.50')).toString()).toBe('-1.50');
    });

    test('is immutable: operations return new instances', () => {
      const a = brl('1.00');
      const b = a.add(brl('2.00'));
      expect(a.toString()).toBe('1.00');
      expect(b).not.toBe(a);
    });
  });

  describe('currency', () => {
    test('operations across currencies throw a domain error', () => {
      const usd = Money.from({ amount: '1.00', currency: 'USD' });
      expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    });

    test('equals compares currency as well as amount', () => {
      expect(brl('1.00').equals(brl('1.00'))).toBe(true);
      expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
    });
  });

  describe('serialization', () => {
    test('toJSON uses decimal strings', () => {
      expect(JSON.stringify(brl('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
    });

    test('rehydrate accepts storage formats and normalises scale', () => {
      expect(Money.rehydrate('25', 'BRL').toString()).toBe('25.00');
      expect(Money.rehydrate('25.5', 'BRL').toString()).toBe('25.50');
      expect(Money.rehydrate('-3.10', 'BRL').toString()).toBe('-3.10');
      expect(() => Money.rehydrate('1.001', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.rehydrate('abc', 'BRL')).toThrow(InvalidMoneyError);
    });
  });
});
