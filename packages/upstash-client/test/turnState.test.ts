import { describe, it, expect } from 'vitest';
import { FIRST_RESPONSE_GRACE_MS, TURN_HARD_CAP_MS } from '@agent-room/shared';
import type { Participant, Room } from '@agent-room/shared';
import {
  addHostDirected,
  advanceOnTimeout,
  advanceTurn,
  applyGraceSupplementReply,
  buildSupplementQueue,
  canAgentSpeakNow,
  consumeHostDirected,
  consumeHostDirectedDetailed,
  isCurrentSpeaker,
  isGraceSupplementSpeaker,
  isHumanSender,
  leadGraceMs,
  moderatorReply,
  myRoleInTurn,
  newModeratorTurn,
  newSequentialTurn,
  pickLeadForSequential,
  renewTurnDeadline,
  SEQUENTIAL_MAX_ROUNDS,
  shouldStartNewTurn,
  skipQueueHead,
  timeoutForRole,
  type TurnState,
} from '../src/turnState.js';

function part(name: string, client: 'web' | 'cc', joinedAt: number, canSpeak = true): Participant {
  return { name, client, role: '', color: '#fff', initials: 'XX', joinedAt, lastSeenAt: joinedAt, canSpeak };
}

function room(overrides: Partial<Room> = {}): Room {
  return {
    code: 'TST-CDE-FGH',
    topic: 'discussion',
    createdAt: 0,
    createdBy: 'host',
    status: 'active',
    version: 1,
    participants: [
      part('host', 'web', 0),
      part('Lead', 'cc', 10),
      part('A', 'cc', 20),
      part('B', 'cc', 30),
    ],
    replyMode: 'sequential',
    ...overrides,
  };
}

describe('pickLeadForSequential', () => {
  it('honors explicit leadAgentName/Client from modeConfig', () => {
    const r = room({ modeConfig: { leadAgentName: 'A', leadAgentClient: 'cc' } });
    expect(pickLeadForSequential(r)).toEqual({ name: 'A', client: 'cc' });
  });

  it('falls back to first cc agent in join order when modeConfig is empty', () => {
    const r = room();
    expect(pickLeadForSequential(r)).toEqual({ name: 'Lead', client: 'cc' });
  });

  it('skips the host and any web-client participant', () => {
    const r = room({
      participants: [
        part('host', 'web', 0),
        part('humanGuest', 'web', 5),
        part('cc1', 'cc', 10),
      ],
    });
    expect(pickLeadForSequential(r)).toEqual({ name: 'cc1', client: 'cc' });
  });

  it('returns undefined when no cc agents are present', () => {
    const r = room({ participants: [part('host', 'web', 0)] });
    expect(pickLeadForSequential(r)).toBeUndefined();
  });

  it('falls back when modeConfig points to a Lead who has left the room', () => {
    const r = room({ modeConfig: { leadAgentName: 'Ghost', leadAgentClient: 'cc' } });
    // Ghost is not in participants → fall back to first cc agent in join order.
    expect(pickLeadForSequential(r)).toEqual({ name: 'Lead', client: 'cc' });
  });
});

describe('buildSupplementQueue', () => {
  it('lists cc agents in join order, excluding the Lead and the host', () => {
    const r = room();
    const queue = buildSupplementQueue(r, { name: 'Lead', client: 'cc' });
    expect(queue).toEqual([
      { name: 'A', client: 'cc', role: 'supplement' },
      { name: 'B', client: 'cc', role: 'supplement' },
    ]);
  });

  it('filters out muted agents', () => {
    const r = room({
      participants: [
        part('host', 'web', 0),
        part('Lead', 'cc', 10),
        part('A', 'cc', 20, /*canSpeak*/ false),
        part('B', 'cc', 30),
      ],
    });
    const queue = buildSupplementQueue(r, { name: 'Lead', client: 'cc' });
    expect(queue).toEqual([{ name: 'B', client: 'cc', role: 'supplement' }]);
  });
});

