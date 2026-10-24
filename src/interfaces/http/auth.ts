import { CanActivate, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { createRemoteJWKSet, errors as joseErrors, JWTPayload, jwtVerify, JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../../config/app-config';
import { AppLogger } from '../../observability/logger';

/**
 * Authentication is delegated to an external OIDC Identity Provider
 * (Keycloak, Zitadel, ...). This service only validates bearer tokens against
 * the IdP's JWKS: signature, issuer, audience, expiry and allowed algorithms.
 * There is no user table and no password handling here.
 *
 * Provider identity: providers authenticate with the client-credentials grant;
 * the IdP adds a `provider_id` claim (configurable) to their tokens.
 * A provider may only submit or read transactions under its own providerId.
 */

export type Scope = 'wallets:read' | 'wallets:write' | 'wagering:read' | 'wagering:write';

export interface Principal {
  subject: string;
  /** Present for provider clients; undefined for internal/admin clients and when auth is disabled. */
  providerId: string | undefined;
  scopes: ReadonlySet<string>;
  authenticated: boolean;
}

export type AuthenticatedRequest = Request & { principal?: Principal };

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Optional override of the JWKS key resolver (tests use a local key set). */
export const JWT_KEY_RESOLVER = Symbol('JWT_KEY_RESOLVER');

const IS_PUBLIC = 'auth:public';
const REQUIRED_SCOPES = 'auth:scopes';

/** Route needs no token (health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const RequireScopes = (...scopes: Scope[]) => SetMetadata(REQUIRED_SCOPES, scopes);

const ANONYMOUS: Principal = { subject: 'anonymous', providerId: undefined, scopes: new Set(), authenticated: false };

export class AuthGuard implements CanActivate {
  private readonly keys: JWTVerifyGetKey | undefined;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfig['auth'],
    private readonly logger: AppLogger,
    keyResolver?: JWTVerifyGetKey,
  ) {
    if (config.mode === 'oidc') {
      this.keys =
        keyResolver ??
        createRemoteJWKSet(new URL(config.jwksUri), { timeoutDuration: 3_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 });
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, controller])) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (this.config.mode === 'disabled') {
      // Extension point: in this mode every caller is trusted (local/dev only;
      // configuration refuses this mode in production).
      request.principal = ANONYMOUS;
      return true;
    }

    const principal = await this.authenticate(request);
    const required = this.reflector.getAllAndOverride<Scope[] | undefined>(REQUIRED_SCOPES, [handler, controller]) ?? [];
    const missing = required.filter((scope) => !principal.scopes.has(scope));
    if (missing.length > 0) {
      throw new AuthError(403, 'INSUFFICIENT_SCOPE', `Missing scope: ${missing.join(' ')}`);
    }
    request.principal = principal;
    return true;
  }

  private async authenticate(request: Request): Promise<Principal> {
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header) : null;
    if (!match) {
      throw new AuthError(401, 'UNAUTHENTICATED', 'Bearer token required');
    }
    if (this.config.mode !== 'oidc' || !this.keys) {
      throw new AuthError(401, 'UNAUTHENTICATED', 'Authentication is not configured');
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(match[1]!, this.keys, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
        clockTolerance: 30,
        requiredClaims: ['exp', 'sub'],
      }));
    } catch (err) {
      // Generic answer to the caller; the reason goes to the logs only.
      this.logger.warn('token rejected', { reason: err instanceof joseErrors.JOSEError ? err.code : 'unknown' });
      throw new AuthError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
    }

    const claim = payload[this.config.providerClaim];
    return {
      subject: String(payload.sub),
      providerId: typeof claim === 'string' && claim.length > 0 ? claim : undefined,
      scopes: scopesOf(payload),
      authenticated: true,
    };
  }
}

function scopesOf(payload: JWTPayload): Set<string> {
  const scope = payload.scope ?? payload.scp;
  if (typeof scope === 'string') return new Set(scope.split(' ').filter(Boolean));
  if (Array.isArray(scope)) return new Set(scope.filter((s): s is string => typeof s === 'string'));
  return new Set();
}

/**
 * Provider clients may only act on their own providerId. Clients without a
 * provider identity (internal back-office) are allowed through.
 */
export function assertProviderAccess(principal: Principal | undefined, providerId: string): void {
  if (principal?.authenticated && principal.providerId !== undefined && principal.providerId !== providerId) {
    throw new AuthError(403, 'PROVIDER_MISMATCH', 'Token is not allowed to act for this provider');
  }
}
