import { readRoomStateForCredentials, readState, type AgentRoomState } from './state.js';
import { detectHarness } from './harness.js';
import type { RoomCredentials } from './roomApi.js';

/** Room capabilities recorded in a state snapshot (whichever scope produced it). */
export function credentialsFromState(state: AgentRoomState, code: string): RoomCredentials | undefined {
  const room = state.rooms[code];
  if (!room || (!room.accessToken && !room.participantToken)) return undefined;
  return {
    ...(room.accessToken ? { accessToken: room.accessToken } : {}),
    ...(room.participantToken ? { participantToken: room.participantToken } : {}),
  };
}

/** Room capabilities persisted by earlier joins in this process's PPID-scoped state file. */
export async function stateCredentialLoader(code: string): Promise<RoomCredentials | undefined> {
  return credentialsFromState(await readState(), code);
}

/**
 * Loader for the tool server. Cursor and Codex respawn the MCP server under a
 * new wrapper PPID, so the PPID-scoped file is empty after a restart while
 * the harness-scoped file still holds the joins; those harnesses read the
 * stable harness state (same scope rule the Stop hook applies). Every other
 * client keeps PPID-scoped state so parallel sessions stay isolated.
 */
export async function toolCredentialLoader(code: string, env: NodeJS.ProcessEnv = process.env): Promise<RoomCredentials | undefined> {
  const kind = detectHarness(env).kind;
  if (kind === 'cursor' || kind === 'codex') {
    const room = await readRoomStateForCredentials(code);
    return room ? credentialsFromState({ version: 1, rooms: { [code]: room } }, code) : undefined;
  }
  return credentialsFromState(await readState(), code);
}
