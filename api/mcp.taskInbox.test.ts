// The board notifies through the transcript — a sys message naming the agent on
// every action, plus a stall nudge — which reaches whoever is present and
// nobody else. A reconnect returns the last 16 messages and a digest, so a
// board event from hours ago is simply gone.
//
// RCC-FY5-75M, 2026-09-07: the agent that held one session tracked the board
// perfectly; the one that kept dropping out had T-02 and T-04 wait on it for
// just under four hours, its slot reassigned four times.
//
// taskInboxFor is unit-tested in packages/shared. What is tested here is the
// wiring — that join and listen actually ask, which no pure test can catch.

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
    { name: 'Bystander', role: '', color: '#003', initials: 'BY', client: 'cc' as const, joinedAt: 3, lastSeenAt: 3, canSpeak: true },
  ],
};

const listMessages = vi.fn();

vi.mock('./_mcpRoomClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_mcpRoomClient.js')>();
  return {
    ...actual,
    createRemoteRoomClient: () => ({}),
    getRoom: async () => room,
    sweepRoom: async () => room,
    setListenUntil: async () => {},
    joinRoom: async (_c: unknown, _code: string, p: { name: string }) => ({
      ...room,
      participant: room.participants.find(x => x.name === p.name && x.client === 'cc'),
    }),
    appendMessage: async () => ({ appended: true, metadata: { roleAtSend: 'status' } }),
    listMessages: (...args: unknown[]) => listMessages(...args),
  };
});

const BOARD = {
  tasks: [
    { id: 'T-02', title: 'a', state: 'awaiting_review', owner: 'Cursor Grok', verifier: 'Codex' },
    { id: 'T-04', title: 'b', state: 'awaiting_review', owner: 'Cursor Grok', verifier: 'Codex' },
    { id: 'T-08', title: 'c', state: 'in_progress', owner: 'Codex', verifier: 'Claude' },
    { id: 'T-01', title: 'd', state: 'done', owner: 'Codex', verifier: 'Claude' },
  ],
};

