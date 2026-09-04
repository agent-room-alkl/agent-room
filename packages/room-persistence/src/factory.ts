import { createClient, type UpstashClient } from '@agent-room/upstash-client';
import type { Pool } from 'pg';
import { PostgresRoomPersistence } from './postgres.js';
import { RedisRoomPersistence } from './redis.js';
import {
  PersistenceConfigurationError,
  type PersistenceKind,
  type RoomPersistence,
} from './types.js';

export interface PersistenceEnvironment {
  AGENT_ROOM_PERSISTENCE?: string;
  DATABASE_URL?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}

export interface PersistenceDependencies {
  redisClient?: UpstashClient;
  postgresPool?: Pool;
}

export function persistenceKind(env: PersistenceEnvironment): PersistenceKind {
  const selected = env.AGENT_ROOM_PERSISTENCE?.trim().toLowerCase() || 'redis';
  if (selected !== 'redis' && selected !== 'postgres') {
    throw new PersistenceConfigurationError(
      `AGENT_ROOM_PERSISTENCE must be redis or postgres, got ${JSON.stringify(selected)}`,
    );
  }
  return selected;
}

export async function createRoomPersistence(
  env: PersistenceEnvironment,
  dependencies: PersistenceDependencies = {},
): Promise<RoomPersistence> {
  const kind = persistenceKind(env);
  if (kind === 'redis') {
    const client = dependencies.redisClient ?? redisClientFromEnvironment(env);
    return new RedisRoomPersistence(client);
  }

  if (dependencies.postgresPool) {
    return PostgresRoomPersistence.fromPool(dependencies.postgresPool);
  }
  if (!env.DATABASE_URL?.trim()) {
    throw new PersistenceConfigurationError(
      'DATABASE_URL is required when AGENT_ROOM_PERSISTENCE=postgres',
    );
  }
  return PostgresRoomPersistence.connect({ connectionString: env.DATABASE_URL });
}

function redisClientFromEnvironment(env: PersistenceEnvironment): UpstashClient {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) {
    throw new PersistenceConfigurationError(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for Redis persistence',
    );
  }
  return createClient({ url, token });
}
