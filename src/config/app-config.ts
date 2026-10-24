import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const ms = (fallback: number) => z.coerce.number().int().min(0).max(3_600_000).default(fallback);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    INSTANCE_ID: z.string().min(1).max(64).optional(),
    HOSTNAME: z.string().max(255).optional(),

    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    DATABASE_LOCK_TIMEOUT_MS: ms(5_000),
    DATABASE_STATEMENT_TIMEOUT_MS: ms(15_000),

    AWS_REGION: z.string().default('us-east-1'),
    AWS_ENDPOINT_URL: z.string().url().optional(),
    SQS_WAGER_QUEUE: z.string().default('wager-transactions.fifo'),
    SQS_WAGER_DLQ: z.string().default('wager-transactions-dlq.fifo'),
    SQS_EVENTS_QUEUE: z.string().default('wagering-events.fifo'),
    SQS_AUTO_CREATE_QUEUES: bool.default('false'),

    CONSUMER_ENABLED: bool.optional(),
    CONSUMER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    CONSUMER_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
    CONSUMER_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(43_200).default(30),
    CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
    CONSUMER_RETRY_BASE_SECONDS: z.coerce.number().int().min(0).max(900).default(2),
    CONSUMER_RETRY_MAX_SECONDS: z.coerce.number().int().min(0).max(43_200).default(300),
    // Must exceed CONSUMER_WAIT_SECONDS so the last long poll can return and be released.
    SHUTDOWN_GRACE_MS: ms(25_000),

    OUTBOX_ENABLED: bool.optional(),
    OUTBOX_POLL_INTERVAL_MS: ms(500),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
    OUTBOX_LEASE_MS: ms(30_000),
    OUTBOX_RETRY_BASE_MS: ms(1_000),
    OUTBOX_RETRY_MAX_MS: ms(300_000),

    PENDING_REFERENCE_ENABLED: bool.optional(),
    PENDING_REFERENCE_POLL_INTERVAL_MS: ms(1_000),
    PENDING_REFERENCE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
    PENDING_REFERENCE_RETRY_BASE_MS: ms(2_000),
    PENDING_REFERENCE_RETRY_MAX_MS: ms(60_000),
    PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),

    AUTH_MODE: z.enum(['disabled', 'oidc']).default('disabled'),
    OIDC_ISSUER: z.string().url().optional(),
    OIDC_AUDIENCE: z.string().min(1).optional(),
    OIDC_JWKS_URI: z.string().url().optional(),
    /** Token claim carrying the provider identity (set by an IdP claim mapper on provider clients). */
    OIDC_PROVIDER_CLAIM: z.string().min(1).default('provider_id'),

    /** Test-only crash injection. Ignored unless NODE_ENV=test. */
    FAULT_POINT: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === 'oidc') {
      for (const key of ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URI'] as const) {
        if (!env[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when AUTH_MODE=oidc' });
      }
    }
    if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'disabled') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['AUTH_MODE'], message: 'auth cannot be disabled in production' });
    }
  });

type Env = z.infer<typeof schema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  role: Env['APP_ROLE'];
  instanceId: string;
  http: { port: number; metricsPort: number };
  logLevel: Env['LOG_LEVEL'];
  database: { url: string; poolMax: number; lockTimeoutMs: number; statementTimeoutMs: number };
  sqs: {
    region: string;
    endpoint: string | undefined;
    wagerQueue: string;
    wagerDlq: string;
    eventsQueue: string;
    autoCreateQueues: boolean;
  };
  consumer: {
    enabled: boolean;
    concurrency: number;
    waitSeconds: number;
    visibilityTimeoutSeconds: number;
    maxAttempts: number;
    retryBaseSeconds: number;
    retryMaxSeconds: number;
    shutdownGraceMs: number;
  };
  outbox: { enabled: boolean; pollIntervalMs: number; batchSize: number; leaseMs: number; retryBaseMs: number; retryMaxMs: number };
  pendingReference: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    retryBaseMs: number;
    retryMaxMs: number;
    maxAttempts: number;
  };
  auth:
    | { mode: 'disabled' }
    | { mode: 'oidc'; issuer: string; audience: string; jwksUri: string; providerClaim: string };
  faultPoint: string | undefined;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigError extends Error {}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Only report keys and reasons; never echo values, they may be secrets.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const workerRole = e.APP_ROLE !== 'api';

  return {
    env: e.NODE_ENV,
    role: e.APP_ROLE,
    // Container hostname is unique per replica; the PID is not (always 1 in a container).
    instanceId: e.INSTANCE_ID ?? e.HOSTNAME ?? `instance-${process.pid}`,
    http: { port: e.PORT, metricsPort: e.METRICS_PORT },
    logLevel: e.LOG_LEVEL,
    database: {
      url: e.DATABASE_URL,
      poolMax: e.DATABASE_POOL_MAX,
      lockTimeoutMs: e.DATABASE_LOCK_TIMEOUT_MS,
      statementTimeoutMs: e.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    sqs: {
      region: e.AWS_REGION,
      endpoint: e.AWS_ENDPOINT_URL,
      wagerQueue: e.SQS_WAGER_QUEUE,
      wagerDlq: e.SQS_WAGER_DLQ,
      eventsQueue: e.SQS_EVENTS_QUEUE,
      autoCreateQueues: e.SQS_AUTO_CREATE_QUEUES,
    },
    consumer: {
      enabled: e.CONSUMER_ENABLED ?? workerRole,
      concurrency: e.CONSUMER_CONCURRENCY,
      waitSeconds: e.CONSUMER_WAIT_SECONDS,
      visibilityTimeoutSeconds: e.CONSUMER_VISIBILITY_TIMEOUT_SECONDS,
      maxAttempts: e.CONSUMER_MAX_ATTEMPTS,
      retryBaseSeconds: e.CONSUMER_RETRY_BASE_SECONDS,
      retryMaxSeconds: e.CONSUMER_RETRY_MAX_SECONDS,
      shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    },
    outbox: {
      enabled: e.OUTBOX_ENABLED ?? workerRole,
      pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      batchSize: e.OUTBOX_BATCH_SIZE,
      leaseMs: e.OUTBOX_LEASE_MS,
      retryBaseMs: e.OUTBOX_RETRY_BASE_MS,
      retryMaxMs: e.OUTBOX_RETRY_MAX_MS,
    },
    pendingReference: {
      enabled: e.PENDING_REFERENCE_ENABLED ?? workerRole,
      pollIntervalMs: e.PENDING_REFERENCE_POLL_INTERVAL_MS,
      batchSize: e.PENDING_REFERENCE_BATCH_SIZE,
      retryBaseMs: e.PENDING_REFERENCE_RETRY_BASE_MS,
      retryMaxMs: e.PENDING_REFERENCE_RETRY_MAX_MS,
      maxAttempts: e.PENDING_REFERENCE_MAX_ATTEMPTS,
    },
    auth:
      e.AUTH_MODE === 'oidc'
        ? {
            mode: 'oidc',
            issuer: e.OIDC_ISSUER!,
            audience: e.OIDC_AUDIENCE!,
            jwksUri: e.OIDC_JWKS_URI!,
            providerClaim: e.OIDC_PROVIDER_CLAIM,
          }
        : { mode: 'disabled' },
    faultPoint: e.NODE_ENV === 'test' ? e.FAULT_POINT : undefined,
  };
}
