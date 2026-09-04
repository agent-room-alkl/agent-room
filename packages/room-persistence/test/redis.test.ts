import { describe, expect, it } from 'vitest';
import { ROOM_TTL_SECONDS, type Message, type Room, type RoomReport } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import { RoomRecordServer } from '../src/server.js';
import { RedisRoomPersistence } from '../src/redis.js';
import type { RoomReceipt } from '../src/types.js';
import { proveImmutableRecordParity } from './parity-contract.js';

class RecordingRedis implements UpstashClient {
  readonly commands: Array<readonly (string | number)[]> = [];
  readonly pipelines: Array<readonly (readonly (string | number)[])[]> = [];
  private readonly values = new Map<string, string>();

  async command<T>(command: readonly (string | number)[]): Promise<T> {
    this.commands.push(command);
    const [name, key, value] = command;
    if (name === 'SET') {
      this.values.set(String(key), String(value));
      return 'OK' as T;
    }
    if (name === 'GET') return (this.values.get(String(key)) ?? null) as T;
    if (name === 'LRANGE') return [] as T;
    throw new Error(`Unsupported fake command ${String(name)}`);
  }

  async pipeline<T>(commands: readonly (readonly (string | number)[])[]): Promise<T[]> {
    this.pipelines.push(commands);
    return commands.map((command, index) => {
      if (command[0] === 'INCR') return 1 as T;
      if (command[0] === 'LLEN') return 0 as T;
      if (command[0] === 'GET') return null as T;
      return (index + 1) as T;
    });
  }
}

class ExpiringRedis implements UpstashClient {
  private nowSeconds = 1_700_000_000;
  private readonly values = new Map<string, string>();
  private readonly expiries = new Map<string, number>();

  advance(seconds: number): void { this.nowSeconds += seconds; }

  async command<T>(command: readonly (string | number)[]): Promise<T> {
    const [name, rawKey, rawValue] = command;
    const key = String(rawKey);
    if (name === 'SET') {
      this.values.set(key, String(rawValue));
      const exIndex = command.indexOf('EX');
      if (exIndex >= 0) this.expiries.set(key, this.nowSeconds + Number(command[exIndex + 1]));
      return 'OK' as T;
    }
    if (name === 'GET') {
      if ((this.expiries.get(key) ?? Infinity) <= this.nowSeconds) {
        this.values.delete(key);
        this.expiries.delete(key);
      }
      return (this.values.get(key) ?? null) as T;
    }
    throw new Error(`Unsupported fake command ${String(name)}`);
  }

  async pipeline<T>(_commands: readonly (readonly (string | number)[])[]): Promise<T[]> {
    return [];
  }
}

class StatefulRedis implements UpstashClient {
  private readonly values = new Map<string, string>();
  private readonly receiptIds = new Set<string>();
  private readonly lists = new Map<string, string[]>();

  async command<T>(command: readonly (string | number)[]): Promise<T> {
    const [name, rawKey] = command;
    const key = String(rawKey);
    if (name === 'SET') {
      this.values.set(key, String(command[2]));
      return 'OK' as T;
    }
    if (name === 'GET') return (this.values.get(key) ?? null) as T;
    if (name === 'LRANGE') return (this.lists.get(key) ?? []) as T;
    if (name === 'EVAL') {
      const script = String(command[1]);
      if (script.includes('Minutes id collision')) {
        const minutesKey = String(command[3]);
        const payload = String(command[4]);
        const reportId = String(command[5]);
        const existing = this.values.get(minutesKey);
        if (existing === payload) return 0 as T;
        if (existing !== undefined) throw new Error(`Minutes id collision: ${reportId}`);
        this.values.set(minutesKey, payload);
        return 1 as T;
      }
      if (script.includes('Receipt id collision')) {
        const idsKey = String(command[3]);
        const listKey = String(command[4]);
        const id = String(command[5]);
        const payload = String(command[6]);
        const compositeId = `${idsKey}:${id}`;
        if (this.receiptIds.has(compositeId)) {
          const existing = (this.lists.get(listKey) ?? []).find(row => JSON.parse(row).id === id);
          if (existing === payload) return 0 as T;
          throw new Error(`Receipt id collision: ${id}`);
        }
        this.receiptIds.add(compositeId);
        this.lists.set(listKey, [...(this.lists.get(listKey) ?? []), payload]);
        return 1 as T;
      }
    }
    throw new Error(`Unsupported fake command ${String(name)}`);
  }

