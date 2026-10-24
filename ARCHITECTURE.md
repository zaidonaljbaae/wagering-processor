# Architecture

This document explains how the wagering processor works and, more importantly, why it is built this way. Each section ends with the trade-off I accepted. Limitations are listed at the end. I prefer stating them over hiding them.

## 1. Overview

```
                ┌──────────────┐     POST /wagering/transactions
 providers ───▶ │  HTTP (Nest) │──┐
                └──────────────┘  │
                                  ▼
                       ┌─────────────────────────┐        ┌────────────────────────────┐
 providers ───▶ SQS ─▶ │ ProcessWagerTransaction │ ─────▶ │ PostgreSQL (one SQL tx):   │
  wager-transactions   │   (single use case)     │        │  wallet row lock           │
  .fifo                └─────────────────────────┘        │  wager_transactions        │
      │                                                   │  wallet_ledger_entries     │
      └── DLQ (wager-transactions-dlq.fifo)               │  inbox_messages (SQS only) │
                                                          │  outbox_messages           │
                                                          └─────────────┬──────────────┘
                                                                        │ after commit
                   ┌───────────────────────────┐                        ▼
                   │ PendingReferenceWorker    │◀── PENDING_REFERENCE   OutboxWorker ──▶ SQS wagering-events.fifo
                   └───────────────────────────┘                     (SKIP LOCKED + lease)
```

All the money logic lives in a single use case, `ProcessWagerTransaction`. HTTP and SQS are two thin adapters in front of it. The database is the final authority on every invariant. The broker's FIFO ordering and deduplication are treated as optimizations only.

One Docker image can run in three roles (`APP_ROLE`): `api`, `worker` or `all`. Any number of replicas of each role can run at the same time. Nothing is kept in process memory that affects correctness.

## 2. Code layout

```
src/
  domain/          pure TypeScript: Money, Wallet, WalletLedgerEntry, WagerTransaction,
                   settlement rules, failure codes, integration events, inbox/outbox messages
  application/     use cases + ports (abstract classes used as DI tokens), request schema,
                   payload hash, queries
  infrastructure/  MikroORM persistence (schemas, mappers, repositories, migration),
                   SQS gateway, outbox publisher, clock/ids/fault injection
  interfaces/      HTTP controllers, auth guard, error mapping, SQS consumer, polling workers
  observability/   structured logger (pino + AsyncLocalStorage context), Prometheus metrics
  config/          zod-validated environment
```

- The domain does not import NestJS, MikroORM, or any other framework. The only external library it uses is `decimal.js`.
- Every aggregate has a `private` constructor and static factories (`create`/`open`/`from`/`rehydrate`).
- `rehydrate` restores persisted state and does not re-run transition checks.

**Trade-off.** The application layer uses Nest's `@Injectable` and imports the metrics/logger from `observability/`. A purist hexagon would hide those behind more ports. I chose fewer files over that extra indirection.

## 3. Persistence: MikroORM, Money and transactions

**ORM.** I use MikroORM 6 (the preferred option).
- Records are defined with `EntitySchema`, with no decorators.
- The records live in `infrastructure/persistence`. Mappers turn them into aggregates through `rehydrate`, so the domain stays free of ORM types.
- Repositories use `em.insert` / `em.nativeUpdate` / `em.findOne(..., { lockMode: PESSIMISTIC_WRITE })`. Where the SQL itself is the point (`SKIP LOCKED` claims, `ON CONFLICT DO NOTHING`, aggregate sums), they use parameterized `em.execute`.
- I deliberately do not lean on the Unit of Work's automatic change tracking for financial writes. Every write is explicit, in a known order, and guarded. That makes the exact SQL easy to review.

**Money.**
- In the domain: `Money` wraps an isolated `decimal.js` constructor.
- In the database: `numeric(20,2)` for the amount plus a `char(3)` currency column.
- On the wire: decimal strings such as `"25.00"`.
- `number` is never used for amounts, anywhere.
- Input parsing is strict: exactly two decimals, no sign, no exponent, no leading zeros, and an ISO-4217 currency (checked against `Intl.supportedValuesOf('currency')`).
- `Money.rehydrate` accepts what PostgreSQL returns, which may have fewer trailing zeros or be negative in intermediate calculations such as reconciliation differences.

