/**
 * Base class for every error raised by the domain. Domain errors describe a
 * violated rule; they never carry infrastructure details.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input that can never be valid (bad amount format, missing reference, ...). */
export class DomainValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
}

export class InvalidMoneyError extends DomainValidationError {}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

/**
 * Raised when code tries to move a transaction out of a terminal state.
 * This is a programming error, never a business path.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';
}
