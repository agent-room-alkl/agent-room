import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Message, Room, RoomReport, TaskBoard } from '@agent-room/shared';
import { Pool } from 'pg';
import { RoomRecordServer } from '../src/server.js';
import { PostgresRoomPersistence } from '../src/postgres.js';
import { PersistenceSchemaError, type RoomReceipt } from '../src/types.js';
import { proveImmutableRecordParity } from './parity-contract.js';
import { AgentCardVerifier, AuthenticatedRoomJoinServer, signAgentCard } from '../src/member-auth.js';

const databaseUrl = process.env.TEST_POSTGRES_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function room(): Room {
  return {
    code: 'PGS-TST-234', topic: 'Synthetic durable room', createdAt: 1_700_000_000_000,
    createdBy: 'Host', status: 'active', version: 1,
    participants: [{ name: 'Host', initials: 'HO', color: '#123', role: 'host', client: 'web', lastSeen: 1_700_000_000_000 }],
  };
}

function message(): Message {
  return {
    id: 1_700_000_000_100, type: 'msg', name: 'Agent', initials: 'AG', color: '#456',
    role: 'builder', text: 'durable synthetic message', client: 'cc', time: 1_700_000_000_100,
  };
}

function board(): TaskBoard {
  return { code: room().code, tasks: [], version: 1, lastProgressAt: 1_700_000_000_200 };
}

function report(): RoomReport {
  return {
    code: room().code,
    topic: room().topic,
    createdAt: room().createdAt,
    exportedAt: 1_700_000_000_300,
    participants: [],
    messageCount: 1,
    summary: 'Synthetic minutes',
    highlights: [], decisions: [], actionItems: [], artifacts: [], transcript: [message()],
  };
}

