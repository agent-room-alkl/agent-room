import { describe, expect, it } from 'vitest';
import type { Message, Participant, Room } from '@agent-room/shared';
import { roomPolicySummary } from '@agent-room/shared';
import { messageAddressesAgent, wakeFactsForAgent } from './_agentWake.js';
import { isDeliverLead } from '@agent-room/upstash-client';

const seat = (name: string, client: 'web' | 'cc', joinedAt: number): Participant => ({
  name, role: 'r', color: '#111', initials: 'XX', client, joinedAt, lastSeenAt: joinedAt, canSpeak: true,
});

const room = {
  code: 'ABC-DEF-GHJ', topic: 't', createdAt: 0, createdBy: 'Robin', status: 'active', version: 1,
  replyMode: 'deliver',
  participants: [seat('Robin', 'web', 0), seat('Claude', 'cc', 1), seat('Codex', 'cc', 2), seat('Grok', 'cc', 3)],
} as Room;

const msg = (name: string, client: 'web' | 'cc', text: string, metadata?: Message['metadata']) =>
  ({ id: 1, type: 'msg', name, client, text, ...(metadata ? { metadata } : {}) }) as Message;

const wakes = (m: Message, self: string) => messageAddressesAgent(m, self, wakeFactsForAgent(room, self));

describe('deliver mode wake rules (MCP room_listen)', () => {
  it("a host goal wakes only the lead", () => {
    const goal = msg('Robin', 'web', 'Ship the export feature');
    expect(wakes(goal, 'Claude')).toBe(true);
    expect(wakes(goal, 'Codex')).toBe(false);
    expect(wakes(goal, 'Grok')).toBe(false);
  });

  it('a worker [BLOCKER] or [RESULT] wakes the lead, an untagged note does not', () => {
    expect(wakes(msg('Codex', 'cc', '[BLOCKER] no DB access'), 'Claude')).toBe(true);
    expect(wakes(msg('Codex', 'cc', '[RESULT] T-01 submitted'), 'Claude')).toBe(true);
    expect(wakes(msg('Codex', 'cc', 'reading the schema'), 'Claude')).toBe(false);
    // …and never wakes the other workers.
    expect(wakes(msg('Codex', 'cc', '[BLOCKER] no DB access'), 'Grok')).toBe(false);
  });

  it('task events still reach their owner or verifier by name', () => {
    const review = msg('system', 'cc', 'T-01 awaiting review', { targetAgentName: 'Grok' });
    expect(wakes(review, 'Grok')).toBe(true);
    expect(wakes(review, 'Codex')).toBe(false);
    expect(wakes(msg('Robin', 'web', '@Codex please pick up T-03'), 'Codex')).toBe(true);
  });

  it('open mode is unchanged: a host message wakes every agent', () => {
    const open = { ...room, replyMode: 'open' } as Room;
    const m = msg('Robin', 'web', 'hello');
    expect(messageAddressesAgent(m, 'Codex', wakeFactsForAgent(open, 'Codex'))).toBe(true);
    expect(wakeFactsForAgent(open, 'Codex')).toEqual({ sole: false, humanBroadcastsToMe: true });
  });
});

describe('deliver mode policy and board', () => {
  it('gives the lead its own brief and everyone else the quiet-execution brief', () => {
    expect(isDeliverLead(room as Room, 'Claude', 'cc')).toBe(true);
    expect(isDeliverLead(room as Room, 'Codex', 'cc')).toBe(false);
    const lead = roomPolicySummary('deliver', undefined, 'lead');
    const member = roomPolicySummary('deliver', undefined, 'member');
    expect(lead).toContain('you are the lead');
    expect(lead).toContain('[PLAN]');
    expect(member).toContain('work silently');
    expect(member).toContain('re-run the check yourself');
    for (const text of [lead, member]) {
      expect(text).toMatch(/^\[policy v6\]/);
      expect(text).toContain('a task is done only when its verifier rules done');
    }
  });
});
