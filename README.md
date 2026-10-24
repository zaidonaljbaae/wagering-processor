# Wagering Processor

This is a distributed financial service. It processes wagering operations (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) sent by game providers over HTTP and AWS SQS, and it stays correct when messages are duplicated, arrive out of order, or are processed at the same time by several instances.

**Stack:** Bun · TypeScript (strict) · NestJS · PostgreSQL · MikroORM · AWS SQS (LocalStack) · Docker Compose

- Design decisions, trade-offs and limitations: **[ARCHITECTURE.md](ARCHITECTURE.md)**
- Original challenge statement (pt-BR): [docs/CHALLENGE.md](docs/CHALLENGE.md)

## Quick start

Requirements: Docker (with Compose v2), and [Bun ≥ 1.2](https://bun.sh) to run the tests and the load test.

```bash
docker compose up -d --build
```

This starts the following services:

| Service | What it does |
|---|---|
| `postgres` | PostgreSQL 17, exposed on `127.0.0.1:5432` |
| `localstack` | SQS, exposed on `127.0.0.1:4566` |
| `setup` | one-shot: runs the migrations and creates the queues (`wager-transactions.fifo`, its DLQ, `wagering-events.fifo`) |
| `api` | HTTP API on `http://127.0.0.1:3000`, Prometheus metrics on `:9464/metrics` |
| `worker` ×2 | SQS consumer, outbox publisher, pending-reference resolver |

```bash
curl -s localhost:3000/health/ready
# {"status":"ok","checks":{"database":"up","sqs":"up"}}
```

You can override the defaults in `.env` (see `.env.example`). Authentication is disabled by default for local use; see [Authentication](#authentication).

## Using the API

```bash
# Create a wallet (the initial balance becomes an OPENING credit on the ledger)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# Place a bet (Idempotency-Key is required)
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<wallet id>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
# {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

| Method | Path | Notes |
|---|---|---|
| `POST` | `/wallets` | `201`; `409 WALLET_ALREADY_EXISTS` for the same player + currency |
| `GET` | `/wallets/:walletId` | balance and version |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | keyset pagination; `nextCursor` is opaque |
| `POST` | `/wallets/:walletId/reconciliation` | stored vs. rebuilt-from-ledger balance; never auto-fixes |
| `POST` | `/wagering/transactions` | `200` processed · `202` pending reference · `422` rejected (+`failureCode`) · `409` conflict · `503` retry |
| `GET` | `/wagering/transactions/:transactionId` | |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | |
| `GET` | `/health/live`, `/health/ready` | public |

The full status table and the failure codes are in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-failure-codes-and-http-statuses).

### Sending through SQS

Send this message to `wager-transactions.fifo`, using `MessageGroupId = walletId`:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Integration events are published to `wagering-events.fifo`.

## Tests

The integration and concurrency suites run against **real** PostgreSQL and LocalStack. Each test file creates its own database and its own queues, so you can run the suites in any order, repeatedly, even while the compose stack is up.

```bash
bun install
bun run infra:up            # postgres + localstack only (skip if the full stack is already up)

bun run test:unit           # domain + application rules, no I/O
bun run test:integration    # schema constraints, API, SQS/inbox/DLQ, outbox, auth
bun run test:concurrency    # parallel races across instances + real multi-process crash tests
bun run test:all            # everything
bun run typecheck
```

The API, messaging and concurrency suites finish by checking `wallet.balance == balance rebuilt from the ledger` for every wallet. The schema suite does not: it writes inconsistent rows on purpose to prove the database refuses them.

If your PostgreSQL or LocalStack runs elsewhere, set `TEST_DATABASE_URL` and `TEST_SQS_ENDPOINT`. Set `TEST_LOG_LEVEL=info` to see the service logs while the tests run.

### Load test

With the stack up:

```bash
bun run test:load                                   # 30s, 32 clients, 20% traffic on one hot wallet
HOT_SHARE=0 DURATION_SECONDS=60 bun run test:load   # no hot wallet
```

It reports throughput, p50/p95/p99, the status distribution, the error rate, lock waits, duplicates, outbox lag, and a final balance-vs-ledger check. Results and their analysis are in [ARCHITECTURE.md §17](ARCHITECTURE.md#17-load-test).

## Commands

| Command | |
|---|---|
| `bun run start` | start the service (`APP_ROLE=api\|worker\|all`) |
| `bun run dev` | start with watch mode |
| `bun run migrate` / `bun run migrate:down` | apply / revert migrations (`DATABASE_URL` required) |
| `bun scripts/setup.ts` | migrations + queue creation (what the `setup` container runs) |
| `bun run infra:up` / `bun run infra:down` | start / remove postgres + localstack (`down` also deletes volumes) |

## Configuration

All settings come from environment variables and are validated at startup (`src/config/app-config.ts`). The most relevant ones:

| Variable | Default | |
|---|---|---|
| `APP_ROLE` | `all` | `api` serves HTTP; `worker` runs the consumer + outbox + pending-reference loops |
| `DATABASE_URL` | - | required |
| `DATABASE_LOCK_TIMEOUT_MS` | `5000` | wallet lock wait before a retryable `503` |
| `CONSUMER_MAX_ATTEMPTS` | `5` | transient retries before the DLQ |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | ≈ 6–7 min window for out-of-order references |
| `OUTBOX_LEASE_MS` | `30000` | how long a claimed outbox batch is reserved |
| `AUTH_MODE` | `disabled` | `oidc` in any shared environment (refused as `disabled` in production) |

## Authentication

Authentication is delegated to an external OIDC IdP (Keycloak, Zitadel, …). To enable it:

```bash
AUTH_MODE=oidc
OIDC_ISSUER=https://idp.example.com/realms/wagering
OIDC_AUDIENCE=wagering-api
OIDC_JWKS_URI=https://idp.example.com/realms/wagering/protocol/openid-connect/certs
```

Tokens need the scopes `wallets:read|write` and `wagering:read|write`. Provider clients carry a `provider_id` claim and can only act for that provider. The Keycloak setup recipe is in [ARCHITECTURE.md §15](ARCHITECTURE.md#15-authentication).

## Project layout

```
src/
  domain/          Money, Wallet, ledger, WagerTransaction, settlement rules, events (framework-free)
  application/     use cases, ports, request schema, idempotency hash, queries
  infrastructure/  MikroORM persistence + migration, SQS gateway, outbox publisher
  interfaces/      HTTP controllers/auth/errors, SQS consumer, background workers
  observability/   JSON logger with correlation context, Prometheus metrics
test/
  unit/  integration/  concurrency/  support/
scripts/           setup, load test
```