describePostgres('Postgres durable room production entry', () => {
  let first: RoomRecordServer;
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    first = await RoomRecordServer.fromEnvironment({
      AGENT_ROOM_PERSISTENCE: 'postgres', DATABASE_URL: databaseUrl,
    });
    // Synthetic CI database dedicated to this job; clearing it makes retries deterministic.
    await admin.query(`TRUNCATE agent_room_receipts, agent_room_minutes, agent_room_task_boards,
      agent_room_messages, agent_room_rooms CASCADE`);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await first?.close();
    await admin?.end();
  });

  it('refuses an unmigrated schema without mutating it at connect time', async () => {
    const schema = `unmigrated_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    try {
      await expect(PostgresRoomPersistence.connect({
        connectionString: databaseUrl,
        options: `-c search_path=${schema}`,
      })).rejects.toBeInstanceOf(PersistenceSchemaError);
      const result = await admin.query<{ relation: string | null }>(
        'SELECT to_regclass($1) AS relation',
        [`${schema}.agent_room_rooms`],
      );
      expect(result.rows[0]?.relation).toBeNull();
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it('matches the Redis immutable minutes and receipt collision contract', async () => {
    const parityRoom = { ...room(), code: 'PGS-PTY-234', topic: 'Synthetic parity room' };
    const parityReport = { ...report(), code: parityRoom.code, topic: parityRoom.topic };
    const parityReceipt: RoomReceipt = {
      id: 'parity-receipt', roomCode: parityRoom.code, kind: 'receipt',
      createdAt: 1_700_000_000_450, payload: { disposition: 'accepted' },
    };
    await proveImmutableRecordParity(first.persistence, parityRoom, parityReport, parityReceipt);
  });

  it('survives a server restart and a 25-hour clock skip with every durable record family', async () => {
    await first.createRoom(room());
    expect(await first.appendMessage(room().code, message())).toBe(1);
    expect(await first.updateTaskBoard(room().code, null, board())).toBe(true);
    await first.putMinutes(room().code, 'minutes-1', report());
    expect(await first.appendReceipt({
      id: 'receipt-1', roomCode: room().code, kind: 'receipt',
      createdAt: 1_700_000_000_400, payload: { disposition: 'accepted' },
    })).toBe(true);

    const leaseEvents = ['granted', 'renewed', 'released', 'expired', 'handoff_requested'] as const;
    for (const [index, event] of leaseEvents.entries()) {
      expect(await first.appendLeaseEvent({
        id: `lease-${index}`, roomCode: room().code, event, actor: 'Agent',
        leaseId: 'lease-synthetic', at: 1_700_000_000_500 + index,
      })).toBe(true);
    }
    await first.close();

    vi.useFakeTimers();
    vi.setSystemTime(room().createdAt + 25 * 60 * 60 * 1000);
    const restarted = await RoomRecordServer.fromEnvironment({
      AGENT_ROOM_PERSISTENCE: 'postgres', DATABASE_URL: databaseUrl,
    });
    try {
      expect(await restarted.getRoom(room().code)).toEqual(room());
      expect(await restarted.listMessages(room().code, 0)).toEqual([message()]);
      expect(await restarted.getTaskBoard(room().code)).toEqual(board());
      expect(await restarted.getMinutes(room().code, 'minutes-1')).toEqual(report());
      const receipts = await restarted.listReceipts(room().code);
      expect(receipts).toHaveLength(6);
      expect(receipts.filter(item => item.kind === 'lease_event').map(item => item.leaseEvent)).toEqual(leaseEvents);
      // Receipt retries are idempotent, not duplicate ledger rows.
      expect(await restarted.appendReceipt(receipts[0]!)).toBe(false);
      expect(await restarted.listReceipts(room().code)).toHaveLength(6);

      await expect(restarted.appendMessage(room().code, {
        ...message(), text: 'different payload reusing an id',
      })).rejects.toThrow('Message id collision');
      await expect(restarted.putMinutes(room().code, 'minutes-1', {
        ...report(), summary: 'different minutes reusing an id',
      })).rejects.toThrow('Minutes id collision');
      await expect(restarted.appendReceipt({
        ...receipts[0]!, payload: { disposition: 'different' },
      })).rejects.toThrow('Receipt id collision');

      expect(await restarted.listMessages(room().code, 0)).toEqual([message()]);
      expect(await restarted.getMinutes(room().code, 'minutes-1')).toEqual(report());
      expect(await restarted.listReceipts(room().code)).toHaveLength(6);
    } finally {
      await restarted.close();
    }
  });

  it('retains an authenticated member binding across a Postgres server restart', async () => {
    vi.useRealTimers();
    const server = await RoomRecordServer.fromEnvironment({
      AGENT_ROOM_PERSISTENCE: 'postgres', DATABASE_URL: databaseUrl,
    });
    const durableRoom: Room = {
      ...room(), code: 'PGS-AUT-MEM', version: 1, participants: [],
      acceptedMemberAuthSchemes: ['oauth2'],
    };
    const keys = generateKeyPairSync('ed25519');
    const card = {
      protocolVersion: '0.3.0', fleetId: 'fleet-ci', name: 'Builder',
      url: 'https://agent.invalid/a2a', version: '1.0.0',
      securitySchemes: { oauth2: { type: 'oauth2' } }, security: ['oauth2' as const],
    };
    await server.createRoom(durableRoom);
    const joins = new AuthenticatedRoomJoinServer(server,
      new AgentCardVerifier([{ fleetId: 'fleet-ci', keyId: 'key-ci', publicKey: keys.publicKey }]));
    const participant = await joins.join(durableRoom.code, {
      participant: { name: 'Builder', initials: 'BU', color: '#456', role: 'builder', client: 'cc' },
      scheme: 'oauth2', signedCard: signAgentCard(card, 'key-ci', keys.privateKey),
    });
    await server.close();

    const restarted = await RoomRecordServer.fromEnvironment({
      AGENT_ROOM_PERSISTENCE: 'postgres', DATABASE_URL: databaseUrl,
    });
    try {
      expect((await restarted.getRoom(durableRoom.code))?.participants).toEqual([participant]);
      expect(participant.authenticatedIdentity?.fleetId).toBe('fleet-ci');
    } finally {
      await restarted.close();
    }
  });
});
