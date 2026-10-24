import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ResolvePendingReferences } from '../../application/resolve-pending-references';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { OutboxPublisher } from '../../infrastructure/messaging/outbox-publisher';
import { AppLogger, errorFields } from '../../observability/logger';

/**
 * Minimal polling loop: runs `tick` until stopped, sleeping `intervalMs`
 * whenever a tick had nothing to do. Stopping waits for the current tick.
 */
abstract class PollingWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  protected constructor(
    protected readonly logger: AppLogger,
    private readonly name: string,
    private readonly enabled: boolean,
    private readonly intervalMs: number,
  ) {}

  /** Returns true when there may be more work right away. */
  protected abstract tick(): Promise<boolean>;

  onApplicationBootstrap(): void {
    if (this.enabled) this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info('worker started', { worker: this.name });
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.logger.info('worker stopped', { worker: this.name });
  }

  private async run(): Promise<void> {
    while (this.running) {
      let busy = false;
      try {
        busy = await this.tick();
      } catch (err) {
        this.logger.error('worker tick failed', { worker: this.name, ...errorFields(err) });
      }
      if (!busy && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}

@Injectable()
export class OutboxWorker extends PollingWorker {
  constructor(
    private readonly publisher: OutboxPublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    logger: AppLogger,
  ) {
    super(logger, 'outbox-publisher', config.outbox.enabled, config.outbox.pollIntervalMs);
  }

  protected async tick(): Promise<boolean> {
    const published = await this.publisher.publishBatch();
    return published >= this.config.outbox.batchSize;
  }
}

@Injectable()
export class PendingReferenceWorker extends PollingWorker {
  constructor(
    private readonly resolver: ResolvePendingReferences,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    logger: AppLogger,
  ) {
    super(logger, 'pending-reference-resolver', config.pendingReference.enabled, config.pendingReference.pollIntervalMs);
  }

  protected async tick(): Promise<boolean> {
    await this.resolver.runOnce(this.config.pendingReference.batchSize);
    return false;
  }
}