describe('newSequentialTurn', () => {
  it('returns null when no cc agents are present', () => {
    const r = room({ participants: [part('host', 'web', 0)] });
    expect(newSequentialTurn(r, 1)).toBeNull();
  });

  it('starts with Lead current, supplement queue in join order', () => {
    const r = room();
    const state = newSequentialTurn(r, 100, 1000)!;
    expect(state.turnId).toBe(1000);
    expect(state.mode).toBe('sequential');
    expect(state.leadName).toBe('Lead');
    expect(state.currentName).toBe('Lead');
    expect(state.currentRole).toBe('lead');
    expect(state.deadline).toBe(1000 + FIRST_RESPONSE_GRACE_MS); // first-response grace
    expect(state.hardDeadline).toBe(1000 + TURN_HARD_CAP_MS); // turn hard cap
    expect(state.leadGraceUntil).toBe(1000 + 20_000); // default lead grace
    expect(state.queue).toEqual([
      { name: 'A', client: 'cc', role: 'supplement' },
      { name: 'B', client: 'cc', role: 'supplement' },
    ]);
    expect(state.spoken).toEqual([]);
  });

  it('omits leadGraceUntil when no supplements are waiting (pointless grace)', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10)] });
    const state = newSequentialTurn(r, 100, 1000)!;
    expect(state.queue).toEqual([]);
    expect(state.leadGraceUntil).toBeUndefined();
  });
});

describe('advanceTurn', () => {
  it('moves current to spoken with given status, pops queue head into current', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    const after = advanceTurn(start, 'replied', r, 2000);
    expect(after.spoken).toEqual([
      { name: 'Lead', client: 'cc', role: 'lead', status: 'replied', at: 2000, round: 1 },
    ]);
    expect(after.currentName).toBe('A');
    expect(after.currentRole).toBe('supplement');
    expect(after.deadline).toBe(2000 + FIRST_RESPONSE_GRACE_MS); // first-response grace
    expect(after.hardDeadline).toBe(2000 + TURN_HARD_CAP_MS); // turn hard cap
    expect(after.queue).toEqual([{ name: 'B', client: 'cc', role: 'supplement' }]);
    // Grace window cleared once we leave the lead slot.
    expect(after.leadGraceUntil).toBeUndefined();
  });

  it('starts the next round-robin round when the queue empties and the round replied', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10)] });
    const start = newSequentialTurn(r, 100, 1000)!;
    expect(start.queue).toEqual([]);
    expect(start.round).toBe(1);
    // Lead (the only agent) replies → queue empty → round 1 had a reply →
    // a fresh round 2 starts with the Lead taking the floor again.
    const after = advanceTurn(start, 'replied', r, 2000);
    expect(after.currentName).toBe('Lead');
    expect(after.currentRole).toBe('lead');
    expect(after.round).toBe(2);
    expect(after.deadline).toBe(2000 + FIRST_RESPONSE_GRACE_MS); // fresh first-response grace
    expect(after.hardDeadline).toBe(2000 + TURN_HARD_CAP_MS); // fresh turn hard cap
    expect(after.queue).toEqual([]);
    expect(after.spoken).toEqual([
      { name: 'Lead', client: 'cc', role: 'lead', status: 'replied', at: 2000, round: 1 },
    ]);
  });

  it('honors `no_addition` as a status without otherwise differing from `replied`', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    // Advance once to put a supplement in the current slot, then advance again with no_addition.
    const second = advanceTurn(start, 'replied', r, 2000);
    const third = advanceTurn(second, 'no_addition', r, 3000);
    expect(third.spoken[1]).toEqual({
      name: 'A', client: 'cc', role: 'supplement', status: 'no_addition', at: 3000, round: 1,
    });
    expect(third.currentName).toBe('B');
  });
});

