import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Participant, Room } from '@agent-room/shared';
import {
  createClient,
  pickDeputyModerator,
  sweepTimeouts,
  getRoom,
  getTurnState,
  type TurnState,
} from '../src/index.js';

const ENV = { url: 'https://example.upstash.io', token: 't' };
const CODE = 'TST-CDE-FGH';

// In-memory Upstash fake (see tasks.test.ts) so the sweep's read-modify-write
// against room: and turn-state: keys actually round-trips.
function installFakeRedis(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map<string, string>(Object.entries(seed));
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    const args = JSON.parse(init.body) as string[];
    const [op, key, val] = args;
    let result: unknown = null;
    if (op === 'GET') result = store.has(key) ? store.get(key) : null;
    else if (op === 'SET') {
      // Honor SET ... NX so the dedupe claim (the only NX writer) round-trips:
      // a second SET NX on an existing key returns null (lost the race).
      if (args.includes('NX') && store.has(key)) { result = null; }
      else { store.set(key, val as string); result = 'OK'; }
    }
    else if (op === 'DEL') { result = store.delete(key) ? 1 : 0; }
    return new Response(JSON.stringify({ result }), { headers: { 'Content-Type': 'application/json' } });
  }));
  return store;
}

function part(name: string, joinedAt: number, client: 'web' | 'cc' = 'cc', canSpeak = true): Participant {
  return { name, client, role: '', color: '#fff', initials: 'XX', joinedAt, lastSeenAt: joinedAt, canSpeak };
}

function moderatorRoom(participants: Participant[], moderator: string): Room {
  return {
    code: CODE, topic: 'discussion', createdAt: 0, createdBy: 'host', status: 'active',
    version: 1, participants, replyMode: 'moderator',
    modeConfig: { moderatorAgentName: moderator, moderatorAgentClient: 'cc' },
  };
}

// A moderator turn whose deadline is already in the past, so the sweep skips it.
function expiredModeratorTurn(moderator: string): TurnState {
  return {
    turnId: 100, mode: 'moderator',
    moderatorName: moderator, moderatorClient: 'cc',
    currentName: moderator, currentClient: 'cc', currentRole: 'moderator',
    deadline: 500, queue: [], spoken: [],
  };
}

describe('pickDeputyModerator', () => {
  it('picks the earliest-joined other cc agent, excluding the outgoing moderator and humans', () => {
    const r = moderatorRoom([
      part('Human', 0, 'web'),
      part('ModA', 1),
      part('Deputy', 2),
      part('Late', 3),
    ], 'ModA');
    const deputy = pickDeputyModerator(r, { name: 'ModA', client: 'cc' });
    expect(deputy?.name).toBe('Deputy');
  });

  it('returns undefined when no other cc agent can take over', () => {
    const r = moderatorRoom([part('Human', 0, 'web'), part('ModA', 1)], 'ModA');
    expect(pickDeputyModerator(r, { name: 'ModA', client: 'cc' })).toBeUndefined();
  });

  it('skips muted agents', () => {
    const r = moderatorRoom([part('ModA', 1), part('Muted', 2, 'cc', false)], 'ModA');
    expect(pickDeputyModerator(r, { name: 'ModA', client: 'cc' })).toBeUndefined();
  });
});

describe('sweepTimeouts moderator handoff', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('hands the floor to a deputy instead of collapsing to open when the moderator times out', async () => {
    const r = moderatorRoom([part('Human', 0, 'web'), part('ModA', 1), part('Deputy', 2)], 'ModA');
    installFakeRedis({
      [`room:${CODE}`]: JSON.stringify(r),
      [`turn-state:${CODE}`]: JSON.stringify(expiredModeratorTurn('ModA')),
    });
    const client = createClient(ENV);

    const sweep = await sweepTimeouts(client, CODE, r, 10_000);

    expect(sweep.handoff).toBeDefined();
    expect(sweep.handoff?.fromName).toBe('ModA');
    expect(sweep.handoff?.toName).toBe('Deputy');
    expect(sweep.fallback).toBeUndefined();
    // The new turn makes the deputy the moderator/current speaker.
    expect(sweep.state?.moderatorName).toBe('Deputy');
    expect(sweep.state?.currentName).toBe('Deputy');
    expect(sweep.state?.currentRole).toBe('moderator');
    // The room itself stays in moderator mode, repointed at the deputy.
    const room = await getRoom(client, CODE);
    expect(room.replyMode).toBe('moderator');
    expect(room.modeConfig?.moderatorAgentName).toBe('Deputy');
  });

  it('falls back to open when there is no deputy to take over', async () => {
    const r = moderatorRoom([part('Human', 0, 'web'), part('ModA', 1)], 'ModA');
    installFakeRedis({
      [`room:${CODE}`]: JSON.stringify(r),
      [`turn-state:${CODE}`]: JSON.stringify(expiredModeratorTurn('ModA')),
    });
    const client = createClient(ENV);

    const sweep = await sweepTimeouts(client, CODE, r, 10_000);

    expect(sweep.handoff).toBeUndefined();
    expect(sweep.fallback).toBeDefined();
    expect(sweep.fallback?.reason).toBe('moderator_timeout');
    const room = await getRoom(client, CODE);
    expect(room.replyMode).toBe('open');
    // turn state cleared on collapse
    expect(await getTurnState(client, CODE)).toBeNull();
  });

  it('dedupes concurrent sweeps of the same expired moderator: only the first emits the handoff', async () => {
    // Two listen polls observe the SAME expired moderator deadline. The first
    // claims the dead-end and returns the handoff; the second must suppress its
    // skip + handoff so the caller does not post duplicate sys messages. We
    // re-seed the expired turn (and ModA as moderator) between calls to mimic
    // both polls reading the same pre-handoff state, while the shared store
    // keeps the dedupe lock so the second claim loses.
    const r = moderatorRoom([part('Human', 0, 'web'), part('ModA', 1), part('Deputy', 2)], 'ModA');
    const store = installFakeRedis({
      [`room:${CODE}`]: JSON.stringify(r),
      [`turn-state:${CODE}`]: JSON.stringify(expiredModeratorTurn('ModA')),
    });
    const client = createClient(ENV);

    const first = await sweepTimeouts(client, CODE, r, 10_000);
    expect(first.handoff?.toName).toBe('Deputy');
    expect(first.skipped.length).toBe(1);

    // Reset to the pre-handoff state both racers saw; keep the dedupe lock.
    store.set(`room:${CODE}`, JSON.stringify(r));
    store.set(`turn-state:${CODE}`, JSON.stringify(expiredModeratorTurn('ModA')));

    const second = await sweepTimeouts(client, CODE, r, 10_000);
    expect(second.handoff).toBeUndefined();
    expect(second.fallback).toBeUndefined();
    expect(second.skipped).toEqual([]);
  });

  it('hands off (not collapses) when the moderator has left the room', async () => {
    // Moderator ModA is no longer in participants; Deputy remains.
    const r = moderatorRoom([part('Human', 0, 'web'), part('Deputy', 2)], 'ModA');
    installFakeRedis({
      [`room:${CODE}`]: JSON.stringify(r),
      [`turn-state:${CODE}`]: JSON.stringify(expiredModeratorTurn('ModA')),
    });
    const client = createClient(ENV);

    const sweep = await sweepTimeouts(client, CODE, r, 10_000);

    expect(sweep.handoff?.reason).toBe('moderator_left');
    expect(sweep.handoff?.toName).toBe('Deputy');
  });
});
