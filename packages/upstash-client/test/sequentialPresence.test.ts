import { describe, expect, it } from 'vitest';
import { PRESENCE_DISCONNECTED_MS } from '@agent-room/shared';
import type { Participant, Room } from '@agent-room/shared';
import { buildSupplementQueue, pickLeadForSequential } from '../src/turnState.js';

const now = Date.now();
function seat(name: string, joinedAt: number, lastSeenAt: number, listenUntil?: number): Participant {
  return { name, client: 'cc', joinedAt, lastSeenAt, listenUntil, role: '', color: '#fff', initials: 'XX' };
}
function room(participants: Participant[]): Room {
  return { code: 'AAA-BBB-CCC', topic: '', createdAt: now, createdBy: 'host', status: 'active', version: 1, replyMode: 'sequential', participants };
}
const stale = () => seat('Old', 1, now - PRESENCE_DISCONNECTED_MS - 10000);
const live = () => seat('Live', 2, now);

describe('sequential presence', () => {
  it('skips a disconnected configured lead and removes disconnected peers', () => {
    const r = room([stale(), live(), seat('Other', 3, now)]);
    r.modeConfig = { leadAgentName: 'Old', leadAgentClient: 'cc' };
    const lead = pickLeadForSequential(r);
    expect(lead?.name).toBe('Live');
    expect(buildSupplementQueue(r, lead).map(p => p.name)).toEqual(['Other']);
  });
  it('keeps an agent working between listens when its recent contact is live', () => {
    const r = room([seat('Working', 1, now, now - 1000), live()]);
    expect(pickLeadForSequential(r)?.name).toBe('Working');
  });
  it('keeps a renewed listener even when its contact timestamp is old', () => {
    const r = room([{ ...stale(), listenUntil: now + 60000 }, live()]);
    expect(pickLeadForSequential(r)?.name).toBe('Old');
  });
  it('retains the full eligible roster if all seats are stale', () => {
    const r = room([stale(), seat('Other', 2, now - PRESENCE_DISCONNECTED_MS - 10000)]);
    expect(pickLeadForSequential(r)?.name).toBe('Old');
    expect(buildSupplementQueue(r, pickLeadForSequential(r)).map(p => p.name)).toEqual(['Other']);
  });
  it('does not restore muted seats through the all-stale fallback', () => {
    const r = room([{ ...stale(), canSpeak: false }, live()]);
    expect(pickLeadForSequential(r)?.name).toBe('Live');
    expect(buildSupplementQueue(r, pickLeadForSequential(r))).toEqual([]);
  });
});
