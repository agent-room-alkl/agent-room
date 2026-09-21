// "Codex only answers when you @ it, in every mode" — reported 2026-09-08.
//
// The listen loop decided client-side what counted as being addressed, with
// `m.text.includes("@" + name)`. The server's wakesAgent is wider: it also
// matches metadata.targetAgentName, which is how sequential and moderator modes
// hand out turns — no literal "@name" anywhere in the text. So an agent looping
// on the text match never woke for its own turn.
//
// The caller cannot derive this. It also cannot tell an early return (someone
// addressed me) from a held batch delivered at timeout (nobody did) — both
// arrive as "messages present". So the server says which.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const room = {
  code: 'AAA-BBB-CCC',
  topic: 't',
  createdAt: 0,
  createdBy: 'host',
  status: 'active' as const,
  version: 1,
  replyMode: 'open' as 'open' | 'sequential' | 'moderator' | 'consensus' | 'debate',
  modeConfig: undefined as undefined | { moderatorAgentName: string; moderatorAgentClient: 'cc' },
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

  // "Somebody else" has to exist for this to be the case it claims to be: with
  // one agent in the room every human message is addressed, so the roster gets
  // a second agent here rather than the assertion getting weakened.
  it('broadcasts host speech to every agent in open mode, even when one is mentioned', async () => {
    room.participants.push({ name: 'Claude', role: '', color: '#003', initials: 'CL', client: 'cc', joinedAt: 3, lastSeenAt: 3, canSpeak: true });
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: '@Claude what do you think' }]);
    const res = await listen({ timeoutMs: 1000 }).finally(() => room.participants.pop());
    expect(res.addressedYou).toBe(true);
    expect(res.messages).toHaveLength(1);
  });

  it('is absent on wakeOn "any", where every message returns early anyway', async () => {
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: '@Codex hello' }]);
    expect((await listen({ wakeOn: 'any', timeoutMs: 1000 })).addressedYou).toBeUndefined();
  });

  // ED9-FKF-4SK, 2026-09-08: one human, one agent, open mode. "anaylis this
  // project and give me a summary in word" arrived with no @, so it came through
  // the branch that says "saying nothing is a fine answer" — and the agent said
  // nothing for 2m48s, then a generic status line. There was no other agent it
  // could have been for.
  it('treats a plain human message as addressed when you are the only agent', async () => {
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: 'anaylis this project' }]);
    expect((await listen({ timeoutMs: 1000 })).addressedYou).toBe(true);
  });

  it('keeps plain host speech as a broadcast when a second agent joins', async () => {
    room.participants.push({ name: 'Claude', role: '', color: '#003', initials: 'CL', client: 'cc', joinedAt: 3, lastSeenAt: 3, canSpeak: true });
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: 'anaylis this project' }]);
    try {
      expect((await listen({ timeoutMs: 1000 })).addressedYou).toBe(true);
    } finally {
      room.participants.pop();
    }
  });

  it.each(['sequential', 'consensus', 'debate'] as const)(
    'broadcasts plain host speech to every agent in %s mode',
    async (mode) => {
      room.participants.push({ name: 'Claude', role: '', color: '#003', initials: 'CL', client: 'cc', joinedAt: 3, lastSeenAt: 3, canSpeak: true });
      room.replyMode = mode;
      listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: 'continue the work' }]);
      try {
        expect((await listen({ timeoutMs: 1000 })).addressedYou).toBe(true);
      } finally {
        room.replyMode = 'open';
        room.participants.pop();
      }
    },
  );

  it('routes plain host speech only to the moderator in moderator mode', async () => {
    room.participants.push({ name: 'Claude', role: '', color: '#003', initials: 'CL', client: 'cc', joinedAt: 3, lastSeenAt: 3, canSpeak: true });
    room.replyMode = 'moderator';
    room.modeConfig = { moderatorAgentName: 'Claude', moderatorAgentClient: 'cc' };
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: 'continue' }]);
    try {
      expect((await listen({ timeoutMs: 1000 })).addressedYou).toBeUndefined();
    } finally {
      room.replyMode = 'open';
      room.modeConfig = undefined;
      room.participants.pop();
    }
  });

  it('still wakes a specifically mentioned member in moderator mode', async () => {
    room.participants.push({ name: 'Claude', role: '', color: '#003', initials: 'CL', client: 'cc', joinedAt: 3, lastSeenAt: 3, canSpeak: true });
    room.replyMode = 'moderator';
    room.modeConfig = { moderatorAgentName: 'Claude', moderatorAgentClient: 'cc' };
    listMessages.mockResolvedValue([{ ...base, type: 'msg', name: 'host', text: '@Codex verify T-01' }]);
    try {
      expect((await listen({ timeoutMs: 1000 })).addressedYou).toBe(true);
    } finally {
      room.replyMode = 'open';
      room.modeConfig = undefined;
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

  it('is absent on a quiet hold', async () => {
    const res = await listen({ timeoutMs: 1000 });
    expect(res.addressedYou).toBeUndefined();
    expect(res.messages).toEqual([]);
  });
});