**Transactions.** `UnitOfWork.run()` wraps `em.fork().transactional()`. Repositories pick up the active transaction through MikroORM's `TransactionContext`. Each transaction starts with `SET LOCAL lock_timeout`, so a stuck lock turns into a retryable 503 instead of a hanging request. Isolation is READ COMMITTED for writes: correctness comes from the row lock, not from the isolation level. Reconciliation uses a read-only REPEATABLE READ snapshot.

## 4. Concurrency

**The unit of concurrency is the wallet.** Every balance-affecting transaction does this:

```
BEGIN
  SET LOCAL lock_timeout = 5s
  SELECT ... FROM wallets WHERE id = $1 FOR UPDATE       -- serializes this wallet only
  (SQS) INSERT inbox ... ON CONFLICT DO NOTHING          -- duplicate message → stop
  re-check idempotency key / external id under the lock  -- duplicate request → replay
  resolve reference, apply business rules (domain)
  INSERT wager_transactions
  UPDATE wallets SET balance, version WHERE id AND version = <read under lock>
  INSERT wallet_ledger_entries
  INSERT outbox_messages
COMMIT
```

**Why pessimistic locking.** With a row lock, *read → calculate → update* is safe by construction, and retries never happen in the common path. Optimistic locking would turn every collision on a busy ("hot") wallet into a retry, which wastes work exactly under the heaviest load. A plain conditional `UPDATE ... WHERE balance >= x` handles BET, but not the reference checks (single reversal, amount equality), which must read other rows consistently. The lock covers all of them.

**Lock scope.**
- Different wallets never block each other.
- There is no global lock and no advisory lock shared by all wallets.
- Two operations can never need two wallet locks: a reference must belong to the same wallet. So lock ordering cannot cause a deadlock.

**Defense in depth.**
- `version` is still checked in the `UPDATE`.
- `CHECK (balance_amount >= 0)` and the ledger triggers (section 12) would refuse a corrupted write even if the code had a bug.

**Trade-off.** A hot wallet is processed strictly one operation at a time. The load test (section 16) shows that this is the dominant latency factor when 20% of traffic targets one wallet. I consider that the correct trade for money: the alternative is retry storms or weaker guarantees.

## 5. Idempotency

- **Key.** The `Idempotency-Key` header is required and is the source of truth. It is scoped per provider: `UNIQUE (provider_id, idempotency_key)`. The recommended value is `{providerId}:{externalTransactionId}`, but it is not enforced.
- **`payloadHash`.** It is `sha256(canonicalJson(fields))` over the business fields only: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`. Canonical JSON means keys sorted recursively and `undefined` dropped. The header, `messageId`, `occurredAt` and the correlation id are excluded, so the same operation hashes the same over HTTP and SQS.
- **Replay.** Same key and same hash return the stored result with `idempotentReplay: true`. That includes the balance observed when the result was decided (`balance_after_amount`), not the current balance.
- **Conflicts.**
  - Same key with a different hash is a `409 IDEMPOTENCY_KEY_CONFLICT`.
  - Same `(providerId, externalTransactionId)` under another key is a `409 EXTERNAL_TRANSACTION_CONFLICT` (`UNIQUE (provider_id, external_transaction_id)`).
- **Where the check happens.**
  1. A lock-free fast path runs first and catches most HTTP duplicates. SQS messages skip it, so every delivery records its inbox row even when the operation is a replay (for example, first processed over HTTP).
  2. The authoritative check runs again *under the wallet lock*. This is what turns 50 identical concurrent requests into exactly one debit.
  3. Unique constraints are the last line of defense. A `unique_violation` triggers a replay lookup, never a 500.
- **A race found by the load test.**
  - The problem: the fast path reads by key and then by external id, as two separate statements. The original request can commit between them, so the second read returns the original itself. The first version reported that as an external-id conflict.
  - The fix: a row with the same key is now treated as a replay.
  - The guard: a unit test reproduces that exact interleaving (`test/unit/application/process-wager-replay-race.test.ts`).
- **Never in memory.** No cache is involved anywhere.

## 6. Transaction state machine

```
PENDING ──▶ PROCESSED            (terminal)
   │   └──▶ REJECTED             (terminal, failureCode)
   │   └──▶ FAILED               (terminal, failureCode, audit)
   └──▶ PENDING_REFERENCE ──▶ PROCESSED | REJECTED | FAILED
              │  ▲
              └──┘ retry bookkeeping (attempts, nextAttemptAt)
