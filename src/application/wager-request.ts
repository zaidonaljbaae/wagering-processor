import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EXTERNAL_KINDS, INTERNAL_PROVIDER_ID } from '../domain/wager-transaction';
import { RequestValidationError } from './errors';

// Identifiers coming from providers: conservative character set, bounded length.
const externalId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must contain only letters, digits, ".", "_", ":" or "-"');

export const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'must be lowercase letters, digits, ".", "_" or "-"')
  .refine((v) => v !== INTERNAL_PROVIDER_ID, 'is reserved');

export const moneySchema = z
  .object({
    amount: z.string().max(32),
    currency: z.string().max(8),
  })
  .strict();

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7E]+$/, 'must be printable ASCII without spaces');

/** Business payload shared by the HTTP and SQS entry points. */
export const wagerRequestSchema = z
  .object({
    providerId: providerIdSchema,
    externalTransactionId: externalId,
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: externalId,
    gameId: externalId,
    kind: z.enum(EXTERNAL_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: externalId.optional(),
  })
  .strict();

export type WagerRequest = z.infer<typeof wagerRequestSchema>;

export function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Paths and messages only; input values are never echoed back.
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message })),
    );
  }
  return result.data;
}

/** JSON with recursively sorted keys and no undefined values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * payloadHash = sha256(canonicalJson(business fields)). The Idempotency-Key
 * header and transport metadata (messageId, occurredAt, ...) are excluded, so
 * the same request over HTTP or SQS hashes identically.
 */
export function wagerPayloadHash(request: WagerRequest): string {
  return sha256Hex(
    canonicalJson({
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      playerId: request.playerId,
      walletId: request.walletId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: request.kind,
      money: { amount: request.money.amount, currency: request.money.currency },
      referenceExternalTransactionId: request.referenceExternalTransactionId,
    }),
  );
}
