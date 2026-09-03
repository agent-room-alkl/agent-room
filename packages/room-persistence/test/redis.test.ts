import { describe, expect, it } from 'vitest';
import { ROOM_TTL_SECONDS, type Message, type Room, type RoomReport, type TaskBoard } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import { RoomRecordServer } from '../src/server.js';
import { RedisRoomPersistence } from '../src/redis.js';
import { TaskLeaseServer, type LeaseActor } from '../src/task-leases.js';
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
    if (name === 'EVAL') return 1 as T;
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

class LeaseCasRedis implements UpstashClient {
  readonly values = new Map<string, string>();
  removeParticipant(code: string, name: string): void {
    const key = `room:${code}`;
    const current = JSON.parse(this.values.get(key)!) as Room;
    this.values.set(key, JSON.stringify({ ...current, version: current.version + 1,
      participants: current.participants.filter(item => item.name !== name) }));
  }
  async command<T>(command: readonly (string | number)[]): Promise<T> {
    const [name] = command;
    if (name === 'SET') { this.values.set(String(command[1]), String(command[2])); return 'OK' as T; }
    if (name === 'GET') return (this.values.get(String(command[1])) ?? null) as T;
    if (name === 'LRANGE') return [] as T;
    if (name === 'EVAL') {
      const script = String(command[1]);
      if (script.includes('Receipt id collision')) return 1 as T;
      if (!script.includes('lease event id collision')) throw new Error('unexpected script');
      const boardKey = String(command[3]);
      const roomKey = String(command[6]);
      const current = JSON.parse(this.values.get(boardKey)!) as TaskBoard;
      if (current.version !== Number(command[8])) return 0 as T;
      if (script.includes('required_members')) {
        const activeRoom = JSON.parse(this.values.get(roomKey)!) as Room;
        const required = JSON.parse(String(command[13])) as Array<{ memberId: string; name: string; client: string }>;
        if (activeRoom.version !== Number(command[12]) || required.some(member =>
          !activeRoom.participants.some(item => item.authenticatedIdentity?.cardFingerprint === member.memberId &&
            item.name === member.name && item.client === member.client))) return 0 as T;
      }
      this.values.set(boardKey, String(command[9]));
      return 1 as T;
    }
    throw new Error(`Unsupported lease Redis command ${String(name)}`);
  }
  async pipeline<T>(): Promise<T[]> { return []; }
}

const leaseAlice: LeaseActor = { memberId: 'redis-alice', name: 'Alice', client: 'cc' };
const leaseBob: LeaseActor = { memberId: 'redis-bob', name: 'Bob', client: 'cc' };

function leaseRoom(): Room {
  const participant = (actor: LeaseActor) => ({
    name: actor.name, role: 'builder', color: '#123', initials: actor.name.slice(0, 2), client: actor.client,
    joinedAt: 1, lastSeenAt: 1, authenticatedIdentity: { cardFingerprint: actor.memberId,
      fleetId: 'fleet', cardName: actor.name, scheme: 'oauth2' as const, keyId: 'key', verifiedAt: 1 },
  });
  return { ...room(), version: 1, participants: [participant(leaseAlice), participant(leaseBob)] };
}

function leaseBoard(): TaskBoard {
  return { code: room().code, version: 1, tasks: [{ id: 'T-REDIS', title: 'Redis race',
    state: 'in_progress', createdBy: 'Host', createdAt: 1, updatedAt: 1 }] };
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

  it('sends the board transition and lease receipts through one Redis script', async () => {
    const redis = new RecordingRedis();
    const store = new RedisRoomPersistence(redis);
    const next = { code: room().code, version: 2, tasks: [] };
    expect(await store.compareAndSwapTaskBoardWithLeaseEvents(room().code, 1, next, [{
      id: 'lease-event-1', roomCode: room().code, event: 'granted', actor: 'fingerprint',
      leaseId: 'task-lease-1', at: 10, details: { taskId: 'T-01' },
    }])).toBe(true);

    const command = redis.commands.at(-1)!;
    expect(command.slice(0, 7)).toEqual([
      'EVAL', expect.any(String), '4', `task-board:${room().code}`,
      `room-receipt-ids:${room().code}`, `room-receipts:${room().code}`, `room:${room().code}`,
    ]);
    expect(command.join(' ')).toContain('lease-event-1');
    expect(command.join(' ')).toContain('"leaseEvent":"granted"');
  });

  it.each([
    ['claim', leaseAlice.name],
    ['handoff grant', leaseBob.name],
  ] as const)('keeps Redis %s membership atomic when the member leaves at commit', async (_label, leaving) => {
    const redis = new LeaseCasRedis();
    const store = new RedisRoomPersistence(redis);
    await store.createRoom(leaseRoom());
    redis.values.set(`task-board:${room().code}`, JSON.stringify(leaseBoard()));
    const original = store.compareAndSwapTaskBoardWithLeaseEvents.bind(store);
    let armed = _label === 'claim';
    store.compareAndSwapTaskBoardWithLeaseEvents = async (...args) => {
      if (armed) { armed = false; redis.removeParticipant(room().code, leaving); }
      return original(...args);
    };
    const leases = new TaskLeaseServer(new RoomRecordServer(store), () => 100, () => 'id');
    if (_label === 'handoff grant') {
      await leases.claim(room().code, 'T-REDIS', leaseAlice);
      await leases.requestHandoff(room().code, 'T-REDIS', leaseBob);
      armed = true;
    }
    await expect(_label === 'claim'
      ? leases.claim(room().code, 'T-REDIS', leaseAlice)
      : leases.grantHandoff(room().code, 'T-REDIS', leaseAlice))
      .rejects.toMatchObject({ name: 'task_lease_authenticated_member_required' });
    expect((await store.getTaskBoard(room().code))?.tasks[0]?.lease?.holderId)
      .not.toBe(leaving === leaseAlice.name ? leaseAlice.memberId : leaseBob.memberId);
  });
});