```

Transitions are enforced in two places:
- In the domain: `InvalidTransactionStateError` for programming errors.
- In the database: the `trg_tx_guard` trigger refuses any update of a terminal row, and refuses changes to business columns of a non-terminal row.

`PENDING` exists in the model but is never persisted, because a transaction is written once its outcome is known. `OPENING` is internal only: the request schema and the domain factory both refuse it, and `providerId = 'internal'` is reserved.

## 7. Business rules and my interpretations

The rule table in the challenge statement is implemented in `domain/wager-settlement.ts`. Where the statement left room, I chose the following:

1. **A reference can be reversed once, whatever the kind.** The statement says "not twice by the same operation type". But REFUND and then ROLLBACK of the same BET would credit it twice. The database enforces the stricter rule with a partial unique index on `reference_transaction_id` for processed REFUND/ROLLBACK rows. A ROLLBACK *of a REFUND* is allowed: it references the REFUND, not the BET.
2. **An optional reference on WIN or LOSS is validated.** It must be a BET of the same provider, player, wallet, currency and round. If it has not arrived yet, the WIN/LOSS waits (`PENDING_REFERENCE`) just like a REFUND.
3. **A reference that exists but was REJECTED or FAILED** is rejected with `REFERENCE_NOT_PROCESSED`. A reference that is still pending makes the dependent operation wait too.
4. **LOSS may carry `0.00`.** Every other kind requires an amount greater than zero.
5. **The wallet must belong to the player.** `playerId` must own `walletId`, otherwise the result is `WALLET_PLAYER_MISMATCH`.
6. **Unknown wallet.** It cannot be persisted (foreign key), so it returns `404` over HTTP and goes to the DLQ over SQS.

## 8. Failure codes and HTTP statuses

| `failureCode` | Meaning | Provider action |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET larger than the balance | do not resend |
| `REVERSAL_INSUFFICIENT_FUNDS` | REFUND/ROLLBACK would make the balance negative | manual follow-up |
| `CURRENCY_MISMATCH` | currency differs from the wallet | fix the payload |
| `WALLET_PLAYER_MISMATCH` | player does not own the wallet | fix the payload |
| `REFERENCE_NOT_FOUND` | reference never arrived within the retry window | resend the original, then a new reversal |
| `REFERENCE_NOT_PROCESSED` | reference exists but was rejected or failed | do not resend |
| `REFERENCE_MISMATCH` | reference from another player, wallet, currency or round | fix the payload |
| `INVALID_REFERENCE_KIND` | e.g. REFUND → WIN | fix the payload |
| `REFERENCE_AMOUNT_MISMATCH` | partial reversal (out of scope) | fix the payload |
| `REFERENCE_ALREADY_REVERSED` | reference already reversed | do not resend |
| `PROCESSING_FAILED` | permanent infrastructure failure (`FAILED`) | contact operator |

The same table applies to every endpoint, so the status alone tells a provider whether it can resend:

| Status | When | Resend with the same key? |
|---|---|---|
| `200` | `PROCESSED` (first time or replay) | - |
| `202` | `PENDING_REFERENCE`: accepted, outcome later | poll `GET` |
| `400 VALIDATION_FAILED` | invalid payload or header | no, fix it |
| `401` / `403` | token / scope / provider mismatch | no |
| `404` | unknown wallet or transaction | no |
| `409` | idempotency or uniqueness conflict | no |
| `422` | `REJECTED` (body carries `failureCode`) | replay returns the same 422 |
| `503` + `Retry-After` | lock timeout, deadlock, DB/SQS unavailable | **yes** |
| `500` | unexpected | yes (idempotent) |

Error bodies are always `{ code, message, issues? }`. Values from the input are never echoed back, and neither are internal error messages.

## 9. SQS consumer

- **Same use case as HTTP.** The consumer adds an inbox entry to the command.
- **Inbox.** It is `inbox_messages (consumer_name, message_id)`, inserted with `ON CONFLICT DO NOTHING` inside the same transaction as the effect. A committed row means "processed". A duplicate delivery rolls back and returns the stored result. A new `messageId` for an operation that already exists (sent again by the provider, or first seen over HTTP) commits its inbox row and acks with the stored result, so the inbox is a complete record of deliveries.
- **Ack only after commit.** A crash between commit and ack (tested with a real process kill) leads to redelivery, which the inbox absorbs.
- **Failure classes:**
  - The outcome is recorded (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`): **ack**.
  - The message can never succeed (malformed JSON, schema error, `OPENING`, idempotency conflict, unknown wallet): the message is copied **to the DLQ** with a `failureReason` attribute, then deleted from the main queue.
  - Transient (DB connection, lock timeout, deadlock, SQS error, anything unknown): **retry**. The visibility timeout is set to an exponential backoff (`base * 2^(n-1)`, capped). After `CONSUMER_MAX_ATTEMPTS` the message goes to the DLQ as `RETRIES_EXHAUSTED`.
  - When in doubt, retry. Redelivery is idempotent, losing a message is not.