  async pipeline<T>(_commands: readonly (readonly (string | number)[])[]): Promise<T[]> {
    return [];
  }
}

function room(): Room {
  return {
    code: 'ABC-DEF-GHJ', topic: 'Synthetic room', createdAt: 1_700_000_000_000,
    createdBy: 'Host', status: 'active', version: 1, participants: [],
  };
}

function message(): Message {
  return {
    id: 1_700_000_000_100, type: 'msg', name: 'Agent', initials: 'AG', color: '#000',
    role: 'builder', text: 'synthetic message', client: 'cc', time: 1_700_000_000_100,
  };
}

function report(): RoomReport {
  return {
    code: room().code, topic: room().topic, createdAt: room().createdAt,
    exportedAt: 1_700_000_000_300, participants: [], messageCount: 0,
    summary: 'Synthetic minutes', highlights: [], decisions: [], actionItems: [], artifacts: [], transcript: [],
  };
}

function receipt(): RoomReceipt {
  return {
    id: 'receipt-1', roomCode: room().code, kind: 'receipt',
    createdAt: 1_700_000_000_400, payload: { disposition: 'accepted' },
  };
}

describe('RedisRoomPersistence compatibility', () => {
  it('keeps Redis as the production default and the existing hard room TTL', async () => {
    const redis = new RecordingRedis();
    const server = await RoomRecordServer.fromEnvironment({}, { redisClient: redis });

    expect(server.persistence.kind).toBe('redis');
    await server.createRoom(room());

    expect(redis.commands[0]).toEqual([
      'SET', 'room:ABC-DEF-GHJ', JSON.stringify(room()), 'EX', ROOM_TTL_SECONDS,
    ]);
  });

  it('expires a production-entry Redis room after a 25-hour clock skip', async () => {
    const redis = new ExpiringRedis();
    const server = await RoomRecordServer.fromEnvironment({}, { redisClient: redis });
    await server.createRoom(room());
    expect(await server.getRoom(room().code)).toEqual(room());

    redis.advance(25 * 60 * 60);

    expect(await server.getRoom(room().code)).toBeNull();
  });

  it('uses the existing message keys, trim cap, count, and creation-anchored expiry', async () => {
    const redis = new RecordingRedis();
    const store = new RedisRoomPersistence(redis);
    await store.createRoom(room());
    await store.appendMessage(room().code, message());

    expect(redis.pipelines[0]).toEqual([
      ['RPUSH', 'room-msgs:ABC-DEF-GHJ', JSON.stringify(message())],
      ['INCR', 'room-msg-count:ABC-DEF-GHJ'],
      ['LTRIM', 'room-msgs:ABC-DEF-GHJ', -500, -1],
      ['EXPIREAT', 'room-msgs:ABC-DEF-GHJ', Math.floor(room().createdAt / 1000) + ROOM_TTL_SECONDS],
      ['EXPIREAT', 'room-msg-count:ABC-DEF-GHJ', Math.floor(room().createdAt / 1000) + ROOM_TTL_SECONDS],
    ]);
  });

  it('fails closed on an unknown adapter instead of silently changing storage', async () => {
    await expect(RoomRecordServer.fromEnvironment(
      { AGENT_ROOM_PERSISTENCE: 'mystery' },
      { redisClient: new RecordingRedis() },
    )).rejects.toThrow(/must be redis or postgres/);
  });

  it('matches the durable adapter collision contract for minutes and receipts', async () => {
    const store = new RedisRoomPersistence(new StatefulRedis());
    await proveImmutableRecordParity(store, room(), report(), receipt());
  });
});
