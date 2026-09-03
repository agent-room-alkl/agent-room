import { MAX_MESSAGES_PER_ROOM, ROOM_TTL_SECONDS } from '@agent-room/shared';
import type { Message, Room, RoomReport, TaskBoard } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import type { LeaseEventInput, LeaseMembershipPrecondition, RoomPersistence, RoomReceipt } from './types.js';
import { canonicalJson } from './json.js';

const roomKey = (code: string): string => `room:${code}`;
const messagesKey = (code: string): string => `room-msgs:${code}`;
const messageCountKey = (code: string): string => `room-msg-count:${code}`;
const taskBoardKey = (code: string): string => `task-board:${code}`;
const minutesKey = (code: string, reportId: string): string => `room-minutes:${code}:${reportId}`;
const receiptIdsKey = (code: string): string => `room-receipt-ids:${code}`;
const receiptsKey = (code: string): string => `room-receipts:${code}`;

const ROOM_CAS_SCRIPT = [
  "local raw = redis.call('GET', KEYS[1])",
  'if not raw then return 0 end',
  'local current = cjson.decode(raw)',
  'if tonumber(current.version) ~= tonumber(ARGV[1]) then return 0 end',
  "redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')",
  'return 1',
].join('\n');

const BOARD_CAS_SCRIPT = [
  "local raw = redis.call('GET', KEYS[1])",
  "if ARGV[1] == 'absent' then",
  '  if raw then return 0 end',
  'else',
  '  if not raw then return 0 end',
  '  local current = cjson.decode(raw)',
  '  if tonumber(current.version) ~= tonumber(ARGV[2]) then return 0 end',
  'end',
  "redis.call('SET', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[4]))",
  'return 1',
].join('\n');

const BOARD_AND_LEASE_EVENTS_CAS_SCRIPT = [
  'if tonumber(ARGV[6]) >= 0 then',
  "  local room_raw = redis.call('GET', KEYS[4])",
  '  if not room_raw then return 0 end',
  '  local room = cjson.decode(room_raw)',
  '  if room.status ~= "active" or tonumber(room.version) ~= tonumber(ARGV[6]) then return 0 end',
  '  local required_members = cjson.decode(ARGV[7])',
  '  for _, required in ipairs(required_members) do',
  '    local found = false',
  '    for _, participant in ipairs(room.participants or {}) do',
  '      local identity = participant.authenticatedIdentity',
  '      if identity and identity.cardFingerprint == required.memberId and participant.name == required.name and participant.client == required.client then found = true break end',
  '    end',
  '    if not found then return 0 end',
  '  end',
  'end',
  "local raw = redis.call('GET', KEYS[1])",
  "if ARGV[1] == 'absent' then",
  '  if raw then return 0 end',
  'else',
  '  if not raw then return 0 end',
  '  local current = cjson.decode(raw)',
  '  if tonumber(current.version) ~= tonumber(ARGV[2]) then return 0 end',
  'end',
  'local event_count = tonumber(ARGV[5])',
  'for i = 1, event_count do',
  '  local id_index = 8 + ((i - 1) * 2)',
  "  if redis.call('SISMEMBER', KEYS[2], ARGV[id_index]) == 1 then return redis.error_reply('lease event id collision') end",
  'end',
  "redis.call('SET', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[4]))",
  'for i = 1, event_count do',
  '  local id_index = 8 + ((i - 1) * 2)',
  '  redis.call(\'SADD\', KEYS[2], ARGV[id_index])',
  '  redis.call(\'RPUSH\', KEYS[3], ARGV[id_index + 1])',
  'end',
  "redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))",
  "redis.call('EXPIRE', KEYS[3], tonumber(ARGV[4]))",
  'return 1',
].join('\n');

const RECEIPT_SCRIPT = [
  "if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then",
  "  local rows = redis.call('LRANGE', KEYS[2], 0, -1)",
  '  for _, row in ipairs(rows) do',
  '    local decoded = cjson.decode(row)',
  '    if decoded.id == ARGV[1] then',
  "      if row == ARGV[2] then return 0 end",
  "      return redis.error_reply('Receipt id collision: ' .. ARGV[1])",
  '    end',
  '  end',
  "  return redis.error_reply('Receipt id collision with missing payload: ' .. ARGV[1])",
  'end',
  "redis.call('SADD', KEYS[1], ARGV[1])",
  "redis.call('RPUSH', KEYS[2], ARGV[2])",
  "redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[3]))",
  "redis.call('EXPIREAT', KEYS[2], tonumber(ARGV[3]))",
  'return 1',
].join('\n');

const MINUTES_SCRIPT = [
  "local raw = redis.call('GET', KEYS[1])",
  'if raw then',
  '  if raw == ARGV[1] then return 0 end',
  "  return redis.error_reply('Minutes id collision: ' .. ARGV[2])",
  'end',
  "redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))",
  'return 1',
].join('\n');

function parseJson<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  return JSON.parse(String(raw)) as T;
}

export class RedisRoomPersistence implements RoomPersistence {
  readonly kind = 'redis' as const;

  constructor(private readonly client: UpstashClient) {}

  async createRoom(room: Room): Promise<void> {
    await this.client.command(['SET', roomKey(room.code), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS]);
  }

