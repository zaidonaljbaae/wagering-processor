import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export type Source = 'http' | 'sqs' | 'pending_reference' | 'internal';

/**
 * Prometheus metrics. Each instance owns its registry, so several app
 * instances can live in one process (integration tests) without clashing.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transactions by final status of the attempt',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicate deliveries detected (idempotency replay or inbox hit)',
    labelNames: ['source', 'reason'] as const,
    registers: [this.registry],
  });

  readonly idempotencyConflicts = new Counter({
    name: 'wager_idempotency_conflicts_total',
    help: 'Same idempotency key or external id reused with a different payload',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Retries scheduled, by component',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });

  readonly deadLettered = new Counter({
    name: 'sqs_dead_lettered_total',
    help: 'Messages moved to the DLQ',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks or serialization failures on wallet rows',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  readonly lockWait = new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Time spent waiting for the wallet row lock',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'End-to-end processing latency of a transaction',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event',
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Events published from the outbox',
    registers: [this.registry],
  });

  readonly outboxFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Failed publish attempts',
    registers: [this.registry],
  });

  readonly reconciliationMismatches = new Counter({
    name: 'reconciliation_mismatches_total',
    help: 'Reconciliations where stored balance != ledger balance',
    registers: [this.registry],
  });

  readonly pendingReferenceExpired = new Counter({
    name: 'pending_reference_expired_total',
    help: 'PENDING_REFERENCE transactions rejected after exhausting retries',
    registers: [this.registry],
  });

  constructor(options: { defaultMetrics?: boolean } = {}) {
    if (options.defaultMetrics ?? true) {
      collectDefaultMetrics({ register: this.registry });
    }
  }
}
