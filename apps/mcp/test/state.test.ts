import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { mergeStates, type AgentRoomState } from '../src/state.js';

async function makeStateDir(prefix: string) {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

function harnessFile(dir: string, kind: string, sessionId: string) {
  const scope = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return join(dir, `state-harness-${kind}-${scope}.json`);
}

async function invokeRoomEnd(code: string) {
  const handlers = new Map<unknown, (request: any) => Promise<any>>();
  const server = {
    setRequestHandler(schema: unknown, handler: (request: any) => Promise<any>) {
      handlers.set(schema, handler);
    },
  } as unknown as Server;
  const { registerTools } = await import('../src/tools.js');
  registerTools(server);
  return handlers.get(CallToolRequestSchema)!({
    params: { name: 'room_end', arguments: { code } },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('mergeStates', () => {
  it('keeps the highest cursor for rooms found in multiple PPID state files', () => {
    const older: AgentRoomState = {
      version: 1,
      blockStreak: 2,
      rooms: {
        'GBX-YXT-C3R': {
          name: 'Cursor',
          cursor: 10,
          joinedAt: 100,
        },
      },
    };
    const newer: AgentRoomState = {
      version: 1,
      blockStreak: 5,
      rooms: {
        'GBX-YXT-C3R': {
          name: 'Cursor',
          cursor: 14,
          joinedAt: 200,
          lastSentAt: 300,
        },
      },
    };

    expect(mergeStates([older, newer])).toEqual({
      version: 1,
      blockStreak: 5,
      rooms: {
        'GBX-YXT-C3R': {
          name: 'Cursor',
          cursor: 14,
          joinedAt: 200,
          lastSentAt: 300,
        },
      },
    });
  });

  it('preserves separate rooms while merging block streaks', () => {
    const first: AgentRoomState = {
      version: 1,
      blockStreak: 1,
      rooms: {
        'AAA-BBB-CCC': { name: 'Cursor', cursor: 2, joinedAt: 100 },
      },
    };
    const second: AgentRoomState = {
      version: 1,
      blockStreak: 3,
      rooms: {
        'DDD-EEE-FFF': { name: 'Cursor', cursor: 7, joinedAt: 200 },
      },
    };

    expect(mergeStates([first, second])).toEqual({
      version: 1,
      blockStreak: 3,
      rooms: {
        'AAA-BBB-CCC': { name: 'Cursor', cursor: 2, joinedAt: 100 },
        'DDD-EEE-FFF': { name: 'Cursor', cursor: 7, joinedAt: 200 },
      },
    });
  });
});

describe('state harness files', () => {
  beforeEach(() => {
    // detectHarness matches Claude Code's env vars before CODEX_RUN_ID —
    // clear them so the tests pass when the suite runs inside Claude Code.
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    vi.stubEnv('CODEX_THREAD_ID', '');
  });

  it('writes stable Codex harness state alongside the PPID-scoped state', async () => {
    const dir = await makeStateDir('agent-room-state-codex-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', 'test-run');

    const { setRoom } = await import('../src/state.js');
    await setRoom('ABC-DEF-GHJ', {
      name: 'Codex',
      cursor: 2,
      joinedAt: 123,
    });

    const files = await fs.readdir(dir);
    const filename = harnessFile(dir, 'codex', 'test-run');
    expect(files).toContain(filename.split('/').at(-1));

    const harnessRaw = await fs.readFile(filename, 'utf8');
    expect(JSON.parse(harnessRaw).rooms['ABC-DEF-GHJ']).toMatchObject({
      name: 'Codex',
      cursor: 2,
    });
  });

  it('prunes empty per-session harness files after sessions leave', async () => {
    const dir = await makeStateDir('agent-room-state-prune-harness-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);

    for (const sessionId of ['run-a', 'run-b', 'run-c']) {
      vi.stubEnv('CODEX_RUN_ID', sessionId);
      vi.resetModules();
      const stateModule = await import('../src/state.js');
      await stateModule.setRoom('ABC-DEF-GHJ', {
        name: sessionId, cursor: 0, joinedAt: 1,
      });
      await stateModule.removeRoomEverywhere('ABC-DEF-GHJ');
    }

    const files = await fs.readdir(dir);
    expect(files.filter((name) => name.startsWith('state-harness-'))).toEqual([]);
    expect(files.filter((name) => name.startsWith('state-'))).toEqual([
      `state-${process.ppid}.json`,
    ]);
  });

  it('recovers Codex state by thread id and isolates a foreign thread', async () => {
    const dir = await makeStateDir('agent-room-state-codex-thread-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_HOME', '/synthetic/codex-home');
    vi.stubEnv('CODEX_THREAD_ID', 'thread-a');
    vi.stubEnv('CODEX_RUN_ID', '');

    let stateModule = await import('../src/state.js');
    await stateModule.setRoom('ABC-DEF-GHJ', {
      name: 'Thread A Host', cursor: 4, joinedAt: 123, hostKey: 'thread-a-host-key',
    });
    expect(await fs.readFile(harnessFile(dir, 'codex', 'thread-a'), 'utf8')).toContain('thread-a-host-key');

    vi.resetModules();
    stateModule = await import('../src/state.js');
    expect(await stateModule.readRoomStateForSession('ABC-DEF-GHJ')).toMatchObject({
      name: 'Thread A Host', hostKey: 'thread-a-host-key',
    });

    await fs.rm(join(dir, `state-${process.ppid}.json`));
    vi.stubEnv('CODEX_THREAD_ID', 'thread-b');
    vi.resetModules();
    stateModule = await import('../src/state.js');
    expect(await stateModule.readRoomStateForSession('ABC-DEF-GHJ')).toBeUndefined();
  });

  it('does not recover join state from a foreign Codex session with the same name', async () => {
    const dir = await makeStateDir('agent-room-state-join-session-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', 'run-a');
    await fs.writeFile(harnessFile(dir, 'codex', 'run-a'), JSON.stringify({
      version: 1,
      rooms: { 'ABC-DEF-GHJ': {
        name: 'Same Name', cursor: 8, joinedAt: 123, hostKey: 'foreign-host-key',
      } },
    }));

    vi.stubEnv('CODEX_RUN_ID', 'run-b');
    vi.resetModules();
    const stateModule = await import('../src/state.js');
    expect(await stateModule.readRoomStateForJoin('ABC-DEF-GHJ', 'Same Name')).toBeUndefined();
  });

  it('does not treat the Cursor harness marker as a session identity', async () => {
    const dir = await makeStateDir('agent-room-state-cursor-marker-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_HOME', '');
    vi.stubEnv('CODEX_RUN_ID', '');
    vi.stubEnv('CURSOR_TRACE_ID', '');
    vi.stubEnv('CURSOR_AGENT', '1');

    let stateModule = await import('../src/state.js');
    await stateModule.setRoom('AAA-BBB-CCC', {
      name: 'Cursor A Host', cursor: 5, joinedAt: 234, hostKey: 'cursor-a-host-key',
    });
    // Model a distinct Cursor process: it has its own PPID file, but presents
    // the same boolean CURSOR_AGENT marker and no trace identifier.
    await fs.rm(join(dir, `state-${process.ppid}.json`));

    vi.resetModules();
    stateModule = await import('../src/state.js');
    await stateModule.setRoom('DDD-EEE-FFF', {
      name: 'Cursor B Host', cursor: 6, joinedAt: 345, hostKey: 'cursor-b-host-key',
    });

    const harnessFiles = (await fs.readdir(dir)).filter((name) =>
      name.startsWith('state-harness-cursor-'),
    );
    expect(harnessFiles).toHaveLength(2);

    // A later restart without a real session identifier gets a fresh scope.
    // It may recover neither process's host capability from merged state.
    await fs.rm(join(dir, `state-${process.ppid}.json`));
    vi.resetModules();
    stateModule = await import('../src/state.js');
    expect(await stateModule.readRoomStateForSession('AAA-BBB-CCC')).toBeUndefined();
    expect(await stateModule.readRoomStateForSession('DDD-EEE-FFF')).toBeUndefined();
  });

  it('never falls back to merged state for a detected harness without an id', async () => {
    const dir = await makeStateDir('agent-room-state-cursor-nonce-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_HOME', '');
    vi.stubEnv('CODEX_RUN_ID', '');
    vi.stubEnv('CURSOR_TRACE_ID', '');
    vi.stubEnv('CURSOR_AGENT', '');
    vi.stubEnv('TERM_PROGRAM', 'Cursor');
    await fs.writeFile(join(dir, 'state-111.json'), JSON.stringify({
      version: 1, rooms: { 'ABC-DEF-GHJ': {
        name: 'Foreign Host', cursor: 9, joinedAt: 999, hostKey: 'foreign-host-key',
      } },
    }));

    vi.resetModules();
    const stateModule = await import('../src/state.js');
    expect((await stateModule.readHarnessStateOrMerged()).rooms).toEqual({});
    expect(await stateModule.readRoomStateForSession('ABC-DEF-GHJ')).toBeUndefined();
  });

  it('reads Codex harness state when the hook PPID state is empty', async () => {
    const dir = await makeStateDir('agent-room-state-codex-read-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', 'test-run');

    await fs.writeFile(
      harnessFile(dir, 'codex', 'test-run'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Codex',
            cursor: 7,
            joinedAt: 456,
          },
        },
      }),
      'utf8'
    );

    const { readHarnessStateOrMerged } = await import('../src/state.js');
    const state = await readHarnessStateOrMerged();
    expect(state.rooms['ABC-DEF-GHJ']).toMatchObject({
      name: 'Codex',
      cursor: 7,
    });
  });

  it('finds a same-name prior room state after the PPID state changes', async () => {
    const dir = await makeStateDir('agent-room-state-rejoin-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_HOME', '');
    vi.stubEnv('CODEX_RUN_ID', '');
    vi.stubEnv('CURSOR_TRACE_ID', '');
    vi.stubEnv('CURSOR_AGENT', '');
    vi.stubEnv('TERM_PROGRAM', '');

    await fs.writeFile(
      join(dir, 'state-111.json'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Claude',
            cursor: 7,
            joinedAt: 456,
          },
        },
      }),
      'utf8'
    );
    await fs.writeFile(
      join(dir, 'state-222.json'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Codex',
            cursor: 12,
            joinedAt: 789,
          },
        },
      }),
      'utf8'
    );

    const { readRoomStateForJoin } = await import('../src/state.js');
    const state = await readRoomStateForJoin('ABC-DEF-GHJ', 'Claude');
    expect(state).toMatchObject({
      name: 'Claude',
      cursor: 7,
    });
  });

  it('resolves room identity fields from scoped state without crossing participants', async () => {
    const dir = await makeStateDir('agent-room-state-identity-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', 'test-run');
    const code = 'ABC-DEF-GHJ';
    await fs.writeFile(join(dir, `state-${process.ppid}.json`), JSON.stringify({
      version: 1, rooms: { [code]: { name: 'Session A', client: 'cc', cursor: 3, joinedAt: 10 } },
    }));
    await fs.writeFile(join(dir, 'state-111.json'), JSON.stringify({
      version: 1, rooms: { [code]: { name: 'Session A', client: 'cc', cursor: 9, joinedAt: 9, hostKey: 'host-a' } },
    }));
    await fs.writeFile(join(dir, 'state-222.json'), JSON.stringify({
      version: 1, rooms: { [code]: { name: 'Session B', client: 'cc', cursor: 99, joinedAt: 99, hostKey: 'host-b' } },
    }));

    vi.resetModules();
    const { readRoomStateForCredentials } = await import('../src/state.js');
    expect(await readRoomStateForCredentials(code)).toMatchObject({
      name: 'Session A', cursor: 9, hostKey: 'host-a',
    });
  });

  it('tools resolve room names and host keys through the identity-scoped reader', async () => {
    const source = await fs.readFile(join(import.meta.dirname, '../src/tools.ts'), 'utf8');
    expect(source).not.toMatch(/\breadState\s*\(/);
    expect(source.match(/readRoomStateForSession\s*\(/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('does not recover a foreign PPID host key for an ordinary harness session', async () => {
    const dir = await makeStateDir('agent-room-state-foreign-host-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', '');
    vi.stubEnv('CLAUDECODE', '1');
    const code = 'ABC-DEF-GHJ';
    await fs.writeFile(join(dir, 'state-111.json'), JSON.stringify({
      version: 1, rooms: { [code]: { name: 'Foreign Host', client: 'cc', cursor: 7, joinedAt: 10, hostKey: 'foreign-host-key' } },
    }));

    vi.resetModules();
    const { readRoomStateForSession } = await import('../src/state.js');
    expect(await readRoomStateForSession(code)).toBeUndefined();
  });

  it('recovers the current Codex participant after its PPID changes', async () => {
    const dir = await makeStateDir('agent-room-state-codex-host-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', 'test-run');
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    const code = 'ABC-DEF-GHJ';
    await fs.writeFile(harnessFile(dir, 'codex', 'test-run'), JSON.stringify({
      version: 1, rooms: { [code]: { name: 'Codex Host', client: 'cc', cursor: 7, joinedAt: 10, hostKey: 'codex-host-key' } },
    }));

    vi.resetModules();
    const { readRoomStateForSession } = await import('../src/state.js');
    expect(await readRoomStateForSession(code)).toMatchObject({ name: 'Codex Host', hostKey: 'codex-host-key' });
  });

  it('scopes Codex host recovery to the actual run id', async () => {
    const dir = await makeStateDir('agent-room-state-codex-run-scope-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    const code = 'ABC-DEF-GHJ';
    await fs.writeFile(harnessFile(dir, 'codex', 'run-a'), JSON.stringify({
      version: 1, rooms: { [code]: { name: 'Run A Host', client: 'cc', cursor: 2, joinedAt: 10, hostKey: 'run-a-host-key' } },
    }));

    vi.stubEnv('CODEX_RUN_ID', 'run-b');
    vi.resetModules();
    let stateModule = await import('../src/state.js');
    expect(await stateModule.readRoomStateForSession(code)).toBeUndefined();

    vi.stubEnv('CODEX_RUN_ID', 'run-a');
    vi.resetModules();
    stateModule = await import('../src/state.js');
    expect(await stateModule.readRoomStateForSession(code)).toMatchObject({
      name: 'Run A Host', hostKey: 'run-a-host-key',
    });
  });

  it('production room_end never uses a foreign Codex run host identity', async () => {
    const dir = await makeStateDir('agent-room-tool-codex-run-scope-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('AGENT_ROOM_BASE_URL', 'https://room.example');
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    vi.stubEnv('CODEX_RUN_ID', 'run-b');
    const code = 'ABC-DEF-GHJ';
    await fs.writeFile(harnessFile(dir, 'codex', 'run-a'), JSON.stringify({
      version: 1, rooms: { [code]: {
        name: 'Run A Host', client: 'cc', cursor: 2, joinedAt: 10,
        hostKey: 'run-a-host-key', accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43),
      } },
    }));
    const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({
        headers: { ...(init.headers as Record<string, string>) },
        body: JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify({ error: 'NotHostError', message: 'not host' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }));

    vi.resetModules();
    const response = await invokeRoomEnd(code);

    expect(JSON.parse(response.content[0].text)).toMatchObject({ ok: false, error: 'not_host' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ action: 'end', code, requesterName: '' });
    expect(calls[0]!.body).not.toHaveProperty('hostKey');
    expect(calls[0]!.headers).not.toHaveProperty('x-agent-room-access');
    expect(calls[0]!.headers).not.toHaveProperty('authorization');
  });

  it.each([
    { label: 'same Codex run after restart', codexRun: 'run-a', claude: '', file: (dir: string) => harnessFile(dir, 'codex', 'run-a') },
    { label: 'ordinary local session', codexRun: '', claude: '1', file: (dir: string) => join(dir, `state-${process.ppid}.json`) },
  ])('production room_end recovers host identity for $label', async ({ codexRun, claude, file }) => {
    const dir = await makeStateDir('agent-room-tool-legitimate-host-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('AGENT_ROOM_BASE_URL', 'https://room.example');
    vi.stubEnv('CODEX_RUN_ID', codexRun);
    vi.stubEnv('CLAUDECODE', claude);
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    const code = 'ABC-DEF-GHJ';
    await fs.writeFile(file(dir), JSON.stringify({
      version: 1, rooms: { [code]: {
        name: 'Current Host', client: 'cc', cursor: 2, joinedAt: 10,
        hostKey: 'current-host-key', accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43),
      } },
    }));
    const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ room: { code, status: 'ended' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));

    vi.resetModules();
    const response = await invokeRoomEnd(code);

    expect(JSON.parse(response.content[0].text)).toMatchObject({ ended: true, code });
    expect(calls[0]!.body).toMatchObject({ action: 'end', code, requesterName: 'Current Host', hostKey: 'current-host-key' });
    expect(calls[0]!.headers['x-agent-room-access']).toBe('a'.repeat(43));
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${'p'.repeat(43)}`);
  });
});

describe('state lock', () => {
  it('serializes concurrent updateCursor calls (no lost updates)', async () => {
    const dir = await makeStateDir('agent-room-state-lock-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');

    const { setRoom, updateCursor, readMergedState } = await import('../src/state.js');
    await setRoom('AAA-BBB-CCC', { name: 'X', cursor: 0, joinedAt: 1 });

    // Without the cross-process lock these all read cursor=0 concurrently and
    // the last writer wins with an arbitrary value; with it they serialize and
    // the monotonic guard lands on the maximum.
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateCursor('AAA-BBB-CCC', i + 1)));

    const state = await readMergedState();
    expect(state.rooms['AAA-BBB-CCC']?.cursor).toBe(20);
  });

  it('writes state files with 0600 permissions', async () => {
    const dir = await makeStateDir('agent-room-state-mode-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');

    const { setRoom } = await import('../src/state.js');
    await setRoom('AAA-BBB-CCC', { name: 'X', cursor: 0, joinedAt: 1, hostKey: 'secret' });

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const st = await fs.stat(join(dir, f));
      // eslint-disable-next-line no-bitwise
      expect(st.mode & 0o777).toBe(0o600);
    }
  });
});
