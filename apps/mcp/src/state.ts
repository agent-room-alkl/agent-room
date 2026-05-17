import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { detectHarness } from './harness.js';

const STATE_DIR = process.env.AGENT_ROOM_STATE_DIR || join(homedir(), '.agent-room');

// Scope state per Claude Code session. The MCP server and the hook command are
// both spawned directly by Claude Code, so they share a parent PID. Two parallel
// sessions on the same machine end up with distinct files — without this, the
// later writer's `name` would clobber the earlier one's, and each session's
// hook would filter the *other* agent's messages as "own" by mistake.
//
// Override with AGENT_ROOM_STATE_FILE to share state across sessions on purpose
// (e.g. integration tests).
const STATE_FILE =
  process.env.AGENT_ROOM_STATE_FILE ||
  join(STATE_DIR, `state-${process.ppid ?? process.pid}.json`);

function currentHarnessStateFile(): string | null {
  if (process.env.AGENT_ROOM_STATE_FILE) return null;
  const kind = detectHarness().kind;
  if (kind !== 'cursor' && kind !== 'codex') return null;
  return join(STATE_DIR, `state-harness-${kind}.json`);
}

export interface RoomState {
  name: string;
  cursor: number;
  joinedAt: number;
  lastSentAt?: number;
  // Stored when this MCP session is the host of the room (room_create).
  // Required to claim the host display name on rejoin / reconnect; without
  // it, joinRoom rejects with HostNameTakenError. Plain text on disk under
  // ~/.agent-room/ — same trust level as the MCP state itself.
  hostKey?: string;
}

export interface AgentRoomState {
  version: 1;
  rooms: Record<string, RoomState>;
  // Number of consecutive Stop-hook blocks since the last UserPromptSubmit.
  // Used to cap autonomous chat back-and-forth so it can't loop forever
  // without the user typing.
  blockStreak?: number;
}

const EMPTY: AgentRoomState = { version: 1, rooms: {}, blockStreak: 0 };

function cloneEmpty(): AgentRoomState {
  return { ...EMPTY, rooms: {} };
}

function isValidState(parsed: AgentRoomState): boolean {
  return parsed.version === 1 && typeof parsed.rooms === 'object' && parsed.rooms !== null;
}

async function readStateFile(file: string): Promise<AgentRoomState> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as AgentRoomState;
    if (!isValidState(parsed)) return cloneEmpty();
    return parsed;
  } catch {
    return cloneEmpty();
  }
}

export async function readState(): Promise<AgentRoomState> {
  return readStateFile(STATE_FILE);
}

export function mergeStates(states: AgentRoomState[]): AgentRoomState {
  const merged = cloneEmpty();

  for (const state of states) {
    merged.blockStreak = Math.max(merged.blockStreak ?? 0, state.blockStreak ?? 0);

    for (const [code, room] of Object.entries(state.rooms)) {
      const existing = merged.rooms[code];
      if (!existing) {
        merged.rooms[code] = { ...room };
        continue;
      }

      const newest = room.joinedAt >= existing.joinedAt ? room : existing;
      merged.rooms[code] = {
        ...newest,
        cursor: Math.max(existing.cursor, room.cursor),
        joinedAt: newest.joinedAt,
        lastSentAt: Math.max(existing.lastSentAt ?? 0, room.lastSentAt ?? 0) || undefined,
        hostKey: newest.hostKey ?? existing.hostKey,
      };
    }
  }

  return merged;
}

async function listStateFiles(): Promise<string[]> {
  if (process.env.AGENT_ROOM_STATE_FILE) return [STATE_FILE];

  let files: string[] = [];
  try {
    const entries = await fs.readdir(STATE_DIR);
    files = entries
      .filter((name) => /^state-(?:\d+|harness-[a-z-]+)\.json$/.test(name))
      .map((name) => join(STATE_DIR, name));
  } catch {
    files = [];
  }

  return Array.from(new Set([...files, STATE_FILE, currentHarnessStateFile()].filter(Boolean) as string[]));
}

export async function readMergedState(): Promise<AgentRoomState> {
  const files = await listStateFiles();
  const states = await Promise.all(files.map(readStateFile));
  return mergeStates(states);
}

export async function readRoomStateForJoin(code: string, desiredName: string): Promise<RoomState | undefined> {
  const current = (await readState()).rooms[code];
  if (current) return current;

  const files = await listStateFiles();
  const states = await Promise.all(files.map(readStateFile));
  return states
    .map((state) => state.rooms[code])
    .filter((room): room is RoomState => Boolean(room && room.name === desiredName))
    .sort((a, b) => b.joinedAt - a.joinedAt)[0];
}

export async function readHarnessStateOrMerged(): Promise<AgentRoomState> {
  const harnessFile = currentHarnessStateFile();
  if (harnessFile) {
    const harnessState = await readStateFile(harnessFile);
    if (Object.keys(harnessState.rooms).length > 0) return harnessState;
  }
  return readMergedState();
}

async function writeStateFile(file: string, state: AgentRoomState): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function writeState(state: AgentRoomState): Promise<void> {
  await writeStateFile(STATE_FILE, state);
  const harnessFile = currentHarnessStateFile();
  if (harnessFile) await writeStateFile(harnessFile, state);
}

export async function setRoom(code: string, room: RoomState): Promise<void> {
  const state = await readState();
  state.rooms[code] = room;
  await writeState(state);
}

export async function removeRoom(code: string): Promise<void> {
  const state = await readState();
  if (code in state.rooms) {
    delete state.rooms[code];
    await writeState(state);
  }
}

export async function updateCursor(code: string, cursor: number): Promise<void> {
  const state = await readState();
  const room = state.rooms[code];
  if (!room) return;
  if (cursor <= room.cursor) return;
  room.cursor = cursor;
  await writeState(state);
}

export async function updateCursorEverywhere(code: string, cursor: number): Promise<void> {
  const files = await listStateFiles();
  await Promise.all(files.map(async (file) => {
    const state = await readStateFile(file);
    const room = state.rooms[code];
    if (!room || cursor <= room.cursor) return;
    room.cursor = cursor;
    await writeStateFile(file, state);
  }));
}

export async function markSent(code: string, at: number): Promise<void> {
  const state = await readState();
  const room = state.rooms[code];
  if (!room) return;
  room.lastSentAt = at;
  await writeState(state);
}

export async function bumpBlockStreak(): Promise<number> {
  const state = await readState();
  state.blockStreak = (state.blockStreak ?? 0) + 1;
  await writeState(state);
  return state.blockStreak;
}

export async function bumpBlockStreakEverywhere(): Promise<number> {
  const next = ((await readMergedState()).blockStreak ?? 0) + 1;
  const files = await listStateFiles();
  await Promise.all(files.map(async (file) => {
    const state = await readStateFile(file);
    state.blockStreak = next;
    await writeStateFile(file, state);
  }));
  return next;
}

export async function resetBlockStreak(): Promise<void> {
  const state = await readState();
  if (!state.blockStreak) return;
  state.blockStreak = 0;
  await writeState(state);
}

export async function resetBlockStreakEverywhere(): Promise<void> {
  const files = await listStateFiles();
  await Promise.all(files.map(async (file) => {
    const state = await readStateFile(file);
    if (!state.blockStreak) return;
    state.blockStreak = 0;
    await writeStateFile(file, state);
  }));
}

export async function removeRoomEverywhere(code: string): Promise<void> {
  const files = await listStateFiles();
  await Promise.all(files.map(async (file) => {
    const state = await readStateFile(file);
    if (!(code in state.rooms)) return;
    delete state.rooms[code];
    await writeStateFile(file, state);
  }));
}
