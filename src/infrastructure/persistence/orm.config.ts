import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migration20261022000000InitialSchema } from './migrations/Migration20261022000000InitialSchema';
import { Migration20261023000000LedgerIntegrity } from './migrations/Migration20261023000000LedgerIntegrity';
import { ALL_SCHEMAS } from './schemas';

export interface OrmOptions {
  url: string;
  poolMax?: number;
  statementTimeoutMs?: number;
}

export function buildOrmConfig(options: OrmOptions) {
  return defineConfig({
    driver: PostgreSqlDriver,
    clientUrl: options.url,
    entities: ALL_SCHEMAS,
    discovery: { warnWhenNoEntities: false },
    forceUtcTimezone: true,
    // Every unit of work is explicit (em.fork / em.transactional); a shared
    // global identity map would leak state between requests.
    allowGlobalContext: false,
    debug: false,
    pool: { min: 0, max: options.poolMax ?? 20 },
    driverOptions: {
      connection: { statement_timeout: options.statementTimeoutMs ?? 15_000, application_name: 'wagering-processor' },
    },
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: true,
      migrationsList: [
        { name: 'Migration20261022000000InitialSchema', class: Migration20261022000000InitialSchema },
        { name: 'Migration20261023000000LedgerIntegrity', class: Migration20261023000000LedgerIntegrity },
      ],
    },
  });
}
