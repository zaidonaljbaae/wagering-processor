import { AsyncLocalStorage } from 'node:async_hooks';
import { LoggerService } from '@nestjs/common';
import pino, { Logger as PinoLogger } from 'pino';

/** Correlation fields attached to every log line emitted inside a context. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export const logContext = {
  run<T>(ctx: LogContext, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...ctx }, fn);
  },
  /** Adds fields to the current context (e.g. transactionId once it is known). */
  assign(fields: LogContext): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },
  get(): LogContext {
    return storage.getStore() ?? {};
  },
};

export type LogFields = Record<string, unknown>;

/**
 * Structured JSON logger. Payloads and amounts are never logged on purpose:
 * only identifiers, statuses and error codes. `redact` is a safety net.
 */
export class AppLogger {
  constructor(private readonly pinoLogger: PinoLogger) {}

  static create(options: { level: string; instanceId: string }): AppLogger {
    return new AppLogger(
      pino({
        level: options.level,
        base: { service: 'wagering-processor', instance: options.instanceId },
        timestamp: pino.stdTimeFunctions.isoTime,
        messageKey: 'msg',
        formatters: { level: (label) => ({ level: label }) },
        mixin: () => ({ ...storage.getStore() }),
        redact: {
          paths: ['authorization', '*.authorization', 'headers.authorization', 'password', '*.password', 'token', '*.token'],
          censor: '[redacted]',
        },
      }),
    );
  }

  child(bindings: LogFields): AppLogger {
    return new AppLogger(this.pinoLogger.child(bindings));
  }

  debug(msg: string, fields?: LogFields): void {
    this.pinoLogger.debug(fields ?? {}, msg);
  }
  info(msg: string, fields?: LogFields): void {
    this.pinoLogger.info(fields ?? {}, msg);
  }
  warn(msg: string, fields?: LogFields): void {
    this.pinoLogger.warn(fields ?? {}, msg);
  }
  error(msg: string, fields?: LogFields): void {
    this.pinoLogger.error(fields ?? {}, msg);
  }
}

/** Error fields safe to log: type, code and message, no stack in production logs. */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { error: { type: err.name, message: err.message, ...(code !== undefined && { code }) } };
  }
  return { error: { type: typeof err } };
}

/** Routes Nest framework logs through the same JSON logger. */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(message: unknown, context?: string): void {
    this.logger.info(String(message), { context });
  }
  error(message: unknown, _trace?: string, context?: string): void {
    this.logger.error(String(message), { context });
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn(String(message), { context });
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug(String(message), { context });
  }
  verbose(message: unknown, context?: string): void {
    this.logger.debug(String(message), { context });
  }
}
