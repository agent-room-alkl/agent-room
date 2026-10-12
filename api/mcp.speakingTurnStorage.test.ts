import { describe, expect, it } from 'vitest';
import type { Room } from '@agent-room/shared';
import { newSequentialTurn } from '@agent-room/upstash-client';
import { getSpeakingTurn, type RemoteRoomClient } from './_mcpRoomClient.js';

function fixture() {
  const now = Date.now();
  const room: Room = {
    code: 'AAA-BBB-CCC', topic: '', createdAt: now, createdBy: 'host', status: 'active', version: 1, replyMode: 'sequential',
    participants: ['Lead', 'Peer'].map((name, i) => ({ name, client: 'cc', role: '', color: '#fff', initials: 'XX', joinedAt: i, lastSeenAt: now })),
  };
  const state = newSequentialTurn(room, 1, now)!;
  const data = new Map<string, string>([['room:' + room.code, JSON.stringify(room)], ['turn-state:' + room.code, JSON.stringify(state)]]);
  const client = { store: { command: async (args: string[]) => {
    if (args[0] === 'GET') return data.get(args[1]) ?? null;
    if (args[0] === 'SET') { data.set(args[1], args[2]); return 'OK'; }
    if (args[0] === 'DEL') { data.delete(args[1]); return 1; }
    throw new Error('Unexpected command ' + args[0]);
  } } } as unknown as RemoteRoomClient;
  return { room, state, data, client, save: () => { data.set('room:' + room.code, JSON.stringify(room)); data.set('turn-state:' + room.code, JSON.stringify(state)); } };
}

describe('speaking entitlement against the storage turn machine', () => {
  it('returns the lead but not a queued peer before its grace window', async () => {
    const f = fixture();
    expect(await getSpeakingTurn(f.client, f.room.code, 'Lead')).toMatchObject({ isLead: true, role: 'lead', round: 1 });
    expect(await getSpeakingTurn(f.client, f.room.code, 'Peer')).toBeNull();
  });
  it('recognizes the legacy grace-eligible supplement', async () => {
    const f = fixture(); f.state.leadGraceUntil = Date.now() - 1; f.save();
    expect(await getSpeakingTurn(f.client, f.room.code, 'Peer')).toMatchObject({ role: 'supplement', isLead: false });
  });
  it('advances an expired speaker before granting the next peer', async () => {
    const f = fixture(); f.state.deadline = Date.now() - 1; f.save();
    expect(await getSpeakingTurn(f.client, f.room.code, 'Peer')).toMatchObject({ role: 'supplement', round: 1 });
    expect(JSON.parse(f.data.get('turn-state:' + f.room.code)!).spoken[0].status).toBe('timed_out');
  });
  it('recognizes a moderator assignment without treating the worker as moderator', async () => {
    const f = fixture();
    f.room.replyMode = 'moderator'; f.room.modeConfig = { moderatorAgentName: 'Lead', moderatorAgentClient: 'cc' };
    f.state.mode = 'moderator'; f.state.moderatorName = 'Lead'; f.state.moderatorClient = 'cc'; f.state.currentRole = 'moderator';
    f.state.hostDirected = [{ name: 'Peer', client: 'cc', addedAt: Date.now(), source: 'moderator' }]; f.save();
    expect(await getSpeakingTurn(f.client, f.room.code, 'Peer')).toMatchObject({ mode: 'moderator', role: 'assignee', isLead: false });
  });
  it.each(['muted', 'removed', 'ended', 'mode_changed'])( 'does not grant a %s seat', async reason => {
    const f = fixture();
    if (reason === 'muted') f.room.participants[0].canSpeak = false;
    if (reason === 'removed') f.room.participants.shift();
    if (reason === 'ended') f.room.status = 'ended';
    if (reason === 'mode_changed') f.room.replyMode = 'open';
    f.save();
    expect(await getSpeakingTurn(f.client, f.room.code, 'Lead')).toBeNull();
  });
});
