import { Inject, Injectable } from '@nestjs/common';
import { Clock, FaultInjector, FaultPoint, IdGenerator } from '../application/ports';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { AppLogger } from '../observability/logger';

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

@Injectable()
export class UuidV7Generator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

/**
 * Kills the process at a named point when FAULT_POINT matches. Only active
 * with NODE_ENV=test (enforced in config); used by crash-recovery tests.
 */
@Injectable()
export class ProcessFaultInjector extends FaultInjector {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  hit(point: FaultPoint): void {
    if (this.config.faultPoint !== point) return;
    this.logger.warn('fault injected, killing process', { point });
    process.kill(process.pid, 'SIGKILL');
  }
}
