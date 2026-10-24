import { Message } from '@aws-sdk/client-sqs';
import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { ApplicationError, RequestValidationError } from '../../application/errors';
import { FaultInjector } from '../../application/ports';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { idempotencyKeySchema, parseOrThrow, sha256Hex, wagerRequestSchema } from '../../application/wager-request';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { DomainError } from '../../domain/errors';
import { transientDatabaseError } from '../../infrastructure/persistence/db-errors';
import { SqsGateway } from '../../infrastructure/messaging/sqs-gateway';
import { AppLogger, errorFields, logContext } from '../../observability/logger';
import { Metrics } from '../../observability/metrics';

const safeId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

const envelopeSchema = z.object({
  messageId: safeId,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime({ offset: true }),
  correlationId: safeId.optional(),
  data: wagerRequestSchema.extend({ idempotencyKey: idempotencyKeySchema }).strict(),
});

type Envelope = z.infer<typeof envelopeSchema>;

/**
 * How a failed message is handled:
 * - permanent: can never succeed (bad payload, conflict, unknown wallet) -> DLQ with a reason
 * - transient: may succeed later (DB/SQS hiccup, lock timeout) -> retry with backoff, DLQ after N attempts
 * Business rejections are not failures: they are recorded as REJECTED and acked.
 */
type FailureClass = 'permanent' | 'transient';

export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof ApplicationError || err instanceof DomainError) {
    // Conflicts and validation problems will fail identically on every redelivery.
    return err.code === 'CONCURRENCY_CONFLICT' || err.code === 'UNIQUE_VIOLATION' ? 'transient' : 'permanent';
  }
  if (transientDatabaseError(err)) return 'transient';
  // Unknown errors are retried: when in doubt, prefer redelivery (idempotent) over losing a message.
  return 'transient';
}

@Injectable()
export class WagerTransactionsConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  static readonly consumerName = 'wager-transactions-consumer';

  private running = false;
  private loops: Promise<void>[] = [];

  constructor(
    private readonly sqs: SqsGateway,
    private readonly processWager: ProcessWagerTransaction,
    private readonly faults: FaultInjector,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.consumer.enabled) this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = Array.from({ length: this.config.consumer.concurrency }, () => this.loop());
    this.logger.info('sqs consumer started', { queue: this.config.sqs.wagerQueue, concurrency: this.config.consumer.concurrency });
  }

  /**
   * SIGTERM: stop polling, let in-flight messages finish within the grace
   * period, and hand back messages that were received but not started.
   *
   * The pending long poll is not aborted: SQS would still complete the receive
   * server-side and hide the message until its visibility timeout. Instead the
   * poll is allowed to return (<= CONSUMER_WAIT_SECONDS) and anything it
   * brings back is released immediately.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.config.consumer.shutdownGraceMs);
    });
    await Promise.race([Promise.allSettled(this.loops), grace]);
    clearTimeout(timer);
    this.logger.info('sqs consumer stopped');
  }

  private async loop(): Promise<void> {
    const { wagerQueue } = this.config.sqs;
    while (this.running) {
      let messages: Message[];
      try {
        messages = await this.sqs.receive(wagerQueue, {
          maxMessages: 10,
          waitSeconds: this.config.consumer.waitSeconds,
          visibilityTimeoutSeconds: this.config.consumer.visibilityTimeoutSeconds,
        });
      } catch (err) {
        if (!this.running) break;
        this.logger.warn('sqs receive failed', errorFields(err));
        await sleep(1_000);
        continue;
      }

      // Sequential within a batch: FIFO batches may hold several messages of one group, in order.
      for (let i = 0; i < messages.length; i++) {
        if (!this.running) {
          await this.release(messages.slice(i));
          break;
        }
        await this.handle(messages[i]!);
      }
    }
  }

  async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let envelope: Envelope;
    try {
      envelope = parseOrThrow(envelopeSchema, JSON.parse(message.Body ?? ''));
    } catch (err) {
      const reason = err instanceof RequestValidationError ? 'INVALID_MESSAGE' : 'MALFORMED_JSON';
      await this.deadLetter(message, reason, err);
      return;
    }

    const { idempotencyKey, ...request } = envelope.data;
    await logContext.run(
      {
        correlationId: envelope.correlationId ?? envelope.messageId,
        messageId: envelope.messageId,
        providerId: request.providerId,
        walletId: request.walletId,
      },
      async () => {
        try {
          const result = await this.processWager.execute({
            request,
            idempotencyKey,
            correlation: { correlationId: envelope.correlationId ?? envelope.messageId, causationId: envelope.messageId },
            source: 'sqs',
            inbox: {
              consumerName: WagerTransactionsConsumer.consumerName,
              messageId: envelope.messageId,
              payloadHash: sha256Hex(message.Body ?? ''),
            },
          });
          // Committed. A crash right here means redelivery, which the inbox absorbs.
          this.faults.hit('after_commit_before_ack');
          await this.sqs.delete(this.config.sqs.wagerQueue, message.ReceiptHandle!);
          this.logger.info('message processed', {
            transactionId: result.transactionId,
            status: result.status,
            failureCode: result.failureCode,
            replay: result.idempotentReplay,
          });
        } catch (err) {
          await this.handleFailure(message, receiveCount, err);
        }
      },
    );
  }

  private async handleFailure(message: Message, receiveCount: number, err: unknown): Promise<void> {
    if (classifyFailure(err) === 'permanent') {
      const code = err instanceof ApplicationError || err instanceof DomainError ? err.code : 'PERMANENT_FAILURE';
      await this.deadLetter(message, code, err);
      return;
    }
    if (receiveCount >= this.config.consumer.maxAttempts) {
      await this.deadLetter(message, 'RETRIES_EXHAUSTED', err);
      return;
    }
    const { retryBaseSeconds, retryMaxSeconds } = this.config.consumer;
    const delay = Math.min(retryMaxSeconds, retryBaseSeconds * 2 ** (receiveCount - 1));
    this.metrics.retries.inc({ component: 'sqs' });
    this.logger.warn('transient failure, message will be retried', { receiveCount, delaySeconds: delay, ...errorFields(err) });
    try {
      await this.sqs.changeVisibility(this.config.sqs.wagerQueue, message.ReceiptHandle!, delay);
    } catch (visibilityErr) {
      // The visibility timeout will expire on its own; the message is not lost.
      this.logger.warn('could not change message visibility', errorFields(visibilityErr));
    }
  }

  /** Copies the message to the DLQ with the reason, then removes it from the main queue. */
  private async deadLetter(message: Message, reason: string, err: unknown): Promise<void> {
    try {
      await this.sqs.send(this.config.sqs.wagerDlq, {
        body: message.Body ?? '',
        groupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        deduplicationId: sha256Hex(`${message.MessageId}:${reason}`),
        attributes: { failureReason: reason, sourceMessageId: message.MessageId ?? 'unknown' },
      });
      await this.sqs.delete(this.config.sqs.wagerQueue, message.ReceiptHandle!);
      this.metrics.deadLettered.inc({ reason });
      this.logger.error('message moved to DLQ', { reason, sqsMessageId: message.MessageId, ...errorFields(err) });
    } catch (dlqErr) {
      // Leave it in the queue: SQS redrive will move it after maxReceiveCount.
      this.logger.error('dead-lettering failed', { reason, ...errorFields(dlqErr) });
    }
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.allSettled(
      messages.map((m) => this.sqs.changeVisibility(this.config.sqs.wagerQueue, m.ReceiptHandle!, 0)),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
