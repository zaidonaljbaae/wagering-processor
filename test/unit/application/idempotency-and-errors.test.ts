import { describe, expect, test } from 'bun:test';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  RequestValidationError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { ledgerCursor } from '../../../src/application/queries';
import { canonicalJson, parseOrThrow, wagerPayloadHash, wagerRequestSchema, WagerRequest } from '../../../src/application/wager-request';
import { InvalidMoneyError } from '../../../src/domain/errors';
import { WagerTransactionKind } from '../../../src/domain/wager-transaction';
import { backoffDelayMs } from '../../../src/domain/messaging/outbox-message';
import { mapError } from '../../../src/interfaces/http/error-mapping';
import { classifyFailure } from '../../../src/interfaces/sqs/wager-transactions.consumer';

const request: WagerRequest = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
};

describe('payload hash', () => {
  test('canonical JSON sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  test('does not depend on key order', () => {
    const reordered = Object.fromEntries(Object.entries(request).reverse()) as WagerRequest;
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(request));
  });

  test('changes with any business field', () => {
    const base = wagerPayloadHash(request);
    expect(wagerPayloadHash({ ...request, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(base);
    expect(wagerPayloadHash({ ...request, roundId: 'round-988' })).not.toBe(base);
    expect(wagerPayloadHash({ ...request, referenceExternalTransactionId: 'x' })).not.toBe(base);
  });

  test('is a sha256 hex digest', () => {
    expect(wagerPayloadHash(request)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('request schema', () => {
  test('accepts the documented contract', () => {
    expect(parseOrThrow(wagerRequestSchema, request)).toEqual(request);
  });

  test('rejects unknown fields and reports paths without echoing values', () => {
    try {
      parseOrThrow(wagerRequestSchema, { ...request, walletId: 'DROP TABLE wallets', extra: 1 });
      throw new Error('should have failed');
    } catch (err) {
      expect(err).toBeInstanceOf(RequestValidationError);
      const text = JSON.stringify((err as RequestValidationError).issues);
      expect(text).toContain('walletId');
      expect(text).not.toContain('DROP TABLE');
    }
  });
});

describe('HTTP error mapping', () => {
  test.each([
    [new RequestValidationError([]), 400, 'VALIDATION_FAILED'],
    [new InvalidMoneyError('bad'), 400, 'VALIDATION_FAILED'],
    [new IdempotencyConflictError('t'), 409, 'IDEMPOTENCY_KEY_CONFLICT'],
    [new ExternalTransactionConflictError('t'), 409, 'EXTERNAL_TRANSACTION_CONFLICT'],
    [new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND'],
    [Object.assign(new Error('lock'), { code: '55P03' }), 503, 'TEMPORARILY_UNAVAILABLE'],
    [Object.assign(new Error('conn'), { code: '08006' }), 503, 'TEMPORARILY_UNAVAILABLE'],
    [new Error('boom'), 500, 'INTERNAL_ERROR'],
  ])('%p -> %i', (err, status, code) => {
    const mapped = mapError(err);
    expect(mapped.status).toBe(status);
    expect(mapped.body.code).toBe(code);
  });

  test('transient errors advertise Retry-After; internal errors leak nothing', () => {
    expect(mapError(Object.assign(new Error('x'), { code: '40P01' })).retryAfterSeconds).toBe(1);
    expect(mapError(new Error('password=hunter2')).body.message).toBe('Internal error');
  });
});

describe('SQS failure classification', () => {
  test('permanent: validation, conflicts, unknown wallet', () => {
    expect(classifyFailure(new RequestValidationError([]))).toBe('permanent');
    expect(classifyFailure(new IdempotencyConflictError('t'))).toBe('permanent');
    expect(classifyFailure(new WalletNotFoundError('w'))).toBe('permanent');
  });

  test('transient: database hiccups and anything unknown', () => {
    expect(classifyFailure(Object.assign(new Error('x'), { code: '40001' }))).toBe('transient');
    expect(classifyFailure(new Error('ECONNRESET'))).toBe('transient');
    expect(classifyFailure(new Error('???'))).toBe('transient');
  });
});

describe('backoff', () => {
  test('grows exponentially, is capped and jittered', () => {
    const policy = { baseMs: 100, maxMs: 1_000 };
    expect(backoffDelayMs(0, policy, () => 0)).toBe(50);
    expect(backoffDelayMs(0, policy, () => 1)).toBe(100);
    expect(backoffDelayMs(3, policy, () => 1)).toBe(800);
    expect(backoffDelayMs(10, policy, () => 1)).toBe(1_000);
  });
});

describe('ledger cursor', () => {
  test('round-trips and rejects tampering', () => {
    expect(ledgerCursor.decode(ledgerCursor.encode('42'))).toBe('42');
    expect(() => ledgerCursor.decode(Buffer.from('v1:abc').toString('base64url'))).toThrow(RequestValidationError);
    expect(() => ledgerCursor.decode('%%%')).toThrow(RequestValidationError);
  });
});
