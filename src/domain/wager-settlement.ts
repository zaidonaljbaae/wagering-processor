import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionStatus } from './wager-transaction';
import { Wallet } from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; entry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

export interface SettlementInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  /** Result of resolving (providerId, referenceExternalTransactionId); undefined when not found. */
  reference: WagerTransaction | undefined;
  /** Whether a processed REFUND/ROLLBACK already points at `reference`. */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  at: Date;
}

/**
 * Applies the business rules of section 7 to one transaction against one
 * wallet. The caller must hold the wallet lock; this function is pure domain
 * logic and never touches persistence.
 *
 * PROCESSED and REJECTED outcomes are applied to the transaction (and wallet)
 * here. PENDING_REFERENCE is only reported: scheduling the retry is a policy
 * decision that belongs to the application layer.
 */
export function settle(input: SettlementInput): SettlementOutcome {
  const { wallet, transaction: tx, at } = input;

  const reject = (failureCode: FailureCode): SettlementOutcome => {
    tx.reject(failureCode, at, wallet.balance);
    return { status: WagerTransactionStatus.Rejected, failureCode };
  };

  if (tx.playerId !== wallet.playerId) {
    return reject(FailureCode.WalletPlayerMismatch);
  }
  if (tx.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  const reference = input.reference;
  if (tx.hasReference()) {
    if (!reference || isWaiting(reference)) {
      return { status: WagerTransactionStatus.PendingReference };
    }
    const problem = checkReference(tx, reference, input.referenceAlreadyReversed);
    if (problem) {
      return reject(problem);
    }
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, at, wallet.balance);
    return { status: WagerTransactionStatus.Processed, entry: undefined };
  }

  const direction = tx.ledgerDirectionFor(reference);
  const movement = { transactionId: tx.id, entryId: input.ledgerEntryId, at };

  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    // A reversal that cannot be paid back is operationally different from a
    // plain bet without funds: it usually needs manual follow-up.
    return reject(tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
  }

  const entry =
    direction === LedgerDirection.Debit ? wallet.debit(tx.money, movement) : wallet.credit(tx.money, movement);
  tx.markProcessed(reference?.id, at, wallet.balance);
  return { status: WagerTransactionStatus.Processed, entry };
}

function isWaiting(tx: WagerTransaction): boolean {
  return tx.status === WagerTransactionStatus.Pending || tx.status === WagerTransactionStatus.PendingReference;
}

function checkReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | undefined {
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  const sameContext =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId;
  if (!sameContext) {
    return FailureCode.ReferenceMismatch;
  }
  if (!tx.canReference(reference.kind)) {
    return FailureCode.InvalidReferenceKind;
  }
  if (tx.isReversal()) {
    if (!reference.money.equals(tx.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }
    if (alreadyReversed) {
      return FailureCode.ReferenceAlreadyReversed;
    }
  }
  return undefined;
}
