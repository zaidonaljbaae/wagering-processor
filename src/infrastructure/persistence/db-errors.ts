/**
 * Postgres error classification. MikroORM wraps driver errors but keeps the
 * SQLSTATE in `code` (and the original error in `cause`/`previous`).
 */
interface PgLikeError {
  code?: string;
  constraint?: string;
}

function pgFields(err: unknown): PgLikeError {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const candidate = current as PgLikeError & { cause?: unknown; previous?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return { code: candidate.code, constraint: candidate.constraint ?? constraintOf(current) };
    }
    current = candidate.previous ?? candidate.cause;
  }
  return {};
}

function constraintOf(err: unknown): string | undefined {
  const nested = (err as { previous?: PgLikeError; cause?: PgLikeError }).previous ?? (err as { cause?: PgLikeError }).cause;
  return nested?.constraint;
}

export function uniqueViolationConstraint(err: unknown): string | undefined {
  const { code, constraint } = pgFields(err);
  return code === '23505' ? (constraint ?? 'unknown') : undefined;
}

export type TransientKind = 'lock_timeout' | 'deadlock' | 'serialization' | 'connection' | 'timeout';

/**
 * Errors worth retrying: the same request may succeed a moment later.
 * Constraint violations and data errors are never transient.
 */
export function transientDatabaseError(err: unknown): TransientKind | undefined {
  const { code } = pgFields(err);
  if (code) {
    if (code === '55P03') return 'lock_timeout';
    if (code === '40P01') return 'deadlock';
    if (code === '40001') return 'serialization';
    if (code === '57014') return 'timeout'; // statement_timeout
    if (code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03' || code === '53300') {
      return 'connection';
    }
    return undefined;
  }
  const message = err instanceof Error ? err.message : '';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|Knex: Timeout acquiring a connection/i.test(message)) {
    return 'connection';
  }
  return undefined;
}