describe('sequential round-robin', () => {
  it('starts a new round after every agent has spoken once', () => {
    const r = room(); // host, Lead, A, B
    let state = newSequentialTurn(r, 1, 1000)!;
    expect(state.round).toBe(1);
    state = advanceTurn(state, 'replied', r, 2000); // A current
    expect(state.currentName).toBe('A');
    state = advanceTurn(state, 'replied', r, 3000); // B current
    expect(state.currentName).toBe('B');
    state = advanceTurn(state, 'replied', r, 4000); // queue empty → round 2
    expect(state.currentName).toBe('Lead');
    expect(state.currentClient).toBe('cc');
    expect(state.currentRole).toBe('lead');
    expect(state.round).toBe(2);
    expect(state.deadline).toBe(4000 + FIRST_RESPONSE_GRACE_MS); // fresh first-response grace
    expect(state.queue).toEqual([
      { name: 'A', client: 'cc', role: 'supplement' },
      { name: 'B', client: 'cc', role: 'supplement' },
    ]);
  });

  it('ends the turn when a round produces no new replies (converged)', () => {
    const r = room(); // host, Lead, A, B
    let state = newSequentialTurn(r, 1, 1000)!;
    // Round 1: everyone contributes.
    state = advanceTurn(state, 'replied', r, 2000); // A
    state = advanceTurn(state, 'replied', r, 3000); // B
    state = advanceTurn(state, 'replied', r, 4000); // → round 2
    expect(state.round).toBe(2);
    // Round 2: nobody adds anything → converged → turn ends.
    state = advanceTurn(state, 'no_addition', r, 5000); // A
    state = advanceTurn(state, 'no_addition', r, 6000); // B
    const ended = advanceTurn(state, 'no_addition', r, 7000); // round 2 done, 0 replies
    expect(ended.currentName).toBeUndefined();
    expect(ended.currentRole).toBeUndefined();
    expect(ended.deadline).toBeUndefined();
    expect(ended.round).toBe(2);
  });

  it('ends the turn after SEQUENTIAL_MAX_ROUNDS even if agents keep replying', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10)] });
    let state = newSequentialTurn(r, 1, 1000)!;
    // One agent that always replies would loop forever without the cap.
    for (let i = 0; i < 200 && state.currentName; i++) {
      state = advanceTurn(state, 'replied', r, 2000 + i * 1000);
    }
    expect(state.currentName).toBeUndefined();
    expect(state.round).toBe(SEQUENTIAL_MAX_ROUNDS);
  });

  it('the next round opens with a fresh deadline — not instantly skipped', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10)] });
    const start = newSequentialTurn(r, 1, 1000)!;
    const round2 = advanceTurn(start, 'replied', r, 2000); // queue empty → round 2
    expect(round2.round).toBe(2);
    const { state, skipped } = advanceOnTimeout(round2, r, 3000); // 3000 < deadline
    expect(skipped).toEqual([]);
    expect(state?.currentName).toBe('Lead');
    expect(state?.round).toBe(2);
  });

  it('ends the turn when no cc agents remain for the next round', () => {
    const r = room(); // host, Lead, A, B
    let state = newSequentialTurn(r, 1, 1000)!;
    state = advanceTurn(state, 'replied', r, 2000); // A current
    state = advanceTurn(state, 'replied', r, 3000); // B current
    // Every agent has left by the time round 2 would start.
    const rNoAgents = room({ participants: [part('host', 'web', 0)] });
    const ended = advanceTurn(state, 'replied', rNoAgents, 4000);
    expect(ended.currentName).toBeUndefined();
    expect(ended.currentRole).toBeUndefined();
    expect(ended.deadline).toBeUndefined();
  });

  it('moderator mode: advanceTurn on an empty queue clears', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Lead', moderatorAgentClient: 'cc' },
    });
    const start = newModeratorTurn(r, 1, 1000)!;
    expect(start.queue).toEqual([]);
    const after = advanceTurn(start, 'skipped', r, 2000);
    expect(after.currentName).toBeUndefined();
    expect(after.currentRole).toBeUndefined();
  });
});

