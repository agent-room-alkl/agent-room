import { applyPostgresMigrations } from './postgres.js';

const connectionString = process.env.DATABASE_URL ?? process.env.TEST_POSTGRES_URL;
if (!connectionString?.trim()) {
  throw new Error('DATABASE_URL or TEST_POSTGRES_URL is required for the explicit Postgres migration command.');
}

await applyPostgresMigrations({ connectionString });
process.stdout.write('agent-room Postgres schema migrated to version 1\n');