- **Safety net.** The SQS redrive policy has `maxReceiveCount = CONSUMER_MAX_ATTEMPTS + 1`, so a message still reaches the DLQ even if the app cannot move it there itself.
- **Ordering.** `MessageGroupId = walletId` keeps per-wallet ordering where the producer sets it. Messages of a batch are processed sequentially.
- **SIGTERM.**
  - Polling stops.
  - Messages already in progress finish.
  - Messages received but not started are released with `ChangeMessageVisibility(0)`.
  - The pending long poll is deliberately *not* aborted. Aborting it client-side still lets SQS complete the receive on the server, which hides the message until its visibility timeout. I found this through a test that failed intermittently.
  - `SHUTDOWN_GRACE_MS` is set higher than `CONSUMER_WAIT_SECONDS`.

## 10. Transactional outbox

Events are inserted into `outbox_messages` in the business transaction. Nothing is published before commit.

The publisher, which can run on any number of instances:
1. **Claims a batch:**
   `UPDATE outbox_messages SET locked_until = now() + lease WHERE id IN (SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now()) ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT n) RETURNING ...`
   Concurrent publishers get disjoint batches.
2. **Publishes each event.** Destination: `wagering-events.fifo`, with `MessageGroupId = aggregateId` and `MessageDeduplicationId = eventId`.
3. **Marks it published.** On failure, it schedules a retry (`attempts`, `next_attempt_at` with jittered exponential backoff, `last_error`).

If a publisher dies after claiming, the lease expires and another instance publishes. This is tested with a real process kill at `outbox_after_claim`. The worst case is a duplicate publish: consumers deduplicate by `eventId`, and the FIFO dedup id absorbs duplicates within 5 minutes.

**Events.** Each event is a concrete subclass of the abstract `IntegrationEvent<T>`, and `eventType`/`version` are declared on the class.
- `WagerTransactionProcessed`: every applied transaction, including LOSS and OPENING.
- `WagerTransactionRejected`.
- `WagerTransactionPendingReference`: once, when parking.
- `WalletBalanceChanged`: only when the balance moves, and it carries `walletVersion` so consumers can order events.
- Payloads carry `MoneyProps` strings, never `Money` instances.

