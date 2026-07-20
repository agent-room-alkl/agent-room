import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeStates, type AgentRoomState } from '../src/state.js';

async function makeStateDir(prefix: string) {
  return fs.mkdtemp(join(tmpdir(), prefix));
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
    expect(files).toContain('state-harness-codex.json');

    const harnessRaw = await fs.readFile(join(dir, 'state-harness-codex.json'), 'utf8');
    expect(JSON.parse(harnessRaw).rooms['ABC-DEF-GHJ']).toMatchObject({
      name: 'Codex',
      cursor: 2,
    });
  });

  it('reads Codex harness state when the hook PPID state is empty', async () => {
    const dir = await makeStateDir('agent-room-state-codex-read-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', 'test-run');

    await fs.writeFile(
      join(dir, 'state-harness-codex.json'),
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