  async getRoom(code: string): Promise<Room | null> {
    return parseJson<Room>(await this.client.command(['GET', roomKey(code)]));
  }

  async compareAndSwapRoom(code: string, expectedVersion: number, next: Room): Promise<boolean> {
    const result = await this.client.command<number>([
      'EVAL', ROOM_CAS_SCRIPT, '1', roomKey(code), String(expectedVersion), JSON.stringify(next),
    ]);
    return Number(result) === 1;
  }

  async appendMessage(code: string, message: Message): Promise<number> {
    const room = await this.getRoom(code);
    if (!room) throw new Error(`Room ${code} not found`);
    const expiresAt = Math.floor(room.createdAt / 1000) + ROOM_TTL_SECONDS;
    const safe = typeof message.text === 'string' ? message : { ...message, text: '' };
    const result = await this.client.pipeline<unknown>([
      ['RPUSH', messagesKey(code), JSON.stringify(safe)],
      ['INCR', messageCountKey(code)],
      ['LTRIM', messagesKey(code), -MAX_MESSAGES_PER_ROOM, -1],
      ['EXPIREAT', messagesKey(code), expiresAt],
      ['EXPIREAT', messageCountKey(code), expiresAt],
    ]);
    return Number(result[1]);
  }

  async listMessages(code: string, fromSequence: number): Promise<Message[]> {
    const metadata = await this.client.pipeline<unknown>([
      ['GET', messageCountKey(code)],
      ['LLEN', messagesKey(code)],
    ]);
    const total = metadata[0] === null || metadata[0] === undefined ? null : Number(metadata[0]);
    const length = Number(metadata[1] ?? 0);
    if (length === 0) return [];
    const trimmed = total === null ? 0 : total - length;
    const start = Math.max(0, fromSequence - trimmed);
    if (start >= length) return [];
    const rows = await this.client.command<string[]>(['LRANGE', messagesKey(code), start, -1]);
    return rows.map(row => {
      const message = JSON.parse(row) as Message;
      return typeof message.text === 'string' ? message : { ...message, text: '' };
    });
  }

  async getTaskBoard(code: string): Promise<TaskBoard | null> {
    return parseJson<TaskBoard>(await this.client.command(['GET', taskBoardKey(code)]));
  }

  async compareAndSwapTaskBoard(
    code: string,
    expectedVersion: number | null,
    next: TaskBoard,
  ): Promise<boolean> {
    const result = await this.client.command<number>([
      'EVAL', BOARD_CAS_SCRIPT, '1', taskBoardKey(code),
      expectedVersion === null ? 'absent' : 'present',
      expectedVersion === null ? '' : String(expectedVersion),
      JSON.stringify(next), String(ROOM_TTL_SECONDS),
    ]);
    return Number(result) === 1;
  }

  async compareAndSwapTaskBoardWithLeaseEvents(
    code: string,
    expectedVersion: number | null,
    next: TaskBoard,
    events: readonly LeaseEventInput[],
    membership?: LeaseMembershipPrecondition,
  ): Promise<boolean> {
    const receipts: RoomReceipt[] = events.map(event => ({
      id: event.id, roomCode: event.roomCode, kind: 'lease_event', createdAt: event.at,
      leaseEvent: event.event,
      payload: { actor: event.actor, leaseId: event.leaseId, ...(event.details ?? {}) },
    }));
    const result = await this.client.command<number>([
      'EVAL', BOARD_AND_LEASE_EVENTS_CAS_SCRIPT, '4', taskBoardKey(code),
      receiptIdsKey(code), receiptsKey(code), roomKey(code),
      expectedVersion === null ? 'absent' : 'present',
      expectedVersion === null ? '' : String(expectedVersion),
      JSON.stringify(next), String(ROOM_TTL_SECONDS), String(receipts.length),
      String(membership?.roomVersion ?? -1), JSON.stringify(membership?.members ?? []),
      ...receipts.flatMap(receipt => [receipt.id, JSON.stringify(receipt)]),
    ]);
    return Number(result) === 1;
  }

  async putMinutes(code: string, reportId: string, report: RoomReport): Promise<void> {
    await this.client.command([
      'EVAL', MINUTES_SCRIPT, '1', minutesKey(code, reportId), canonicalJson(report),
      reportId, String(ROOM_TTL_SECONDS),
    ]);
  }

  async getMinutes(code: string, reportId: string): Promise<RoomReport | null> {
    return parseJson<RoomReport>(await this.client.command(['GET', minutesKey(code, reportId)]));
  }

  async appendReceipt(receipt: RoomReceipt): Promise<boolean> {
    const room = await this.getRoom(receipt.roomCode);
    if (!room) throw new Error(`Room ${receipt.roomCode} not found`);
    const expiresAt = Math.floor(room.createdAt / 1000) + ROOM_TTL_SECONDS;
    const result = await this.client.command<number>([
      'EVAL', RECEIPT_SCRIPT, '2', receiptIdsKey(receipt.roomCode), receiptsKey(receipt.roomCode),
      receipt.id, canonicalJson(receipt), String(expiresAt),
    ]);
    return Number(result) === 1;
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
    const rows = await this.client.command<string[] | null>(['LRANGE', receiptsKey(code), 0, -1]);
    return (rows ?? []).map(row => JSON.parse(row) as RoomReceipt);
  }

  async close(): Promise<void> {}
}
