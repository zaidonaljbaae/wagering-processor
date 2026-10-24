import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, JWK, SignJWT } from 'jose';
import { loadConfig } from '../../src/config/app-config';
import { JWT_KEY_RESOLVER } from '../../src/interfaces/http/auth';
import { createEnvironment, createWallet, http, RunningApp, startApp, TestEnvironment, wagerBody } from '../support/harness';

/*
 * OIDC mode: the service validates tokens issued by an external IdP. Here the
 * IdP is simulated with a local key pair; the validation path is the real one.
 */

const ISSUER = 'https://idp.example.test/realms/wagering';
const AUDIENCE = 'wagering-api';

let env: TestEnvironment;
let secured: RunningApp;
let open: RunningApp;
let privateKey: CryptoKey;
let foreignKey: CryptoKey;

async function token(claims: Record<string, unknown>, options: { key?: CryptoKey; issuer?: string; audience?: string; expiresIn?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject(String(claims.sub ?? 'client'))
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(options.key ?? privateKey);
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  env = await createEnvironment('auth');
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  foreignKey = (await generateKeyPair('RS256')).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  secured = await startApp(
    env,
    { AUTH_MODE: 'oidc', OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: 'https://idp.example.test/certs' },
    [{ provide: JWT_KEY_RESOLVER, useValue: createLocalJWKSet({ keys: [jwk] }) }],
  );
  open = await startApp(env); // to create fixtures without tokens
});
afterAll(async () => {
  await secured?.close();
  await open?.close();
  await env?.dispose();
});

describe('OIDC bearer tokens', () => {
  test('health stays public', async () => {
    expect((await http(secured.baseUrl, 'GET', '/health/live')).status).toBe(200);
  });

  test('missing or malformed token is 401', async () => {
    const res = await http(secured.baseUrl, 'GET', `/wallets/${crypto.randomUUID()}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect((await http(secured.baseUrl, 'GET', '/wallets/x', undefined, { Authorization: 'Basic abc' })).status).toBe(401);
  });

  test.each([
    ['signed by an unknown key', { key: 'foreign' }],
    ['wrong issuer', { issuer: 'https://evil.example' }],
    ['wrong audience', { audience: 'other-api' }],
    ['expired', { expiresIn: '-10m' }],
  ])('rejects a token %s', async (_label, opts) => {
    const t = await token(
      { scope: 'wallets:read' },
      {
        ...('key' in opts && { key: foreignKey }),
        ...('issuer' in opts && { issuer: opts.issuer as string }),
        ...('audience' in opts && { audience: opts.audience as string }),
        ...('expiresIn' in opts && { expiresIn: opts.expiresIn as string }),
      },
    );
    const res = await http(secured.baseUrl, 'GET', `/wallets/${crypto.randomUUID()}`, undefined, bearer(t));
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid or expired token'); // no detail leaked
  });

  test('rejects unsigned tokens (alg=none)', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: 'x', exp: Math.floor(Date.now() / 1000) + 300, scope: 'wallets:read' })).toString('base64url');
    const res = await http(secured.baseUrl, 'GET', `/wallets/${crypto.randomUUID()}`, undefined, bearer(`${header}.${payload}.`));
    expect(res.status).toBe(401);
  });

  test('valid token without the required scope is 403', async () => {
    const t = await token({ scope: 'wallets:read' });
    const res = await http(secured.baseUrl, 'POST', '/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' } }, bearer(t));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
  });

  test('a provider can only act for itself', async () => {
    const w = await createWallet(open.baseUrl, '100.00');
    const providerA = await token({ scope: 'wagering:write wagering:read', provider_id: 'provider-a' });

    const own = await http(secured.baseUrl, 'POST', '/wagering/transactions', wagerBody({ ...w, kind: 'BET', amount: '1.00' }), {
      ...bearer(providerA),
      'Idempotency-Key': `k-${crypto.randomUUID()}`,
    });
    expect(own.status).toBe(200);

    const spoofed = await http(
      secured.baseUrl,
      'POST',
      '/wagering/transactions',
      wagerBody({ ...w, kind: 'BET', amount: '1.00', providerId: 'provider-b' }),
      { ...bearer(providerA), 'Idempotency-Key': `k-${crypto.randomUUID()}` },
    );
    expect(spoofed.status).toBe(403);
    expect(spoofed.body.code).toBe('PROVIDER_MISMATCH');

    const readOther = await http(secured.baseUrl, 'GET', '/providers/provider-b/wagering/transactions/x', undefined, bearer(providerA));
    expect(readOther.status).toBe(403);
  });
});

describe('configuration guard rails', () => {
  test('auth cannot be disabled in production', () => {
    expect(() => loadConfig({ ...env.env, NODE_ENV: 'production', AUTH_MODE: 'disabled' })).toThrow('auth cannot be disabled in production');
  });

  test('oidc mode requires issuer, audience and JWKS', () => {
    expect(() => loadConfig({ ...env.env, AUTH_MODE: 'oidc' })).toThrow('OIDC_ISSUER');
  });

  test('config errors never echo secret values', () => {
    try {
      loadConfig({ DATABASE_URL: 'postgresql://user:super-secret@host/db', PORT: 'not-a-port' });
    } catch (err) {
      expect(String(err)).not.toContain('super-secret');
      expect(String(err)).toContain('PORT');
    }
  });

  test('fault injection is ignored outside tests', () => {
    expect(loadConfig({ ...env.env, NODE_ENV: 'development', FAULT_POINT: 'after_commit_before_ack' }).faultPoint).toBeUndefined();
  });
});