**Trade-off.** Ordering *across* publishers is per aggregate group, not global. Consumers that care about per-wallet order should use `walletVersion`.

## 11. Out-of-order references

- **First arrival.** A transaction whose reference is missing is stored as `PENDING_REFERENCE` and the response is `202`.
- **The worker.** `PendingReferenceWorker` polls due rows (`ix_tx_pending_reference`) and re-evaluates each one under its wallet lock. Before acting, it re-reads the row and skips it if another worker already handled it.
- **Policy.** Exponential backoff with jitter: base 2 s, capped at 60 s, at most 10 attempts, which is about 6–7 minutes in total.
- **Why that window.** Providers deliver the original within seconds in practice. Waiting longer only keeps money in limbo and delays the answer to the player.
- **After the last attempt.** The transaction becomes `REJECTED` with `REFERENCE_NOT_FOUND`, and a `WagerTransactionRejected` event is emitted.
- **Configuration.** All of this is set through `PENDING_REFERENCE_*`.

## 12. Guarantees enforced by the database

| Guarantee | Mechanism |
|---|---|
| one wallet per player and currency | `uq_wallets_player_currency` |
| balance never negative | `CHECK (balance_amount >= 0)`, also on the ledger balances |
| balance change ⇒ version + 1, and vice versa | trigger `trg_wallet_guard` |
| stored balance = last ledger balance | **deferred** constraint triggers, checked at commit: `trg_wallet_matches_ledger` when the wallet changes, `trg_ledger_matches_wallet` when an entry is added (so an entry without a wallet update cannot commit) |
| a ledger entry belongs to a PROCESSED transaction of the same wallet, in the wallet currency | composite FKs `fk_ledger_tx_wallet`, `fk_ledger_wallet_currency`; status checked by `trg_ledger_matches_wallet` |
| a PROCESSED transaction is in the wallet currency | trigger `trg_tx_currency` (a `REJECTED` one may differ: `CURRENCY_MISMATCH` is stored for audit) |
| ledger is append-only | triggers refuse `UPDATE`, `DELETE`, `TRUNCATE` |
| ledger line arithmetic | `CHECK (balance_after = balance_before ± amount)` |
| ledger is a chain | trigger `trg_ledger_chain`: each entry starts where the previous one ended |
| at most one entry per transaction and wallet | `uq_ledger_wallet_tx` |
| idempotency key / external id uniqueness | `uq_tx_idempotency`, `uq_tx_external` (per provider) |
| reversal at most once | partial unique index `uq_tx_single_reversal` |
| REFUND/ROLLBACK need a reference; BET cannot have one | `CHECK` constraints |
| terminal rows frozen, business columns immutable, no deletes | trigger `trg_tx_guard`, `trg_tx_no_delete` |
| failure code ⇔ REJECTED/FAILED, processed_at ⇔ PROCESSED | `CHECK` constraints |
| inbox dedup | `PRIMARY KEY (consumer_name, message_id)` |

Migrations are versioned and reversible: `bun run migrate` and `bun run migrate:down` (one step at a time). The second migration, `LedgerIntegrity`, closed raw-SQL gaps found in a review: the balance check used to run only when the wallet row changed. A test runs both down and up again.

## 13. Observability

- **Logs.** One JSON line per event, written with pino.
  - `correlationId`, `messageId`, `transactionId`, `walletId` and `providerId` come from an `AsyncLocalStorage` context, so every line written during a request or message carries them.
  - Payloads, amounts and headers are not logged; only identifiers, statuses and error codes. `redact` is a safety net.
- **Metrics.** Prometheus, served on a separate port (`METRICS_PORT`, default 9464).
  - `wager_transactions_total{status,kind,source}`
  - `wager_duplicates_total{source,reason}`
  - `wager_idempotency_conflicts_total`
  - `wager_retries_total{component}`
  - `sqs_dead_lettered_total{reason}`
  - `wallet_lock_conflicts_total`, `wallet_lock_wait_seconds`
  - `wager_processing_duration_seconds`
  - `outbox_lag_seconds`, `outbox_published_total`, `outbox_publish_failures_total`
  - `reconciliation_mismatches_total`, `pending_reference_expired_total`
  - default process metrics