describe('renewTurnDeadline', () => {
  it('pushes a sequential current speaker deadline out by the renewal window', () => {
    const r = room();
    const start = newSequentialTurn(r, 1, 1000)!; // deadline 61_000, hardDeadline 601_000
    // Heartbeat at t=30_000 → deadline = min(30_000 + 300_000, 601_000).
    const renewed = renewTurnDeadline(start, 30_000);
    expect(renewed.deadline).toBe(330_000);
    expect(renewed.hardDeadline).toBe(601_000); // ceiling never moves
  });

  it('caps the renewed deadline at hardDeadline', () => {
    const r = room();
    const start = newSequentialTurn(r, 1, 1000)!; // hardDeadline 601_000
    // Late heartbeat: 500_000 + 300_000 = 800_000 > hardDeadline → capped.
    const renewed = renewTurnDeadline(start, 500_000);
    expect(renewed.deadline).toBe(601_000);
  });

  it('keeps the later deadline — a heartbeat never shortens a turn', () => {
    const state: TurnState = {
      turnId: 1, mode: 'sequential',
      currentName: 'Lead', currentClient: 'cc', currentRole: 'lead',
      deadline: 500_000, hardDeadline: 600_000, queue: [], spoken: [],
    };
    // now=0 → renewed = min(300_000, 600_000) = 300_000, which is < 500_000.
    expect(renewTurnDeadline(state, 0).deadline).toBe(500_000);
  });

  it('is a no-op for moderator mode', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Lead', moderatorAgentClient: 'cc' },
    });
    const start = newModeratorTurn(r, 1, 1000)!;
    expect(renewTurnDeadline(start, 30_000)).toBe(start);
  });

  it('is a no-op when there is no current speaker', () => {
    const ended: TurnState = { turnId: 1, mode: 'sequential', queue: [], spoken: [] };
    expect(renewTurnDeadline(ended, 30_000)).toBe(ended);
  });
});

describe('advanceOnTimeout', () => {
  it('returns the same state when no deadline has passed', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    const { state, skipped } = advanceOnTimeout(start, r, /*now*/ 1500);
    expect(state).toEqual(start);
    expect(skipped).toEqual([]);
  });

  it('skips the expired speaker and gives the successor a fresh first-response window', () => {
    const r = room();
    const stacked: TurnState = {
      turnId: 1,
      mode: 'sequential',
      leadName: 'Lead',
      leadClient: 'cc',
      currentName: 'Lead',
      currentClient: 'cc',
      currentRole: 'lead',
      deadline: 100, // already passed at now=1000
      hardDeadline: 600_100,
      queue: [
        { name: 'A', client: 'cc', role: 'supplement' },
        { name: 'B', client: 'cc', role: 'supplement' },
      ],
      spoken: [],
    };
    // Only the Lead is skipped. The next speaker (A) becomes current with a
    // fresh 60s first-response window measured from `now`, so the cascade
    // stops there — speakers are never retroactively skipped for time that
    // passed before they actually had the floor.
    const { state, skipped } = advanceOnTimeout(stacked, r, 1000);
    expect(skipped.map(s => s.name)).toEqual(['Lead']);
    expect(skipped[0]?.status).toBe('timed_out');
    expect(state?.currentName).toBe('A');
    expect(state?.deadline).toBe(1000 + FIRST_RESPONSE_GRACE_MS);
    expect(state?.hardDeadline).toBe(1000 + TURN_HARD_CAP_MS);
    expect(state?.spoken).toHaveLength(1);
  });
});

describe('isCurrentSpeaker / isHumanSender / shouldStartNewTurn', () => {
  it('isCurrentSpeaker matches both name and client', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    expect(isCurrentSpeaker(start, 'Lead', 'cc')).toBe(true);
    expect(isCurrentSpeaker(start, 'Lead', 'web')).toBe(false);
    expect(isCurrentSpeaker(start, 'A', 'cc')).toBe(false);
    expect(isCurrentSpeaker(null, 'Lead', 'cc')).toBe(false);
  });

  it('isHumanSender: web client, or the room host (even if cc)', () => {
    const r = room();
    expect(isHumanSender(r, 'host', 'web')).toBe(true);
    expect(isHumanSender(r, 'guest', 'web')).toBe(true);
    expect(isHumanSender(r, 'A', 'cc')).toBe(false);
    // Host masquerading as cc still counts as human.
    expect(isHumanSender(r, 'host', 'cc')).toBe(true);
  });

  it('shouldStartNewTurn returns false in open mode', () => {
    const r = room({ replyMode: 'open' });
    expect(shouldStartNewTurn(null, r)).toBe(false);
  });

  it('shouldStartNewTurn returns true when no turn is in flight in sequential mode', () => {
    const r = room();
    expect(shouldStartNewTurn(null, r)).toBe(true);
  });

  it('shouldStartNewTurn returns true when prior turn is complete (current cleared, queue empty)', () => {
    const r = room();
    const finished: TurnState = {
      turnId: 1, mode: 'sequential', queue: [], spoken: [
        { name: 'Lead', client: 'cc', role: 'lead', status: 'replied', at: 1 },
      ],
    };
    expect(shouldStartNewTurn(finished, r)).toBe(true);
  });

  it('shouldStartNewTurn returns false while a turn is still in flight', () => {
    const r = room();
    const inflight = newSequentialTurn(r, 1, 1)!;
    expect(shouldStartNewTurn(inflight, r)).toBe(false);
  });
});