/** A client that answers the board read the way the real one does. */
const clientWithBoard = () => ({ post: vi.fn(async () => ({ board: BOARD })) }) as never;

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe('board inbox on join and listen', () => {
  beforeEach(() => { listMessages.mockReset(); listMessages.mockResolvedValue([]); });

  it('tells a joining agent what the board is holding for it', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const res = body(await callTool(clientWithBoard(), 'full', 'room_join', {
      code: room.code, name: 'Codex',
    }));

    expect(res.yourTasks).toMatchObject({ toVerify: ['T-02', 'T-04'], toDo: ['T-08'] });
    // The hint is what a weak client reads when it ignores everything else.
    expect(res.hint).toContain('T-02, T-04 are awaiting YOUR verdict');
    expect(res.hint).toContain('CURRENT WORK: T-08');
    // Structured work/review outranks the generic listen continuation.
    expect(res.nextAction).toMatchObject({
      required: true, kind: 'task_review', action: 'verify_task', taskId: 'T-02',
    });
  });

  it('says nothing when the board holds nothing for this agent', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const res = body(await callTool(clientWithBoard(), 'full', 'room_join', {
      code: room.code, name: 'Bystander',
    }));
    expect(res.yourTasks).toBeUndefined();
    expect(res.hint).not.toContain('BOARD:');
  });

  // The catch-up read is exactly when an agent that has been away is working
  // out what it missed.
  it('includes it in a non-blocking catch-up read', async () => {
    const { callTool } = await import('./_mcpTools.js');
    listMessages.mockResolvedValue([
      { id: 1, type: 'msg', name: 'host', text: '@Codex review please', client: 'web', time: 1 },
    ]);
    const res = body(await callTool(clientWithBoard(), 'full', 'room_listen', {
      code: room.code, since: 0, name: 'Codex', timeoutMs: 0,
    }));
    expect(res.yourTasks).toMatchObject({ toVerify: ['T-02', 'T-04'] });
    expect(res.hint).toContain('awaiting YOUR verdict');
    expect(res.nextAction).toMatchObject({ kind: 'task_review', taskId: 'T-02' });
  });

  it('repeats it on a blocking listen that woke the agent', async () => {
    const { callTool } = await import('./_mcpTools.js');
    listMessages.mockResolvedValue([
      { id: 1, type: 'msg', name: 'host', text: '@Codex review please', client: 'web', time: 1 },
    ]);
    const res = body(await callTool(clientWithBoard(), 'full', 'room_listen', {
      code: room.code, since: 0, name: 'Codex', timeoutMs: 1000,
    }));
    expect(res.yourTasks).toMatchObject({ toVerify: ['T-02', 'T-04'] });
    expect(res.hint).toContain('awaiting YOUR verdict');
    expect(res.nextAction).toMatchObject({ kind: 'task_review', taskId: 'T-02' });
  });

  it('makes active task execution the structured next action, not another listen', async () => {
    const { callTool } = await import('./_mcpTools.js');
    listMessages.mockResolvedValue([
      { id: 1, type: 'msg', name: 'host', text: '@Codex continue', client: 'web', time: 1 },
    ]);
    const activeOnly = {
      post: vi.fn(async () => ({
        board: { code: room.code, tasks: [{ id: 'T-12B', title: 'CRUD', state: 'in_progress', owner: 'Codex' }] },
      })),
    } as never;
    const res = body(await callTool(activeOnly, 'full', 'room_listen', {
      code: room.code, since: 0, name: 'Codex', timeoutMs: 1000, wakeOn: 'addressed',
    }));

    expect(res.nextAction).toMatchObject({
      required: true, kind: 'task_work', action: 'execute_task', taskId: 'T-12B',
    });
    expect(res.nextAction.instruction).toContain('do not call room_listen first');
    expect(res.hint).toContain('BOARD WORK OVERRIDES PRESENCE');
    expect(res.hint).not.toContain('NEXT (required): room_listen');
  });

  it('keeps active task execution ahead of listening after a status send', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const activeOnly = {
      post: vi.fn(async () => ({
        board: { code: room.code, tasks: [{ id: 'T-12B', title: 'CRUD', state: 'in_progress', owner: 'Codex' }] },
      })),
    } as never;
    const res = body(await callTool(activeOnly, 'full', 'room_send', {
      code: room.code, name: 'Codex', text: 'still working on T-12B', kind: 'status',
    }));

    expect(res.nextAction).toMatchObject({
      required: true, kind: 'task_work', action: 'execute_task', taskId: 'T-12B',
    });
    expect(res.nextAction.tool).toBeUndefined();
    expect(res.hint).toContain('CURRENT WORK: T-12B');
    expect(res.hint).not.toContain('NEXT (required): room_listen');
  });

  // The board was silent at the one moment it mattered: the room asks for work,
  // nothing is on the board, so yourTasks was omitted entirely and the only
  // guidance left was a tool description the agent would have had to look up.
  // ED9-FKF-4SK and FQ5-H8E-CXN, 2026-09-08.
  it('tells an addressed agent to open a task when the board is empty', async () => {
    const { callTool } = await import('./_mcpTools.js');
    listMessages.mockResolvedValue([
      { id: 1, type: 'msg', name: 'host', text: '@Codex analyse this project', client: 'web', time: 1 },
    ]);
    const emptyBoard = { post: vi.fn(async () => ({ board: { code: room.code, tasks: [], version: 0 } })) } as never;
    const res = body(await callTool(emptyBoard, 'full', 'room_listen', {
      code: room.code, since: 0, name: 'Codex', timeoutMs: 1000, wakeOn: 'addressed',
    }));
    expect(res.addressedYou).toBe(true);
    expect(res.yourTasks?.hint).toContain('nothing on the board is yours');
    expect(res.yourTasks?.hint).toContain('room_task({ action: "create", title, dod })');
  });

  // In open mode human speech is a broadcast even in a multi-agent room. The
  // speaking policy still decides who replies; wake routing must not hide the
  // host's request from the rest of the room.
  it('treats a host message as addressed to the whole open room', async () => {
    const { callTool } = await import('./_mcpTools.js');
    listMessages.mockResolvedValue([
      { id: 1, type: 'msg', name: 'host', text: '@Bystander your turn', client: 'web', time: 1 },
    ]);
    const emptyBoard = { post: vi.fn(async () => ({ board: { code: room.code, tasks: [], version: 0 } })) } as never;
    const res = body(await callTool(emptyBoard, 'full', 'room_listen', {
      code: room.code, since: 0, name: 'Codex', timeoutMs: 1000, wakeOn: 'addressed',
    }));
    expect(res.addressedYou).toBe(true);
    expect(res.yourTasks?.hint).toContain('nothing on the board is yours');
  });

  // A quiet hold is the hot path — it must not pay for a board read.
  it('leaves a quiet hold lean', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const client = clientWithBoard();
    const res = body(await callTool(client, 'full', 'room_listen', {
      code: room.code, since: 0, name: 'Codex', timeoutMs: 1000,
    }));
    expect(res.messages).toEqual([]);
    expect(res.yourTasks).toBeUndefined();
    expect((client as unknown as { post: ReturnType<typeof vi.fn> }).post).not.toHaveBeenCalled();
  });

  it('stays quiet on the core profile, which has no board tools', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const res = body(await callTool(clientWithBoard(), 'core', 'room_join', {
      code: room.code, name: 'Codex',
    }));
    expect(res.yourTasks).toBeUndefined();
  });

  // Failing to read the board must never cost someone their join.
  it('joins normally when the board read throws', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const broken = { post: () => { throw new Error('upstash down'); } } as never;
    const res = body(await callTool(broken, 'full', 'room_join', {
      code: room.code, name: 'Codex',
    }));
    expect(res.assignedName).toBe('Codex');
    expect(res.yourTasks).toBeUndefined();
  });
});