- **Health.** `/health/live` checks the process. `/health/ready` checks PostgreSQL `SELECT 1` and SQS `GetQueueAttributes`, each with a 2 s timeout. Both are public.
- **Reconciliation.** `POST /wallets/:id/reconciliation` never fixes anything. A mismatch is logged at error level, counted, and reported with `consistent: false`.

## 14. Security

- **Input.**
  - Strict zod schemas: unknown fields are refused, identifiers use a restricted character set, lengths are bounded.
  - JSON bodies only, at most 16 KB.
  - The query parser runs in simple mode.
- **Output.**
  - Errors never echo input values or internal messages.
  - `helmet` headers are set and `x-powered-by` is removed.
  - CORS stays disabled: this is a server-to-server API.
- **SQL.** All SQL is parameterized. The only interpolated value is `lock_timeout`, an integer from validated config.
- **Configuration.**
  - The environment is validated at startup, and error messages list keys, never values.
  - `AUTH_MODE=disabled` is refused when `NODE_ENV=production`.
  - The fault injector is ignored outside `NODE_ENV=test`.
- **Container.**
  - Multi-stage build, non-root user.
  - Production dependencies only, installed with `--frozen-lockfile --ignore-scripts`.
  - Compose runs it with a read-only root filesystem, `cap_drop: ALL` and `no-new-privileges`. Ports bind to `127.0.0.1`.
- **Supply chain.**
  - Exact dependency versions and a committed `bun.lock`.
  - `bun audit`: `ajv` is pinned to a fixed version through `overrides`.
  - One finding remains: `braces@3.0.3`, a transitive dependency of MikroORM's glob tooling. No patched release exists. It is not reachable here: entities and migrations are passed as explicit lists, and no glob is ever built from input.

## 15. Authentication

Authentication is delegated to an external OIDC Identity Provider such as Keycloak or Zitadel. There is no user table and no password handling.

- **`AUTH_MODE=oidc`.** `AuthGuard` validates bearer JWTs against the IdP's JWKS (`jose`, remote key set with caching). It checks the signature, the algorithm allow-list (`RS256`, `PS256`, `ES256`, `EdDSA`; `none` is impossible), the issuer, the audience, `exp`/`sub`, and allows 30 s of clock skew.
- **Scopes.** `wallets:read`, `wallets:write`, `wagering:read`, `wagering:write`.
- **Provider identity.** Providers use the client-credentials grant. An IdP claim mapper adds `provider_id` to their tokens; the claim name is configurable. A token with `provider_id` may only submit or read transactions of that provider (`403 PROVIDER_MISMATCH`). Back-office clients without the claim are not restricted to one provider.
- **`AUTH_MODE=disabled`** is meant for local work and tests only. Every caller is trusted, and production refuses this mode.
- **Health** endpoints are public. Messages from the queue are treated as an internal trusted channel, but their `providerId` goes through the same schema and domain validation.
- **Keycloak recipe.**
  1. Create a realm `wagering`.
  2. Create one confidential client per provider with *service accounts* enabled.
  3. Add the client scopes `wagering:*` / `wallets:*`.
  4. Add a hardcoded-claim mapper `provider_id=<provider>`.
  5. Add an audience mapper `wagering-api`.
  6. Set `OIDC_ISSUER`, `OIDC_AUDIENCE` and `OIDC_JWKS_URI` (`.../protocol/openid-connect/certs`).
- **Testing.** The guard is exercised end to end with a locally generated key pair: valid tokens, foreign keys, wrong issuer/audience, expired tokens, `alg=none`, missing scopes and provider spoofing. Keycloak itself is not part of the compose file, to keep the stack light. Adding it is configuration only.

## 16. Tests

Run `bun run infra:up` first. Each test file creates its own database (migrated) and its own queues on LocalStack, so the files are isolated and can be re-run. Nothing replaces PostgreSQL or SQS with mocks.

