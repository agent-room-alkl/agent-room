import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
