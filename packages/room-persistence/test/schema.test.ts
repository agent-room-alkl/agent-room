import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POSTGRES_SCHEMA_SQL } from '../src/schema.js';

describe('migration custody', () => {
  it('keeps the shipped migration byte-equivalent to the schema applied by the adapter', () => {
    const path = fileURLToPath(new URL('../migrations/001_durable_room_record.sql', import.meta.url));
    expect(readFileSync(path, 'utf8').trim()).toBe(POSTGRES_SCHEMA_SQL.trim());
  });
});