describe('consumeHostDirected', () => {
  it('returns false on empty allowlist', () => {
    const state: TurnState = {
      turnId: 1, mode: 'sequential', queue: [], spoken: [],
    };
    expect(consumeHostDirected(state, 'A', 'cc')).toBe(false);
  });

  it('returns true and removes the matching entry', () => {
    const state: TurnState = {
      turnId: 1, mode: 'sequential', queue: [], spoken: [],
      hostDirected: [
        { name: 'A', client: 'cc', addedAt: 1 },
        { name: 'B', client: 'cc', addedAt: 2 },
      ],
    };
    expect(consumeHostDirected(state, 'A', 'cc')).toBe(true);
    expect(state.hostDirected).toEqual([{ name: 'B', client: 'cc', addedAt: 2 }]);
  });
});

describe('timeoutForRole', () => {
  it('returns the default for unconfigured roles', () => {
    const r = room();
    expect(timeoutForRole(r, 'lead')).toBe(600_000);
    expect(timeoutForRole(r, 'supplement')).toBe(600_000);
    expect(timeoutForRole(r, 'wrap')).toBe(600_000);
    expect(timeoutForRole(r, 'moderator')).toBe(600_000);
    expect(timeoutForRole(r, 'assignee')).toBe(600_000);
  });

  it('honors modeConfig.timeoutMs overrides', () => {
    const r = room({ modeConfig: { timeoutMs: { lead: 5_000, supplement: 1_000, wrap: 2_000 } } });
    expect(timeoutForRole(r, 'lead')).toBe(5_000);
    expect(timeoutForRole(r, 'supplement')).toBe(1_000);
    expect(timeoutForRole(r, 'wrap')).toBe(2_000);
    // Unconfigured roles still fall back.
    expect(timeoutForRole(r, 'moderator')).toBe(600_000);
  });

  it('returns Infinity for non-deadline roles (open, human, host_directed)', () => {
    const r = room();
    expect(timeoutForRole(r, 'open')).toBe(Number.POSITIVE_INFINITY);
    expect(timeoutForRole(r, 'human')).toBe(Number.POSITIVE_INFINITY);
    expect(timeoutForRole(r, 'host_directed')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('newModeratorTurn', () => {
  it('returns null when no moderator is configured', () => {
    const r = room({ replyMode: 'moderator', modeConfig: {} });
    expect(newModeratorTurn(r, 1)).toBeNull();
  });

  it('returns null when configured moderator is absent from the room', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Ghost', moderatorAgentClient: 'cc' },
    });
    expect(newModeratorTurn(r, 1)).toBeNull();
  });

  it('returns null when configured moderator is muted', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Lead', moderatorAgentClient: 'cc' },
      participants: [
        part('host', 'web', 0),
        part('Lead', 'cc', 10, /*canSpeak*/ false),
      ],
    });
    expect(newModeratorTurn(r, 1)).toBeNull();
  });

  it('starts with moderator as current and empty queue', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Lead', moderatorAgentClient: 'cc' },
    });
    const state = newModeratorTurn(r, 100, 1000)!;
    expect(state.mode).toBe('moderator');
    expect(state.moderatorName).toBe('Lead');
    expect(state.currentName).toBe('Lead');
    expect(state.currentRole).toBe('moderator');
    expect(state.queue).toEqual([]);
    expect(state.deadline).toBe(1000 + 600_000); // default moderator timeout
  });
});

