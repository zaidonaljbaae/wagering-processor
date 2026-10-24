import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { RequestValidationError } from '../../application/errors';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { WageringQueries } from '../../application/queries';
import {
  idempotencyKeySchema,
  moneySchema,
  parseOrThrow,
  providerIdSchema,
  wagerRequestSchema,
} from '../../application/wager-request';
import { WagerResult } from '../../application/wager-results';
import { OpenWallet, ReconcileWallet } from '../../application/wallet-use-cases';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import { Database } from '../../infrastructure/persistence/database';
import { SqsGateway } from '../../infrastructure/messaging/sqs-gateway';
import { logContext } from '../../observability/logger';
import { assertProviderAccess, type AuthenticatedRequest, Public, RequireScopes } from './auth';

const uuid = z.string().uuid();
const externalId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const openWalletSchema = z.object({ playerId: z.string().uuid(), initialBalance: moneySchema }).strict();

const ledgerQuerySchema = z
  .object({
    cursor: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

function correlation() {
  return { correlationId: logContext.get().correlationId ?? 'unknown' };
}

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly reconcileWallet: ReconcileWallet,
    private readonly queries: WageringQueries,
  ) {}

  @Post()
  @HttpCode(201)
  @RequireScopes('wallets:write')
  create(@Body() body: unknown) {
    const input = parseOrThrow(openWalletSchema, body);
    return this.openWallet.execute(input, correlation());
  }

  @Get(':walletId')
  @RequireScopes('wallets:read')
  get(@Param('walletId') walletId: string) {
    return this.queries.wallet(parseOrThrow(uuid, walletId));
  }

  @Get(':walletId/ledger')
  @RequireScopes('wallets:read')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parseOrThrow(ledgerQuerySchema, query);
    return this.queries.ledgerPage(parseOrThrow(uuid, walletId), cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @RequireScopes('wallets:read')
  reconcile(@Param('walletId') walletId: string) {
    return this.reconcileWallet.execute(parseOrThrow(uuid, walletId));
  }
}

const STATUS_BY_RESULT: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  @RequireScopes('wagering:write')
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResult> {
    const key = idempotencyKeySchema.safeParse(idempotencyKeyHeader);
    if (!key.success) {
      throw new RequestValidationError([
        { path: 'Idempotency-Key', message: key.error.issues[0]?.message ?? 'invalid header' },
      ]);
    }
    const idempotencyKey = key.data;
    const request = parseOrThrow(wagerRequestSchema, body);
    assertProviderAccess(req.principal, request.providerId);

    const result = await this.processWager.execute({ request, idempotencyKey, correlation: correlation(), source: 'http' });
    res.status(STATUS_BY_RESULT[result.status]);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  @RequireScopes('wagering:read')
  async byId(@Param('transactionId') transactionId: string, @Req() req: AuthenticatedRequest) {
    const view = await this.queries.transaction(parseOrThrow(uuid, transactionId));
    assertProviderAccess(req.principal, view.providerId);
    return view;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @RequireScopes('wagering:read')
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const provider = parseOrThrow(providerIdSchema, providerId);
    assertProviderAccess(req.principal, provider);
    return this.queries.transactionByExternalId(provider, parseOrThrow(externalId, externalTransactionId));
  }
}

@Controller('health')
@Public()
export class HealthController {
  constructor(
    private readonly db: Database,
    private readonly sqs: SqsGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The process is up and serving requests. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Dependencies are reachable: PostgreSQL and SQS. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, sqs] = await Promise.all([
      check(() => this.db.ping()),
      check(() => this.sqs.ping(this.config.sqs.wagerQueue)),
    ]);
    const ok = database === 'up' && sqs === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { database, sqs } };
  }
}

async function check(probe: () => Promise<void>, timeoutMs = 2_000): Promise<'up' | 'down'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}
