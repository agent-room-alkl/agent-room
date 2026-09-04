import type { Message, Room, RoomReport, TaskBoard } from '@agent-room/shared';
import { Pool, type PoolClient, type PoolConfig, type QueryResult } from 'pg';
import { POSTGRES_SCHEMA_SQL } from './schema.js';
import { PersistenceSchemaError, type LeaseEventInput, type RoomPersistence, type RoomReceipt } from './types.js';
import { sameJson } from './json.js';

const REQUIRED_SCHEMA_VERSION = 1;

function value<T>(raw: unknown): T {
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
}

function count(result: QueryResult): number {
  return result.rowCount ?? 0;
}

export class PostgresRoomPersistence implements RoomPersistence {
  readonly kind = 'postgres' as const;
  private closed = false;

  private constructor(
    private readonly pool: Pool,
    private readonly ownsPool: boolean,
  ) {}

  static async connect(config: PoolConfig): Promise<PostgresRoomPersistence> {
    const store = new PostgresRoomPersistence(new Pool(config), true);
    try {
      await store.verifySchema();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  static async fromPool(pool: Pool, verify = true): Promise<PostgresRoomPersistence> {
    const store = new PostgresRoomPersistence(pool, false);
    if (verify) await store.verifySchema();
    return store;
  }

  private async verifySchema(): Promise<void> {
    try {
      const result = await this.pool.query<{ version: number }>(
        'SELECT COALESCE(MAX(version), 0)::int AS version FROM agent_room_schema_migrations',
      );
      const version = Number(result.rows[0]?.version ?? 0);
      if (version < REQUIRED_SCHEMA_VERSION) {
        throw new PersistenceSchemaError(
          `Postgres persistence schema is behind: expected ${REQUIRED_SCHEMA_VERSION}, found ${version}`,
        );
      }
    } catch (error) {
      if (error instanceof PersistenceSchemaError) throw error;
      throw new PersistenceSchemaError(
        `Postgres persistence schema is not migrated; run the explicit migration command (${String(error)})`,
      );
    }
  }

  async createRoom(room: Room): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_room_rooms
        (code, topic, created_at, created_by, status, version, room_json, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [room.code, room.topic, room.createdAt, room.createdBy, room.status,
        room.version, JSON.stringify(room), room.createdAt],
    );
  }

  async getRoom(code: string): Promise<Room | null> {
    const result = await this.pool.query<{ room_json: unknown }>(
      'SELECT room_json FROM agent_room_rooms WHERE code = $1',
      [code],
    );
    const row = result.rows[0];
    return row ? value<Room>(row.room_json) : null;
  }

  async compareAndSwapRoom(code: string, expectedVersion: number, next: Room): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_room_rooms
          SET topic = $3, status = $4, version = $5, room_json = $6::jsonb, updated_at = $7
        WHERE code = $1 AND version = $2`,
      [code, expectedVersion, next.topic, next.status, next.version,
        JSON.stringify(next), Date.now()],
    );
    return count(result) === 1;
  }

  async appendMessage(code: string, message: Message): Promise<number> {
    return this.transaction(async client => {
      const room = await client.query('SELECT code FROM agent_room_rooms WHERE code = $1 FOR UPDATE', [code]);
      if (!room.rows[0]) throw new Error(`Room ${code} not found`);
      const next = await client.query<{ sequence: string }>(
        `SELECT COALESCE(MAX(sequence) + 1, 0)::text AS sequence
           FROM agent_room_messages WHERE room_code = $1`,
        [code],
      );
      const sequence = Number(next.rows[0]?.sequence ?? 0);
      const result = await client.query(
        `INSERT INTO agent_room_messages
          (room_code, sequence, message_id, message_json, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (room_code, message_id) DO NOTHING`,
        [code, sequence, message.id, JSON.stringify(message), message.time],
      );
      if (count(result) === 0) {
        const existing = await client.query<{ sequence: string; message_json: unknown }>(
          `SELECT sequence::text, message_json FROM agent_room_messages
            WHERE room_code = $1 AND message_id = $2`,
          [code, message.id],
        );
        const row = existing.rows[0];
        if (!row || !sameJson(value<Message>(row.message_json), message)) {
          throw new Error(`Message id collision: ${message.id}`);
        }
        return Number(row.sequence) + 1;
      }
      return sequence + 1;
    });
  }

  async listMessages(code: string, fromSequence: number): Promise<Message[]> {
    const result = await this.pool.query<{ message_json: unknown }>(
      `SELECT message_json FROM agent_room_messages
        WHERE room_code = $1 AND sequence >= $2
        ORDER BY sequence ASC`,
      [code, fromSequence],
    );
    return result.rows.map(row => value<Message>(row.message_json));
  }

  async getTaskBoard(code: string): Promise<TaskBoard | null> {
    const result = await this.pool.query<{ board_json: unknown }>(
      'SELECT board_json FROM agent_room_task_boards WHERE room_code = $1',
      [code],
    );
    const row = result.rows[0];
    return row ? value<TaskBoard>(row.board_json) : null;
  }

  async compareAndSwapTaskBoard(
    code: string,
    expectedVersion: number | null,
    next: TaskBoard,
  ): Promise<boolean> {
    if (expectedVersion === null) {
      const inserted = await this.pool.query(
        `INSERT INTO agent_room_task_boards (room_code, version, board_json, updated_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (room_code) DO NOTHING`,
        [code, next.version, JSON.stringify(next), Date.now()],
      );
      return count(inserted) === 1;
    }
    const updated = await this.pool.query(
      `UPDATE agent_room_task_boards
          SET version = $3, board_json = $4::jsonb, updated_at = $5
        WHERE room_code = $1 AND version = $2`,
      [code, expectedVersion, next.version, JSON.stringify(next), Date.now()],
    );
    return count(updated) === 1;
  }

  async putMinutes(code: string, reportId: string, report: RoomReport): Promise<void> {
    const inserted = await this.pool.query(
      `INSERT INTO agent_room_minutes (room_code, report_id, report_json, created_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (room_code, report_id) DO NOTHING`,
      [code, reportId, JSON.stringify(report), report.exportedAt],
    );
    if (count(inserted) === 0) {
      const existing = await this.getMinutes(code, reportId);
      if (!existing || !sameJson(existing, report)) {
        throw new Error(`Minutes id collision: ${reportId}`);
      }
    }
  }

  async getMinutes(code: string, reportId: string): Promise<RoomReport | null> {
    const result = await this.pool.query<{ report_json: unknown }>(
      `SELECT report_json FROM agent_room_minutes
        WHERE room_code = $1 AND report_id = $2`,
      [code, reportId],
    );
    const row = result.rows[0];
    return row ? value<RoomReport>(row.report_json) : null;
  }

  async appendReceipt(receipt: RoomReceipt): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO agent_room_receipts
        (room_code, receipt_id, receipt_kind, lease_event, receipt_json, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (room_code, receipt_id) DO NOTHING`,
      [receipt.roomCode, receipt.id, receipt.kind, receipt.leaseEvent ?? null,
        JSON.stringify(receipt), receipt.createdAt],
    );
    if (count(result) === 1) return true;
    const existing = await this.pool.query<{ receipt_json: unknown }>(
      `SELECT receipt_json FROM agent_room_receipts
        WHERE room_code = $1 AND receipt_id = $2`,
      [receipt.roomCode, receipt.id],
    );
    const row = existing.rows[0];
    if (!row || !sameJson(value<RoomReceipt>(row.receipt_json), receipt)) {
      throw new Error(`Receipt id collision: ${receipt.id}`);
    }
    return false;
  }

  appendLeaseEvent(event: LeaseEventInput): Promise<boolean> {
    return this.appendReceipt({
      id: event.id,
      roomCode: event.roomCode,
      kind: 'lease_event',
      createdAt: event.at,
      leaseEvent: event.event,
      payload: { actor: event.actor, leaseId: event.leaseId, ...(event.details ?? {}) },
    });
  }

  async listReceipts(code: string): Promise<RoomReceipt[]> {
    const result = await this.pool.query<{ receipt_json: unknown }>(
      `SELECT receipt_json FROM agent_room_receipts
        WHERE room_code = $1 ORDER BY created_at ASC, receipt_id ASC`,
      [code],
    );
    return result.rows.map(row => value<RoomReceipt>(row.receipt_json));
  }

  async close(): Promise<void> {
    if (this.ownsPool && !this.closed) {
      this.closed = true;
      await this.pool.end();
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function applyPostgresMigrations(config: PoolConfig): Promise<void> {
  const pool = new Pool(config);
  try {
    await pool.query(POSTGRES_SCHEMA_SQL);
  } finally {
    await pool.end();
  }
}
