import { Inject, Injectable } from '@nestjs/common';
import { Clock, FaultInjector } from '../../application/ports';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { BackoffPolicy, OutboxMessage } from '../../domain/messaging/outbox-message';
import { AppLogger, errorFields } from '../../observability/logger';
import { Metrics } from '../../observability/metrics';
import { Database } from '../persistence/database';
import { outboxToDomain } from '../persistence/mappers';
import { OutboxRecord } from '../persistence/schemas';
import { SqsGateway } from './sqs-gateway';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string;
  published_at: Date | string | null;
}

/** Where events go. Abstracted so tests can count publishes. */
export abstract class EventPublisher {
  abstract publish(message: OutboxMessage): Promise<void>;
}

@Injectable()
export class SqsEventPublisher extends EventPublisher {
  constructor(
    private readonly sqs: SqsGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(this.config.sqs.eventsQueue, {
      body: JSON.stringify(message.payload),
      // Per-aggregate ordering; eventId doubles as the broker-side dedup id.
      groupId: message.aggregateId,
      deduplicationId: message.id,
      attributes: { eventType: message.eventType, eventId: message.id },
    });
  }
}

/**
 * Publishes committed outbox rows. Safe with many concurrent publishers:
 *
 * 1. claim: one UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
 *    sets a lease (locked_until). Concurrent publishers get disjoint batches.
 * 2. publish each event, then mark it published.
 * 3. if the process dies after the claim, the lease expires and another
 *    instance picks the rows up. The worst case is a duplicate publish, which
 *    consumers handle by eventId (at-least-once).
 */
@Injectable()
export class OutboxPublisher {
  private readonly backoff: BackoffPolicy;

  constructor(
    private readonly db: Database,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly faults: FaultInjector,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.backoff = { baseMs: config.outbox.retryBaseMs, maxMs: config.outbox.retryMaxMs };
  }

  /** Publishes one batch; returns the number of events published. */
  async publishBatch(): Promise<number> {
    const claimed = await this.claim();
    this.faults.hit('outbox_after_claim');

    let published = 0;
    for (const message of claimed) {
      try {
        await this.publisher.publish(message);
        message.markPublished(this.clock.now());
        await this.markPublished(message);
        this.metrics.outboxPublished.inc();
        published++;
      } catch (err) {
        message.scheduleRetry(this.clock.now(), this.backoff);
        await this.markFailed(message, err).catch((markErr: unknown) =>
          this.logger.error('outbox retry bookkeeping failed', { eventId: message.id, ...errorFields(markErr) }),
        );
        this.metrics.outboxFailures.inc();
        this.metrics.retries.inc({ component: 'outbox' });
        this.logger.warn('outbox publish failed', { eventId: message.id, attempts: message.attempts, ...errorFields(err) });
      }
    }
    await this.refreshLag();
    return published;
  }

  private async claim(): Promise<OutboxMessage[]> {
    const rows = await this.db.em().execute<OutboxRow[]>(
      `update outbox_messages
          set locked_until = now() + (? * interval '1 millisecond')
        where id in (
          select id from outbox_messages
           where published_at is null
             and next_attempt_at <= now()
             and (locked_until is null or locked_until < now())
           order by occurred_at, id
           limit ?
           for update skip locked)
      returning id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at`,
      [this.config.outbox.leaseMs, this.config.outbox.batchSize],
    );
    return rows
      .map((row) => outboxToDomain(rowToRecord(row)))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  }

  private async markPublished(message: OutboxMessage): Promise<void> {
    await this.db
      .em()
      .execute(
        `update outbox_messages set published_at = ?, locked_until = null, last_error = null
          where id = ? and published_at is null`,
        [message.publishedAt, message.id],
      );
  }

  private async markFailed(message: OutboxMessage, err: unknown): Promise<void> {
    const reason = (err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error').slice(0, 500);
    await this.db
      .em()
      .execute(
        `update outbox_messages set attempts = ?, next_attempt_at = ?, locked_until = null, last_error = ?
          where id = ? and published_at is null`,
        [message.attempts, message.nextAttemptAt, reason, message.id],
      );
  }

  private async refreshLag(): Promise<void> {
    const [row] = await this.db.em().execute<Array<{ lag: string | null }>>(
      `select extract(epoch from now() - min(occurred_at))::text as lag
         from outbox_messages where published_at is null`,
    );
    this.metrics.outboxLag.set(row?.lag ? Math.max(0, Number(row.lag)) : 0);
  }
}

function rowToRecord(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as Record<string, unknown>) : row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    lockedUntil: null,
    publishedAt: row.published_at ? new Date(row.published_at) : null,
    lastError: null,
  };
}
