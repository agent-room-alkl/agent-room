import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Room } from '@agent-room/shared';

const mocks = vi.hoisted(() => ({ room: vi.fn(), messages: vi.fn(), turn: vi.fn() }));
vi.mock('./_mcpRoomClient.js', async importOriginal => ({
  ...await importOriginal<typeof import('./_mcpRoomClient.js')>(),
  getRoom: mocks.room,
  sweepRoom: mocks.room,
  listMessages: mocks.messages,
  getSpeakingTurn: mocks.turn,
  setListenUntil: async () => {},
}));
import { callTool } from './_mcpTools.js';

const room: Room = {
  code: 'AAA-BBB-CCC', topic: '', createdAt: 0, createdBy: 'host', status: 'active', version: 1, replyMode: 'sequential',
  participants: ['Lead', 'Peer'].map((name, i) => ({ name, client: 'cc', role: '', color: '#fff', initials: 'XX', joinedAt: i, lastSeenAt: Date.now() })),
};
const msg = { id: 1, type: 'msg', name: 'Lead', client: 'cc', text: 'The opening answer.', time: Date.now(), color: '#fff', initials: 'XX', role: '' };
const read = async (over: Record<string, unknown> = {}) => {
  const result = await callTool({} as never, 'core', 'room_listen', { code: room.code, name: 'Peer', since: 0, wakeOn: 'addressed', timeoutMs: 1000, ...over });
  return JSON.parse((result.content[0] as { text: string }).text);
};

describe('MCP speaking entitlement', () => {
  beforeEach(() => {
    mocks.room.mockReset().mockResolvedValue(room);
    mocks.messages.mockReset().mockResolvedValue([msg]);
    mocks.turn.mockReset().mockResolvedValue({ mode: 'sequential', round: 1, role: 'supplement', isLead: false });
  });
  it('wakes an addressed-only listener for a plain peer reply granting its floor', async () => {
    const result = await read();
    expect(result.addressedYou).toBe(true);
    expect(result.yourTurn).toMatchObject({ mode: 'sequential', round: 1, role: 'supplement', isLead: false });
    expect(result.hint).toContain('YOUR TURN');
    expect(result.yourTurn.do).toContain('__no_addition__');
  });
  it('does not treat unrelated peer chatter as addressed without a floor', async () => {
    mocks.turn.mockResolvedValue(null);
    const result = await read();
    expect(result.addressedYou).toBeUndefined();
    expect(result.yourTurn).toBeUndefined();
    expect(mocks.turn).toHaveBeenCalledTimes(2); // first batch, then final fresh read
  });
  it('rechecks a held batch when grace or timeout changes the floor without new messages', async () => {
    vi.useFakeTimers();
    try {
      mocks.turn.mockResolvedValueOnce(null).mockResolvedValue({ mode: 'sequential', round: 1, role: 'supplement', isLead: false });
      const pending = read({ timeoutMs: 60000 });
      await vi.advanceTimersByTimeAsync(20000);
      const result = await pending;
      expect(result.addressedYou).toBe(true);
      expect(result.yourTurn.role).toBe('supplement');
    } finally { vi.useRealTimers(); }
  });
  it('briefs non-blocking history reads with policy and floor', async () => {
    const result = await read({ timeoutMs: 0 });
    expect(result.yourTurn.role).toBe('supplement');
    expect(result.roomPolicy).toContain('first peer pass');
    expect(result.hint).toContain('YOUR TURN');
  });
  it('briefs a moderator as the coordinator even when isLead is false', async () => {
    mocks.room.mockResolvedValue({ ...room, replyMode: 'moderator', modeConfig: { moderatorAgentName: 'Peer', moderatorAgentClient: 'cc' } });
    mocks.turn.mockResolvedValue({ mode: 'moderator', round: 1, role: 'moderator', isLead: false });
    expect((await read()).yourTurn.do).toContain('YOUR TURN AS MODERATOR');
  });
  it('does not surface a stale floor after a simultaneous turn advance', async () => {
    mocks.turn.mockResolvedValueOnce({ mode: 'sequential', round: 1, role: 'supplement', isLead: false }).mockResolvedValue(null);
    expect((await read()).yourTurn).toBeUndefined();
  });
  it('does not surface floor data in an ended room', async () => {
    mocks.room.mockResolvedValue({ ...room, status: 'ended' });
    const result = await read();
    expect(result.listenStatus).toBe('ended');
    expect(result.yourTurn).toBeUndefined();
  });
});
