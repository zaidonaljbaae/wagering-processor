import type { NextFunction, Request, Response } from 'express';
import { AppLogger, logContext } from '../../observability/logger';

const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Accepts a caller-supplied correlation id when it is well formed, otherwise
 * generates one. Everything logged while serving the request carries it.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Correlation-Id', correlationId);
  logContext.run({ correlationId }, () => next());
}

/** One access-log line per request: method, route, status, latency. Never bodies. */
export function accessLogMiddleware(logger: AppLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = performance.now();
    res.on('finish', () => {
      const fields = {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      };
      if (res.statusCode >= 500) logger.error('http request', fields);
      else logger.info('http request', fields);
    });
    next();
  };
}