| Suite | What it proves |
|---|---|
| `test/unit` | Money parsing, scale, exactness and currency conflicts; wallet invariants; every rule of BET/WIN/LOSS/REFUND/ROLLBACK; state machine; payload hash; error mapping; failure classification; backoff; cursor; the replay-race regression |
| `test/integration/schema` | every constraint and trigger above, using raw SQL; reversible migration |
| `test/integration/api` | all endpoints, status mapping, replay/conflict, pagination, reconciliation, atomicity (a failing outbox rolls back transaction + balance + ledger), security headers, body limit |
| `test/integration/messaging` | consumer + inbox redelivery, DLQ reasons, transient retry then DLQ, graceful shutdown, 3 concurrent outbox publishers (each event exactly once), publish retry, lease expiry after a crash, events on SQS, pending reference resolution and expiry |
| `test/integration/auth` | OIDC validation paths and configuration guard rails |
| `test/concurrency/wallet-race` | 50 identical parallel requests produce one debit; the mandatory 100.00 / 2 × 80.00 scenario (25 rounds, with parallel retries); a hot wallet under mixed load; 20 wallets in parallel. Requests are spread over 3 app instances |
| `test/concurrency/processes` | **real OS processes** running `src/main.ts`: 3 instances sharing HTTP and SQS load; a worker killed after commit and before ack; a publisher killed after claiming; an instance killed and restarted under load |

The API, messaging and concurrency suites end with `assertFinancialInvariants` (the schema suite writes inconsistent rows on purpose, so it does not):
- `wallet.balance == balance rebuilt from the ledger` for every wallet;
- every processed balance-moving transaction has exactly one ledger entry, and every other transaction has none;
- no balance is negative.

## 17. Load test

Run `bun run test:load` with the compose stack up (`scripts/load-test.ts`).

**Methodology.**
- **Setup.** The script creates 200 wallets plus one "hot" wallet, each with 1,000,000.00 BRL, so no bet is rejected for lack of funds. Every request goes through the full write path.
- **Load.** 32 closed-loop clients send requests back to back for the configured duration (no think time).
- **Traffic mix** (per request):
  - 10% exact replays of an earlier request (idempotency path);
  - `HOT_SHARE` (20% or 0%) bets on the hot wallet (lock contention);
  - the rest: bets on a random wallet from the pool.
- **Client-side measurements.** Latency of every request (p50/p95/p99/max), throughput, status distribution, and error rate (anything other than 200/202/422).
- **Server-side measurements** (Prometheus diff before/after the run):
  - duplicates detected;
  - lock conflicts (`wallet_lock_conflicts_total`: lock timeouts, deadlocks, serialization failures);
  - average wallet lock wait.
- **After the load stops**, the script follows the outbox until it is empty: events pending, age of the oldest one, and time to drain (it gives up after 3 minutes and reports `null`).
- **Final check.** Every wallet's stored balance is compared with the balance rebuilt from its ledger.

**Environment.** One Windows 10 laptop running everything:
- Docker Desktop VM: 8 vCPU, 5.7 GB, shared with unrelated containers from other projects;
- 1 `api` + 2 `worker` containers;
- PostgreSQL 17.6 and LocalStack 4.4 in containers;
- the load generator itself (Bun) on the same host.

**Results.** Every run is listed, including the bad ones.