describe('moderatorReply', () => {
  it('keeps current = moderator, resets deadline, logs in spoken', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Lead', moderatorAgentClient: 'cc' },
    });
    const start = newModeratorTurn(r, 100, 1000)!;
    const after = moderatorReply(start, r, 5000);
    expect(after.currentName).toBe('Lead');
    expect(after.currentRole).toBe('moderator');
    expect(after.deadline).toBe(5000 + 600_000);
    expect(after.spoken).toEqual([
      { name: 'Lead', client: 'cc', role: 'moderator', status: 'replied', at: 5000 },
    ]);
  });
});

describe('addHostDirected / consumeHostDirectedDetailed', () => {
  it('records source on addHostDirected and surfaces it on consume', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    const withDirected = addHostDirected(start, 'A', 'cc', 'moderator', 2000);
    const detailed = consumeHostDirectedDetailed(withDirected, 'A', 'cc');
    expect(detailed.consumed).toBe(true);
    expect(detailed.source).toBe('moderator');
  });

  it('defaults source to "host" when not specified', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    const withDirected = addHostDirected(start, 'A', 'cc');
    const detailed = consumeHostDirectedDetailed(withDirected, 'A', 'cc');
    expect(detailed.source).toBe('host');
  });

  it('returns consumed=false when target is not in the allowlist', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    expect(consumeHostDirectedDetailed(start, 'A', 'cc')).toEqual({ consumed: false });
  });

  it('addHostDirected is idempotent (no stacking)', () => {
    const r = room();
    let state = newSequentialTurn(r, 100, 1000)!;
    state = addHostDirected(state, 'A', 'cc', 'host', 2000);
    state = addHostDirected(state, 'A', 'cc', 'host', 3000); // duplicate
    expect(state.hostDirected).toHaveLength(1);
  });
});

describe('myRoleInTurn', () => {
  it('returns observer when no turn is active', () => {
    expect(myRoleInTurn(null, 'A', 'cc')).toBe('observer');
  });

  it('returns the role of the current speaker', () => {
    const r = room();
    const state = newSequentialTurn(r, 1, 1)!;
    expect(myRoleInTurn(state, 'Lead', 'cc')).toBe('lead');
  });

  it('returns "queued" for upcoming supplements before lead-grace elapses', () => {
    const r = room();
    const state = newSequentialTurn(r, 1, 1000)!;
    // 5s into the turn — well within the 20s lead grace window.
    expect(myRoleInTurn(state, 'A', 'cc', 6000)).toBe('queued');
    expect(myRoleInTurn(state, 'B', 'cc', 6000)).toBe('queued');
  });

  it('returns "spoken" once the participant has replied or been skipped', () => {
    const r = room();
    const start = newSequentialTurn(r, 1, 1)!;
    const after = advanceTurn(start, 'replied', r, 100);
    expect(myRoleInTurn(after, 'Lead', 'cc')).toBe('spoken');
    expect(myRoleInTurn(after, 'A', 'cc')).toBe('supplement'); // now current
  });

  it('returns "host_directed" when present in the one-shot allowlist', () => {
    const state: TurnState = {
      turnId: 1, mode: 'sequential', queue: [], spoken: [],
      hostDirected: [{ name: 'A', client: 'cc', addedAt: 0 }],
    };
    expect(myRoleInTurn(state, 'A', 'cc')).toBe('host_directed');
  });
});

