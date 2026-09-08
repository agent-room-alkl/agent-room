// `wakeOn: "addressed"` holds unaddressed traffic server-side and hands it back
// in one batch at timeout. The caller cannot tell that batch from an early
// return caused by someone actually calling on it — both arrive as "messages
// present" — so it used to guess, with `m.text.includes("@" + name)`.
//
// That guess is narrower than the server's own rule. wakesAgent also matches
// `metadata.targetAgentName`, which is how sequential and moderator modes hand
// out turns, with no literal "@name" in the text: an agent looping on the text
// match never woke for its own turn.
//
// And in a room with one agent the whole filter is wrong. It exists because a
// room has several agents and a message is about one of them; with one agent
// there is nobody else it could be for, and requiring an @ makes the room's
// only agent the one participant who must be named to answer a question asked
// directly to it. Observed 2026-09-08: three un-@'d messages got answers, and
// the fourth — the one request the agent could not fulfil — got silence.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const room = {
  code: 'AAA-BBB-CCC',
  topic: 't',
  createdAt: 0,
  createdBy: 'host',
  status: 'active' as const,
  version: 1,
  replyMode: 'open' as const,
  participants: [
    { name: 'host', role: '', color: '#000', initials: 'HO', client: 'web' as const, joinedAt: 0, lastSeenAt: 0, canSpeak: true },
    { name: 'Codex', role: '', color: '#002', initials: 'CO', client: 'cc' as const, joinedAt: 2, lastSeenAt: 2, canSpeak: true },
  ],
};

const listMessages = vi.fn();

vi.mock('./_mcpRoomClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_mcpRoomClient.js')>()),
  createRemoteRoomClient: () => ({}),
  getRoom: async () => room,
  sweepRoom: async () => room,
  setListenUntil: async () => {},
  listMessages: (...a: unknown[]) => listMessages(...a),
}));

const base = { id: 1, initials: 'HO', color: '#000', role: '', client: 'web' as const, time: 1 };
const body = (res: { content: unknown[] }) => JSON.parse((res.content[0] as { text: string }).text);

const listen = async (over: Record<string, unknown> = {}) => {
  const { callTool } = await import('./_mcpTools.js');
  return body(await callTool({} as never, 'full', 'room_listen', {
    code: room.code, name: 'Codex', since: 0, timeoutMs: 0, wakeOn: 'addressed', ...over,
  }));
};

const claude = { name: 'Claude', role: '', color: '#003', initials: 'CL', client: 'cc' as const, joinedAt: 3, lastSeenAt: 3, canSpeak: true };

describe('addressedYou', () => {
  beforeEach(() => { listMessages.mockReset(); listMessages.mockResolvedValue([]); });

  it('is set when the text @-mentions the agent', async () => {
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: '@Codex please review' }]);
    expect((await listen({ timeoutMs: 1000 })).addressedYou).toBe(true);
  });

  // The half a text match cannot see. A turn grant or an assignment names the
  // agent in metadata, not in the sentence.
  it('is set when only metadata.targetAgentName names the agent', async () => {
    listMessages.mockResolvedValue([{
      ...base, type: 'sys', name: 'system', text: 'Your turn.',
      metadata: { targetAgentName: 'Codex' },
    }]);
    const res = await listen({ timeoutMs: 1000 });
    expect(res.addressedYou).toBe(true);
    expect(res.messages[0].text).not.toContain('@Codex');
  });

  it('treats a plain human message as addressed when you are the only agent', async () => {
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: 'analyse this project' }]);
    expect((await listen({ timeoutMs: 1000 })).addressedYou).toBe(true);
  });

  it('restores the @ filter once a second agent is in the room', async () => {
    room.participants.push(claude);
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: 'analyse this project' }]);
    try {
      expect((await listen({ timeoutMs: 1000 })).addressedYou).toBeUndefined();
    } finally {
      room.participants.pop();
    }
  });

  // Board and moderator events name their target in metadata. Waking a sole
  // agent on every sys line would have it answering the room's own bookkeeping.
  it('does not wake a sole agent on unaddressed sys lines', async () => {
    listMessages.mockResolvedValue([{ ...base, type: 'sys', name: 'system', text: 'Claude joined the room.' }]);
    expect((await listen({ timeoutMs: 1000 })).addressedYou).toBeUndefined();
  });

  it('does not wake a sole agent on its own message', async () => {
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'Codex', text: '[STATUS] listening' }]);
    expect((await listen({ timeoutMs: 1000 })).addressedYou).toBeUndefined();
  });

  // "Somebody else" has to exist for this to be the case it claims to be.
  it('is absent for room traffic aimed at somebody else', async () => {
    room.participants.push(claude);
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: '@Claude what do you think' }]);
    const res = await listen({ timeoutMs: 1000 }).finally(() => room.participants.pop());
    expect(res.addressedYou).toBeUndefined();
    // Not dropped — held and handed over, so the agent can still choose to add
    // value, which room policy explicitly allows.
    expect(res.messages).toHaveLength(1);
  });

  it('is absent on wakeOn "any", where every message returns early anyway', async () => {
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: '@Codex hello' }]);
    expect((await listen({ wakeOn: 'any', timeoutMs: 1000 })).addressedYou).toBeUndefined();
  });

  it('is absent on a quiet hold', async () => {
    const res = await listen({ timeoutMs: 1000 });
    expect(res.addressedYou).toBeUndefined();
    expect(res.messages).toEqual([]);
  });
});