| Run | Scenario | Duration | Throughput | p50 | p95 | p99 | Errors | Lock conflicts | Avg lock wait | Outbox at stop → drained in | Balance ≠ ledger |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 20% hot | 30 s | 121.8 req/s | 150 ms | 1062 ms | 1539 ms | 0 % | n/a¹ | 127 ms | n/a² | 0 wallets |
| 2 | no hot | 30 s | 143.7 req/s | 216 ms | 358 ms | 444 ms | 0 % | n/a¹ | 15 ms | n/a² | 0 wallets |
| 3 | 20% hot | 60 s | 78.1 req/s | 208 ms | 1579 ms | 2820 ms | 0 % | 0 | 208 ms | n/a² | 0 wallets |
| 4 | no hot | 60 s | 93.9 req/s | 303 ms | 666 ms | 1349 ms | 0 % | 0 | 22 ms | n/a² | 0 wallets |
| 5 | 20% hot | 60 s | 74.4 req/s | 171 ms | 1454 ms | 6270 ms | 0.26 % (12 × 503) | 12 | 192 ms | 2884 events, oldest 23 s → 13.1 s | 0 wallets |
| 6 | no hot | 60 s | 67.6 req/s | 247 ms | 1025 ms | 8973 ms | 0.02 % (1 × 503) | 1 | 87 ms | 2933 events, oldest 26 s → 13.7 s | 0 wallets |

¹ In runs 1–2 the lock-conflict counter was not wired to the code yet, so those runs measured nothing; I do not count that as "0".
² The first version of the script measured outbox drain wrongly: it stopped sampling after 10 s and reported 9.5 s even when the outbox was not empty. Fixed before runs 5–6.

**Analysis.**
- **Correctness held in every run.** 0 wallets with a balance/ledger mismatch, no duplicate effects. Duplicates detected were about 10% of requests each time, which matches the replay share of the traffic mix.
- **The hot wallet sets the tail.** With 20% of traffic on one row, average lock wait goes up about tenfold (≈200 ms against ≈20 ms) and p95 roughly doubles. That row is processed one operation at a time on purpose (section 4).
- **The 503s in runs 5–6 come from a disk stall, not from contention in the code.**
  - All 12 lock timeouts of run 5 were logged by PostgreSQL in the same millisecond (`16:00:27.774`), 14 s after a timed checkpoint started (`16:00:13`). Conflicts caused by contention would spread over the run, not arrive all at once.
  - The most likely reading: while the checkpoint was writing to the Docker Desktop virtual disk, the transaction holding the hot wallet's lock stalled at commit, and everything queued behind it hit the 5 s `lock_timeout`.
  - The system did what it is designed to do: retryable `503` + `Retry-After`, nothing written, invariants intact.
  - On a real server one would tune `max_wal_size` / `checkpoint_completion_target` and use proper storage. Turning off `fsync` or `synchronous_commit` is not an option for money.
- **The outbox does not keep up with this rate.** About 2,900 events were pending when the load stopped, and draining them took about 13 s. Each processed bet emits two events and the publisher sends them one SQS call at a time. This is the clearest bottleneck these tests found; `SendMessageBatch` (10 per call) is the first fix.
- **The numbers are noisy.** Throughput for the same scenario ranged from 74 to 122 req/s between runs. Run-to-run variance on this machine (other containers, Windows host, the load generator on the same CPUs) is larger than most differences one might want to read into the table.
- **Read these as a functional stress test with honest measurements, not as a capacity benchmark.** A meaningful capacity number needs dedicated hardware, a separate load generator, a real SQS, and several API replicas.

## 18. Limitations and next steps

- **Outbox throughput.** Publishing one event per call; batch it (`SendMessageBatch`) and run more publishers.
- **Hot wallets.** Serialized by design. If one wallet must take thousands of operations per second, the next step is per-wallet partitioning of the queue consumers or a balance-reservation model, not weaker locking.
- **Global event ordering.** Not provided across aggregates; `walletVersion` gives per-wallet order.
- **Keycloak.** Documented but not shipped in compose.
- **No rate limiting in the service.** It belongs at the gateway, because per-instance in-memory limits are inaccurate with many replicas.
- **Inbox and outbox retention.** Both tables grow forever. In production, add retention jobs (e.g. delete published outbox rows and inbox rows older than N days; partition by month).
- **Single currency in practice.** The model is multi-currency (separate wallets per currency, conflicts tested), but there is no FX.
- **`FAILED`** is modelled and enforced by the schema, but no current path produces it: transient errors are retried and permanent ones are refused before persistence. It is reserved for a future operator or backstop flow.