describe('lead grace', () => {
  it('leadGraceMs honors modeConfig override and falls back to default', () => {
    expect(leadGraceMs(room())).toBe(20_000);
    expect(leadGraceMs(room({ modeConfig: { leadGraceMs: 5_000 } }))).toBe(5_000);
  });

  it('canAgentSpeakNow: Lead always, queue head only after grace, others never', () => {
    const r = room();
    const state = newSequentialTurn(r, 1, 1000)!;
    // Inside grace: only Lead can speak.
    expect(canAgentSpeakNow(state, 'Lead', 'cc', 5000)).toBe(true);
    expect(canAgentSpeakNow(state, 'A', 'cc', 5000)).toBe(false);
    expect(canAgentSpeakNow(state, 'B', 'cc', 5000)).toBe(false);
    // Past grace: queue head A unlocks; B (not at head) stays gated.
    expect(canAgentSpeakNow(state, 'Lead', 'cc', 25_000)).toBe(true);
    expect(canAgentSpeakNow(state, 'A', 'cc', 25_000)).toBe(true);
    expect(canAgentSpeakNow(state, 'B', 'cc', 25_000)).toBe(false);
  });

  it('isGraceSupplementSpeaker distinguishes grace-path from current-speaker path', () => {
    const r = room();
    const state = newSequentialTurn(r, 1, 1000)!;
    expect(isGraceSupplementSpeaker(state, 'Lead', 'cc', 25_000)).toBe(false); // is current
    expect(isGraceSupplementSpeaker(state, 'A', 'cc', 25_000)).toBe(true);     // grace path
    expect(isGraceSupplementSpeaker(state, 'A', 'cc', 5_000)).toBe(false);     // still in grace
  });

  it('myRoleInTurn surfaces the queue-head supplement as "supplement" after grace', () => {
    const r = room();
    const state = newSequentialTurn(r, 1, 1000)!;
    expect(myRoleInTurn(state, 'A', 'cc', 5_000)).toBe('queued');
    expect(myRoleInTurn(state, 'A', 'cc', 25_000)).toBe('supplement');
    // Non-head supplement stays queued — only the head is grace-eligible.
    expect(myRoleInTurn(state, 'B', 'cc', 25_000)).toBe('queued');
  });

  it('applyGraceSupplementReply marks Lead skipped_by_grace and advances the queue', () => {
    const r = room();
    const state = newSequentialTurn(r, 1, 1000)!;
    const { state: after, leadSkipped } = applyGraceSupplementReply(
      state, 'A', 'cc', r, 25_000,
    );
    expect(leadSkipped).toEqual({
      name: 'Lead', client: 'cc', role: 'lead', status: 'skipped_by_grace', at: 25_000, round: 1,
    });
    expect(after.spoken).toEqual([
      { name: 'Lead', client: 'cc', role: 'lead', status: 'skipped_by_grace', at: 25_000, round: 1 },
      { name: 'A', client: 'cc', role: 'supplement', status: 'replied', at: 25_000, round: 1 },
    ]);
    expect(after.currentName).toBe('B');
    expect(after.queue).toEqual([]);
    expect(after.leadGraceUntil).toBeUndefined();
  });

  it('starts the next round when the grace path drains the queue', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10), part('A', 'cc', 20)] });
    const state = newSequentialTurn(r, 1, 1000)!;
    const { state: after } = applyGraceSupplementReply(state, 'A', 'cc', r, 25_000);
    // Queue drained via the grace path, round 1 had a reply (A) → round 2
    // starts with the Lead taking the floor again.
    expect(after.currentName).toBe('Lead');
    expect(after.currentRole).toBe('lead');
    expect(after.round).toBe(2);
    expect(after.queue).toEqual([{ name: 'A', client: 'cc', role: 'supplement' }]);
    expect(after.spoken).toHaveLength(2); // Lead skipped_by_grace + A replied
  });

  it('Lead reply during grace uses normal advanceTurn (no skip)', () => {
    const r = room();
    const state = newSequentialTurn(r, 1, 1000)!;
    const after = advanceTurn(state, 'replied', r, 5_000);
    expect(after.spoken[0]?.status).toBe('replied');
    expect(after.currentName).toBe('A');
    expect(after.leadGraceUntil).toBeUndefined();
  });

  it('skipQueueHead drops the head supplement without preempting the Lead', () => {
    const r = room();
    const state = newSequentialTurn(r, 1, 1000)!;
    const after = skipQueueHead(state, 'no_addition', 25_000);
    // Lead still current; A removed from queue with no_addition status.
    expect(after.currentName).toBe('Lead');
    expect(after.currentRole).toBe('lead');
    expect(after.leadGraceUntil).toBe(state.leadGraceUntil);
    expect(after.queue).toEqual([{ name: 'B', client: 'cc', role: 'supplement' }]);
    expect(after.spoken).toEqual([
      { name: 'A', client: 'cc', role: 'supplement', status: 'no_addition', at: 25_000, round: 1 },
    ]);
  });

  it('skipQueueHead is a no-op when the queue is empty', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10)] });
    const state = newSequentialTurn(r, 1, 1000)!;
    expect(state.queue).toEqual([]);
    const after = skipQueueHead(state, 'no_addition', 25_000);
    expect(after).toEqual(state);
  });
});
