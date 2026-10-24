import { Inject, Injectable } from '@nestjs/common';
import { backoffDelayMs } from '../domain/messaging/outbox-message';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

/**
 * How long a transaction waits for its reference.
 *
 * Defaults: exponential backoff from 2s, capped at 60s, 10 attempts, roughly
 * 6-7 minutes in total. Providers normally deliver the original operation
 * within seconds; waiting much longer only delays the answer to the player and
 * keeps money in limbo. Tunable through PENDING_REFERENCE_* settings.
 */
@Injectable()
export class PendingReferencePolicy {
  readonly maxAttempts: number;
  private readonly policy: { baseMs: number; maxMs: number };

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.maxAttempts = config.pendingReference.maxAttempts;
    this.policy = { baseMs: config.pendingReference.retryBaseMs, maxMs: config.pendingReference.retryMaxMs };
  }

  nextAttemptAt(now: Date, attempt: number): Date {
    return new Date(now.getTime() + backoffDelayMs(attempt, this.policy));
  }

  /** `attempts` already performed (including the one that just failed). */
  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }
}
