/**
 * Load test: `bun run test:load` against a running stack (docker compose up).
 *
 * Traffic mix (per request, chosen at random):
 *   - 10% exact replay of an earlier request (idempotency path)
 *   - HOT_SHARE (default 20%) BET of 1.00 on one "hot" wallet (lock contention)
 *   - the rest: BET of 1.00 on a random wallet from a pool (spread load)
 *
 * Reports throughput, latency percentiles, status distribution and, when
 * the metrics endpoint and database are reachable, lock wait, duplicates and
 * outbox lag. Settings via env: TARGET_URL, METRICS_URL, DATABASE_URL,
 * DURATION_SECONDS, CONCURRENCY, WALLETS, HOT_SHARE.
 */
import { SQL } from 'bun';

const target = process.env.TARGET_URL ?? 'http://localhost:3000';
const metricsUrl = process.env.METRICS_URL ?? 'http://localhost:9464/metrics';
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://wagering:wagering-local@localhost:5432/wagering';
const durationSeconds = Number(process.env.DURATION_SECONDS ?? 30);
const concurrency = Number(process.env.CONCURRENCY ?? 32);
const walletCount = Number(process.env.WALLETS ?? 200);
const hotShare = Number(process.env.HOT_SHARE ?? 0.2);

interface Wallet {
  walletId: string;
  playerId: string;
}

async function createWallet(balance: string): Promise<Wallet> {
  const playerId = crypto.randomUUID();
  const res = await fetch(`${target}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
  });
  if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status}`);
  return { walletId: ((await res.json()) as { id: string }).id, playerId };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function scrape(): Promise<Map<string, number>> {
  const values = new Map<string, number>();
  try {
    const text = await (await fetch(metricsUrl)).text();
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [key, value] = line.split(' ');
      if (key && value) values.set(key, Number(value));
    }
  } catch {
    // metrics endpoint not reachable: report what we can
  }
  return values;
}

function sum(m: Map<string, number>, prefix: string): number {
  let total = 0;
  for (const [k, v] of m) if (k.startsWith(prefix)) total += v;
  return total;
}

async function main(): Promise<void> {
  console.log(`target=${target} duration=${durationSeconds}s concurrency=${concurrency} wallets=${walletCount} hotShare=${hotShare}`);
  const wallets = await Promise.all(Array.from({ length: walletCount }, () => createWallet('1000000.00')));
  const hot = await createWallet('1000000.00');
  const before = await scrape();

  const latencies: number[] = [];
  const statuses = new Map<number | string, number>();
  const sent: Array<{ key: string; body: string }> = [];
  const deadline = Date.now() + durationSeconds * 1000;

  async function worker(): Promise<void> {
    while (Date.now() < deadline) {
      let key: string;
      let body: string;
      const roll = Math.random();
      if (roll < 0.1 && sent.length > 0) {
        ({ key, body } = sent[Math.floor(Math.random() * sent.length)]!);
      } else {
        const w = roll < 0.1 + hotShare ? hot : wallets[Math.floor(Math.random() * wallets.length)]!;
        const externalTransactionId = `load-${crypto.randomUUID()}`;
        key = `load-provider:${externalTransactionId}`;
        body = JSON.stringify({
          providerId: 'load-provider',
          externalTransactionId,
          playerId: w.playerId,
          walletId: w.walletId,
          roundId: 'load-round',
          gameId: 'load-game',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        });
        if (sent.length < 10_000) sent.push({ key, body });
      }
      const started = performance.now();
      try {
        const res = await fetch(`${target}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
          body,
        });
        await res.arrayBuffer();
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      } catch {
        statuses.set('network', (statuses.get('network') ?? 0) + 1);
      }
      latencies.push(performance.now() - started);
    }
  }

  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (performance.now() - started) / 1000;
  const after = await scrape();

  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  const ok = (statuses.get(200) ?? 0) + (statuses.get(422) ?? 0) + (statuses.get(202) ?? 0);
  const report: Record<string, unknown> = {
    requests: total,
    durationSeconds: Number(elapsed.toFixed(1)),
    throughputRps: Number((total / elapsed).toFixed(1)),
    latencyMs: {
      p50: Number(percentile(latencies, 50).toFixed(1)),
      p95: Number(percentile(latencies, 95).toFixed(1)),
      p99: Number(percentile(latencies, 99).toFixed(1)),
      max: Number((latencies.at(-1) ?? 0).toFixed(1)),
    },
    statuses: Object.fromEntries(statuses),
    errorRate: Number(((total - ok) / Math.max(1, total)).toFixed(4)),
  };

  if (after.size > 0) {
    const diff = (prefix: string) => sum(after, prefix) - sum(before, prefix);
    const lockCount = diff('wallet_lock_wait_seconds_count');
    report.serverMetrics = {
      duplicatesDetected: diff('wager_duplicates_total'),
      lockConflicts: diff('wallet_lock_conflicts_total'),
      avgLockWaitMs: lockCount > 0 ? Number(((diff('wallet_lock_wait_seconds_sum') / lockCount) * 1000).toFixed(2)) : 0,
    };
  }

  try {
    const sql = new SQL(databaseUrl, { max: 1 });
    // Follow the outbox until it is empty (or give up after 3 minutes and say so).
    const drainStarted = performance.now();
    let firstSample: { lag: number; pending: number } | undefined;
    let drainedAfterSeconds: number | null = null;
    while (performance.now() - drainStarted < 180_000) {
      const [row] = await sql`select coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as lag,
                                     count(*)::int as pending
                                from outbox_messages where published_at is null`;
      firstSample ??= row;
      if (row.pending === 0) {
        drainedAfterSeconds = Number(((performance.now() - drainStarted) / 1000).toFixed(1));
        break;
      }
      await Bun.sleep(500);
    }
    const [mismatch] = await sql`
      select count(*)::int as wallets from (
        select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
         group by w.id, w.balance_amount
        having w.balance_amount <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)) x`;
    report.outbox = {
      pendingWhenLoadStopped: firstSample?.pending ?? 0,
      oldestEventAgeSecondsWhenLoadStopped: Number((firstSample?.lag ?? 0).toFixed(2)),
      // null = still not drained after 3 minutes
      drainedAfterSeconds,
    };
    report.walletsWithBalanceLedgerMismatch = mismatch.wallets;
    await sql.close();
  } catch (err) {
    report.database = `not reachable: ${(err as Error).message}`;
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
