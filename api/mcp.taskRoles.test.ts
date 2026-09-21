// room_task stamped ownerClient/verifierClient as 'cc' on create and reassign,
// reasoning from the caller rather than from the roster: an MCP agent is
// calling, so whoever it names must be an agent too.
//
// ED9-FKF-4SK, 2026-09-08. The room's only agent was told the human host could
// hold the verifier role, did exactly that, and the task was written down as
// `verifier: "Robin", verifierClient: "cc"`. verifyTask admits a ruling only
// when `task.verifierClient === undefined || task.verifierClient === verifier.client`,
// so Robin ruling from the web arrives as 'web', misses 'cc', and is refused as
// not the verifier. The task became unverifiable by its own designated verifier.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const room = {
  code: 'AAA-BBB-CCC',
  topic: 't',
  createdAt: 0,
  createdBy: 'Robin',
  status: 'active' as const,
  version: 1,
  replyMode: 'open' as const,
  participants: [
    { name: 'Robin', role: '', color: '#000', initials: 'RO', client: 'web' as const, joinedAt: 0, lastSeenAt: 0, canSpeak: true },
    { name: 'Codex', role: '', color: '#002', initials: 'CO', client: 'cc' as const, joinedAt: 2, lastSeenAt: 2, canSpeak: true },
  ],
};

vi.mock('./_mcpRoomClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_mcpRoomClient.js')>()),
  createRemoteRoomClient: () => ({}),
  getRoom: async () => room,
}));

const post = vi.fn();
const client = { post } as never;

const task = async (args: Record<string, unknown>) => {
  const { callTool } = await import('./_mcpTools.js');
  await callTool(client, 'full', 'room_task', { code: room.code, name: 'Codex', ...args });
  return post.mock.calls[0]![0] as Record<string, unknown>;
};

describe('room_task role client kinds', () => {
  beforeEach(() => { post.mockReset(); post.mockResolvedValue({ board: { code: room.code, tasks: [], version: 1 }, task: {} }); });

  it('records a human verifier as web, not as an agent', async () => {
    const sent = await task({ action: 'create', title: 'Analyze project', owner: 'Codex', verifier: 'Robin' });
    expect(sent.ownerClient).toBe('cc');
    // The whole point: 'cc' here is what made the task unverifiable.
    expect(sent.verifierClient).toBe('web');
  });

  it('records an agent verifier as cc', async () => {
    room.participants.push({ name: 'Claude', role: '', color: '#003', initials: 'CL', client: 'cc' as const, joinedAt: 3, lastSeenAt: 3, canSpeak: true });
    try {
      const sent = await task({ action: 'create', title: 'x', owner: 'Codex', verifier: 'Claude' });
      expect(sent.verifierClient).toBe('cc');
    } finally {
      room.participants.pop();
    }
  });

  // Both gates read a missing client as "match on name alone", so silence is the
  // honest answer for a name that is not in the room — a guess is not.
  it('omits the kind for a name that is not in the room', async () => {
    const sent = await task({ action: 'create', title: 'x', owner: 'Codex', verifier: 'Nobody' });
    expect(sent.ownerClient).toBe('cc');
    expect(sent).not.toHaveProperty('verifierClient');
  });

  it('resolves the same way on reassign', async () => {
    const sent = await task({ action: 'reassign', id: 'T-01', owner: 'Codex', verifier: 'Robin' });
    // The requester is the MCP caller, so that one really is 'cc'.
    expect(sent.requesterClient).toBe('cc');
    expect(sent.ownerClient).toBe('cc');
    expect(sent.verifierClient).toBe('web');
  });

  it('sends no role kinds when no roles are named', async () => {
    const sent = await task({ action: 'create', title: 'x' });
    expect(sent).not.toHaveProperty('ownerClient');
    expect(sent).not.toHaveProperty('verifierClient');
  });
});
