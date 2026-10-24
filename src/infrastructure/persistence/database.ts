import { Inject, Injectable } from '@nestjs/common';
import { IsolationLevel, TransactionContext } from '@mikro-orm/core';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { UnitOfWork, UnitOfWorkOptions } from '../../application/ports';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { Metrics } from '../../observability/metrics';
import { transientDatabaseError } from './db-errors';

/**
 * Hands out the right EntityManager: the transactional fork when called inside
 * a unit of work, a fresh short-lived fork otherwise (no shared identity map).
 */
@Injectable()
export class Database {
  constructor(readonly orm: MikroORM) {}

  em(): EntityManager {
    return (TransactionContext.getEntityManager(this.orm.em.name) as EntityManager | undefined) ?? this.orm.em.fork();
  }

  inTransaction(): boolean {
    return TransactionContext.getEntityManager(this.orm.em.name) !== undefined;
  }

  async ping(): Promise<void> {
    await this.orm.em.fork().execute('select 1');
  }
}

@Injectable()
export class MikroUnitOfWork extends UnitOfWork {
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly db: Database,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly metrics: Metrics,
  ) {
    super();
    this.lockTimeoutMs = Math.trunc(config.database.lockTimeoutMs);
  }

  async run<T>(work: () => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    if (this.db.inTransaction()) {
      throw new Error('Nested units of work are not supported');
    }
    try {
      return await this.transactional(work, options);
    } catch (err) {
      const kind = transientDatabaseError(err);
      if (kind === 'lock_timeout' || kind === 'deadlock' || kind === 'serialization') {
        this.metrics.lockConflicts.inc({ type: kind });
      }
      throw err;
    }
  }

  private transactional<T>(work: () => Promise<T>, options: UnitOfWorkOptions): Promise<T> {
    return this.db.orm.em.fork().transactional(
      async (em) => {
        // Bounded waits: a stuck lock turns into a retryable error instead of a hung request.
        await em.execute(`set local lock_timeout = '${this.lockTimeoutMs}ms'`);
        return work();
      },
      {
        ...(options.repeatableRead && { isolationLevel: IsolationLevel.REPEATABLE_READ }),
        ...(options.readOnly && { readOnly: true }),
      },
    );
  }
}
