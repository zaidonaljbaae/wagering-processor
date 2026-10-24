/**
 * Application-level errors. Each maps to one HTTP status and one SQS handling
 * strategy; see interfaces/http/error-mapping.ts and the SQS consumer.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class RequestValidationError extends ApplicationError {
  readonly code = 'VALIDATION_FAILED';

  constructor(readonly issues: ValidationIssue[]) {
    super('Request validation failed');
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(readonly transactionId: string) {
    super('Idempotency key was already used with a different payload');
  }
}

/** Same (providerId, externalTransactionId) submitted under another idempotency key. */
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';

  constructor(readonly transactionId: string) {
    super('externalTransactionId was already used with a different idempotency key');
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor() {
    super('A wallet already exists for this player and currency');
  }
}

export class NotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';
}

/**
 * Raised by repositories when a database unique constraint rejects a write.
 * Use cases translate it (replay, conflict, already exists).
 */
export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';

  constructor(readonly constraint: string) {
    super(`Unique constraint ${constraint} violated`);
  }
}

/** Defensive: a guarded write touched no row although the wallet was locked. */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = 'CONCURRENCY_CONFLICT';
}
