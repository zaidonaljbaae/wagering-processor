import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from './orm.config';

/** CLI: `bun src/infrastructure/persistence/migrate.ts up|down`. */
export async function migrate(url: string, direction: 'up' | 'down'): Promise<string[]> {
  const orm = await MikroORM.init(buildOrmConfig({ url, poolMax: 1 }));
  try {
    const migrator = orm.getMigrator();
    const executed = direction === 'up' ? await migrator.up() : await migrator.down();
    return executed.map((m) => m.name);
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url, direction)
    .then((names) => {
      console.log(JSON.stringify({ msg: `migrations ${direction}`, migrations: names }));
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(JSON.stringify({ msg: 'migration failed', error: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    });
}
