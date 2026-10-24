/**
 * Stable, machine-readable reasons for a REJECTED or FAILED transaction.
 * Values are part of the public contract: never rename, only add.
 *
 * None of these are retryable with the same payload: a rejection is a final
 * answer for that idempotency key. Transient problems never produce a
 * failure code; they surface as HTTP 503 / SQS redelivery instead.
 */
export enum FailureCode {
  /** BET larger than the available balance. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** REFUND/ROLLBACK whose debit would make the balance negative. Needs manual follow-up. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId in the request does not own the wallet. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Referenced transaction never arrived within the retry window. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referenced transaction exists but was REJECTED or FAILED. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Reference belongs to another player, wallet, currency or round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** e.g. REFUND pointing to a WIN, or ROLLBACK pointing to a LOSS. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** Reversal amount differs from the referenced amount (partial reversal is out of scope). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Reference was already reversed by a processed REFUND or ROLLBACK. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Permanent infrastructure failure, kept for audit. */
  ProcessingFailed = 'PROCESSING_FAILED',
}

export function isFailureCode(value: string): value is FailureCode {
  return (Object.values(FailureCode) as string[]).includes(value);
}
