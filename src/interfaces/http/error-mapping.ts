import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import {
  ConcurrencyConflictError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  NotFoundError,
  RequestValidationError,
  UniqueViolationError,
  ValidationIssue,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { DomainValidationError, DomainError } from '../../domain/errors';
import { transientDatabaseError } from '../../infrastructure/persistence/db-errors';
import { AppLogger, errorFields } from '../../observability/logger';
import { AuthError } from './auth';

export interface ErrorBody {
  code: string;
  message: string;
  issues?: ValidationIssue[];
  transactionId?: string;
}

interface MappedError {
  status: number;
  body: ErrorBody;
  retryAfterSeconds?: number;
}

/**
 * One table for every endpoint, so a provider can decide from the status
 * alone whether to resend:
 *
 *   400 VALIDATION_FAILED          fix the payload, do not retry as is
 *   401/403                        credentials / permissions
 *   404 *_NOT_FOUND                unknown resource
 *   409 *_CONFLICT / *_EXISTS      idempotency or uniqueness conflict, never retry
 *   422 (REJECTED result)          business rejection, final for this key
 *   202 (PENDING_REFERENCE result) accepted, poll for the outcome
 *   503 TEMPORARILY_UNAVAILABLE    transient, safe to retry with the same key
 *   500 INTERNAL_ERROR             unexpected, safe to retry with the same key
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof RequestValidationError) {
    return { status: 400, body: { code: err.code, message: err.message, issues: err.issues } };
  }
  if (err instanceof DomainValidationError) {
    return { status: 400, body: { code: 'VALIDATION_FAILED', message: err.message } };
  }
  if (err instanceof IdempotencyConflictError || err instanceof ExternalTransactionConflictError) {
    return { status: 409, body: { code: err.code, message: err.message, transactionId: err.transactionId } };
  }
  if (err instanceof WalletAlreadyExistsError) {
    return { status: 409, body: { code: err.code, message: err.message } };
  }
  if (err instanceof WalletNotFoundError || err instanceof NotFoundError) {
    return { status: 404, body: { code: err.code === 'NOT_FOUND' ? 'NOT_FOUND' : err.code, message: err.message } };
  }
  if (err instanceof AuthError) {
    return { status: err.status, body: { code: err.code, message: err.message } };
  }
  if (
    err instanceof ConcurrencyConflictError ||
    err instanceof UniqueViolationError ||
    transientDatabaseError(err) ||
    isAwsTransient(err)
  ) {
    return {
      status: 503,
      body: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Temporary failure, retry with the same Idempotency-Key' },
      retryAfterSeconds: 1,
    };
  }
  if (err instanceof DomainError) {
    // A domain rule surfaced as an exception (should have been a REJECTED result).
    return { status: 422, body: { code: err.code, message: err.message } };
  }
  if (err instanceof HttpException) {
    const status = err.getStatus();
    // Framework messages (e.g. JSON parser details) are not echoed back.
    const message = status >= 500 ? 'Internal error' : status === 404 ? 'Not found' : 'Malformed request';
    return { status, body: { code: httpCode(status), message } };
  }
  const clientStatus = bodyParserStatus(err);
  if (clientStatus) {
    return { status: clientStatus, body: { code: httpCode(clientStatus), message: 'Malformed request' } };
  }
  return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Internal error' } };
}

/** body-parser errors (too large, bad encoding, ...) carry a 4xx status and `expose: true`. */
function bodyParserStatus(err: unknown): number | undefined {
  const candidate = err as { status?: unknown; expose?: unknown } | null;
  const status = candidate?.status;
  return candidate?.expose === true && typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

function httpCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 404:
      return 'NOT_FOUND';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR';
  }
}

function isAwsTransient(err: unknown): boolean {
  const meta = (err as { $metadata?: { httpStatusCode?: number }; $retryable?: unknown } | null) ?? null;
  return Boolean(meta && (meta.$retryable || (meta.$metadata?.httpStatusCode ?? 0) >= 500));
}

@Catch()
@Injectable()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const mapped = mapError(exception);
    if (mapped.status >= 500) {
      this.logger.error('request failed', { status: mapped.status, code: mapped.body.code, ...errorFields(exception) });
    }
    if (mapped.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    res.status(mapped.status).json(mapped.body);
  }
}
