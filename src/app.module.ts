import { DynamicModule, Inject, Injectable, Module, OnApplicationBootstrap, OnApplicationShutdown, Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { PendingReferencePolicy } from './application/pending-reference-policy';
import {
  Clock,
  FaultInjector,
  IdGenerator,
  InboxRepository,
  LedgerRepository,
  OutboxWriter,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from './application/ports';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { WageringQueries } from './application/queries';
import { ResolvePendingReferences } from './application/resolve-pending-references';
import { OpenWallet, ReconcileWallet } from './application/wallet-use-cases';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { EventPublisher, OutboxPublisher, SqsEventPublisher } from './infrastructure/messaging/outbox-publisher';
import { SqsGateway } from './infrastructure/messaging/sqs-gateway';
import { Database, MikroUnitOfWork } from './infrastructure/persistence/database';
import { buildOrmConfig } from './infrastructure/persistence/orm.config';
import {
  MikroInboxRepository,
  MikroLedgerRepository,
  MikroOutboxWriter,
  MikroWagerTransactionRepository,
  MikroWalletRepository,
} from './infrastructure/persistence/repositories';
import { ProcessFaultInjector, SystemClock, UuidV7Generator } from './infrastructure/system';
import type { JWTVerifyGetKey } from 'jose';
import { AuthGuard, JWT_KEY_RESOLVER } from './interfaces/http/auth';
import { HealthController, WageringController, WalletsController } from './interfaces/http/controllers';
import { HttpErrorFilter } from './interfaces/http/error-mapping';
import { WagerTransactionsConsumer } from './interfaces/sqs/wager-transactions.consumer';
import { OutboxWorker, PendingReferenceWorker } from './interfaces/workers/workers';
import { AppLogger } from './observability/logger';
import { Metrics } from './observability/metrics';

/** Serves /metrics on a separate (internal) port. METRICS_PORT=0 disables it. */
@Injectable()
class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private server?: ReturnType<typeof Bun.serve>;

  constructor(
    private readonly metrics: Metrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.http.metricsPort === 0) return;
    const registry = this.metrics.registry;
    this.server = Bun.serve({
      port: this.config.http.metricsPort,
      async fetch(req) {
        if (new URL(req.url).pathname !== '/metrics') return new Response('not found', { status: 404 });
        return new Response(await registry.metrics(), { headers: { 'content-type': registry.contentType } });
      },
    });
  }

  onApplicationShutdown(): void {
    this.server?.stop(true);
  }
}

/** Closes the connection pool last, after workers and consumers have stopped. */
@Injectable()
class OrmLifecycle implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

export interface AppModuleOptions {
  config: AppConfig;
  logger: AppLogger;
  metrics?: Metrics;
  /** Replaces providers with the same token (tests). */
  overrides?: Provider[];
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config, logger } = options;
    const serveApi = config.role !== 'worker';

    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      { provide: AppLogger, useValue: logger },
      { provide: Metrics, useValue: options.metrics ?? new Metrics() },
      {
        provide: MikroORM,
        useFactory: () =>
          MikroORM.init(
            buildOrmConfig({
              url: config.database.url,
              poolMax: config.database.poolMax,
              statementTimeoutMs: config.database.statementTimeoutMs,
            }),
          ),
      },
      OrmLifecycle,
      Database,
      { provide: UnitOfWork, useClass: MikroUnitOfWork },
      { provide: WalletRepository, useClass: MikroWalletRepository },
      { provide: WagerTransactionRepository, useClass: MikroWagerTransactionRepository },
      { provide: LedgerRepository, useClass: MikroLedgerRepository },
      { provide: InboxRepository, useClass: MikroInboxRepository },
      { provide: OutboxWriter, useClass: MikroOutboxWriter },
      { provide: Clock, useClass: SystemClock },
      { provide: IdGenerator, useClass: UuidV7Generator },
      { provide: FaultInjector, useClass: ProcessFaultInjector },
      SqsGateway,
      { provide: EventPublisher, useClass: SqsEventPublisher },
      OutboxPublisher,
      PendingReferencePolicy,
      ProcessWagerTransaction,
      ResolvePendingReferences,
      OpenWallet,
      ReconcileWallet,
      WageringQueries,
      WagerTransactionsConsumer,
      OutboxWorker,
      PendingReferenceWorker,
      MetricsServer,
      { provide: JWT_KEY_RESOLVER, useValue: undefined },
      {
        provide: APP_GUARD,
        inject: [Reflector, AppLogger, JWT_KEY_RESOLVER],
        useFactory: (reflector: Reflector, log: AppLogger, keys: JWTVerifyGetKey | undefined) =>
          new AuthGuard(reflector, config.auth, log, keys),
      },
      { provide: APP_FILTER, useClass: HttpErrorFilter },
      ...(options.overrides ?? []),
    ];

    return {
      module: AppModule,
      controllers: serveApi ? [WalletsController, WageringController, HealthController] : [HealthController],
      providers,
    };
  }
}
