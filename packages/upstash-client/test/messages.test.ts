import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, Room } from '@agent-room/shared';
import { MAX_MESSAGES_PER_ROOM, ROOM_TTL_SECONDS } from '@agent-room/shared';
import { createClient, appendMessage, listMessages, NotApprovedError, NotYourTurnError } from '../src/index.js';

const ENV = { url: 'https://example.upstash.io', token: 't' };
function mockResp(body: unknown) { return new Response(JSON.stringify(body)); }

const MSG: Message = {
  id: 1, type: 'msg', name: 'A', initials: 'AA', color: '#111',
  role: 'r', text: 'hi', client: 'web', time: 1,
};

const APPROVED_ROOM: Room = {
  code: 'ABC-DEF-GHJ', topic: 't', createdAt: 0, createdBy: 'host', status: 'active', version: 1,
  participants: [
    { name: 'A', role: 'r', color: '#111', initials: 'AA', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
  ],
};

describe('appendMessage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('RPUSHes + INCRs the absolute counter, LTRIMs to the cap, and pins TTL on both keys', async () => {
    const fetchMock = vi.fn()
      // First call: getRoom (speak gate check)
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(APPROVED_ROOM) }))
      // Second call: pipeline (RPUSH+INCR+LTRIM+EXPIREAT×2)
      .mockResolvedValueOnce(mockResp([
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    await appendMessage(client, 'ABC-DEF-GHJ', MSG);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1]!; // pipeline call
    const cmds = JSON.parse((init as any).body);
    expect(cmds).toHaveLength(5);
    expect(cmds[0][0]).toBe('RPUSH');
    expect(cmds[0][1]).toBe('room-msgs:ABC-DEF-GHJ');
    // appendMessage enriches every message with reply-mode metadata. In an
    // 'open' room (legacy default) that's a fixed-shape stamp recording the
    // mode + role at send time. The original MSG fields must still all
    // be present, just with `metadata` added.
    expect(JSON.parse(cmds[0][2])).toEqual({
      ...MSG,
      metadata: {
        modeAtSend: 'open',
        roleAtSend: 'open',
        invocationType: 'normal_turn',
      },
    });
    expect(cmds[1][0]).toBe('INCR');
    expect(cmds[1][1]).toBe('room-msg-count:ABC-DEF-GHJ');
    expect(cmds[2][0]).toBe('LTRIM');
    expect(cmds[2][2]).toBe(-MAX_MESSAGES_PER_ROOM);
    expect(cmds[2][3]).toBe(-1);
    // EXPIREAT pins both keys to a fixed deadline (room.createdAt + TTL).
    // APPROVED_ROOM.createdAt is 0, so the deadline is exactly ROOM_TTL_SECONDS.
    expect(cmds[3][0]).toBe('EXPIREAT');
    expect(cmds[3][1]).toBe('room-msgs:ABC-DEF-GHJ');
    expect(cmds[3][2]).toBe(ROOM_TTL_SECONDS);
    expect(cmds[4][0]).toBe('EXPIREAT');
    expect(cmds[4][1]).toBe('room-msg-count:ABC-DEF-GHJ');
    expect(cmds[4][2]).toBe(ROOM_TTL_SECONDS);
  });

  it('coerces a missing text field to "" before persisting', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(APPROVED_ROOM) }))
      .mockResolvedValueOnce(mockResp([
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const { text: _dropped, ...textless } = MSG;
    const client = createClient(ENV);
    await appendMessage(client, 'ABC-DEF-GHJ', textless as Message);

    const [, init] = fetchMock.mock.calls[1]!;
    const cmds = JSON.parse((init as any).body);
    expect(JSON.parse(cmds[0][2]).text).toBe('');
  });

  it('throws NotApprovedError when the sender is pending host approval', async () => {
    const pendingRoom: Room = {
      ...APPROVED_ROOM,
      participants: [
        { ...APPROVED_ROOM.participants[0]!, canSpeak: false },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp({ result: JSON.stringify(pendingRoom) })));
    const client = createClient(ENV);
    await expect(appendMessage(client, 'ABC-DEF-GHJ', MSG)).rejects.toBeInstanceOf(NotApprovedError);
  });

  it('throws NotApprovedError when the sender is not in the participants list', async () => {
    const emptyRoom: Room = { ...APPROVED_ROOM, participants: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp({ result: JSON.stringify(emptyRoom) })));
    const client = createClient(ENV);
    await expect(appendMessage(client, 'ABC-DEF-GHJ', MSG)).rejects.toBeInstanceOf(NotApprovedError);
  });
});

describe('appendMessage — moderator-mode status updates', () => {
  beforeEach(() => vi.restoreAllMocks());

  const FAR_FUTURE = 9_999_999_999_999;

  // A moderator-mode room with a Moderator agent and a non-moderator worker
  // agent. Both are approved cc-client participants.
  const MOD_ROOM: Room = {
    code: 'MOD-ROO-M01', topic: 't', createdAt: 0, createdBy: 'host',
    status: 'active', version: 1,
    replyMode: 'moderator',
    modeConfig: { moderatorAgentName: 'Mod', moderatorAgentClient: 'cc' },
    participants: [
      { name: 'host', role: '', color: '#111', initials: 'HO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
      { name: 'Mod', role: '', color: '#222', initials: 'MO', client: 'cc', joinedAt: 10, lastSeenAt: 10, canSpeak: true },
      { name: 'Worker', role: '', color: '#333', initials: 'WO', client: 'cc', joinedAt: 20, lastSeenAt: 20, canSpeak: true },
    ],
  };

  // Active moderator turn — the Moderator holds the floor.
  const MOD_TURN = {
    turnId: 7777, mode: 'moderator',
    moderatorName: 'Mod', moderatorClient: 'cc',
    currentName: 'Mod', currentClient: 'cc', currentRole: 'moderator',
    deadline: FAR_FUTURE, queue: [], spoken: [],
  };

  const WORKER_MSG: Message = {
    id: 5, type: 'msg', name: 'Worker', initials: 'WO', color: '#333',
    role: '', text: '收到，正在做', client: 'cc', time: 5,
  };

  it('lets a non-moderator agent post a status update without holding the turn', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(MOD_ROOM) }))      // getRoom
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(MOD_TURN) }))      // getTurnState
      .mockResolvedValueOnce(mockResp({ result: 'OK' }))                          // setTurnState
      .mockResolvedValueOnce(mockResp([                                          // rpush pipeline
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const result = await appendMessage(client, 'MOD-ROO-M01', WORKER_MSG);

    // The message is appended (not swallowed) and tagged as a status update.
    expect(result.appended).toBe(true);
    expect(result.metadata).toEqual({
      modeAtSend: 'moderator',
      roleAtSend: 'status',
      invocationType: 'status_update',
      turnId: 7777,
    });

    // The RPUSHed message carries the same status-update metadata.
    const pipelineCall = fetchMock.mock.calls[3]!;
    const cmds = JSON.parse((pipelineCall[1] as any).body);
    expect(cmds[0][0]).toBe('RPUSH');
    expect(JSON.parse(cmds[0][2]).metadata).toEqual({
      modeAtSend: 'moderator',
      roleAtSend: 'status',
      invocationType: 'status_update',
      turnId: 7777,
    });

    // The turn state written back is UNCHANGED — the Moderator still holds
    // the floor; a status update never consumes a turn slot.
    const setCall = fetchMock.mock.calls[2]!;
    const setCmd = JSON.parse((setCall[1] as any).body);
    expect(setCmd[0]).toBe('SET');
    const persistedTurn = JSON.parse(setCmd[2]);
    expect(persistedTurn.currentName).toBe('Mod');
    expect(persistedTurn.currentRole).toBe('moderator');
    expect(persistedTurn.queue).toEqual([]);
    expect(persistedTurn.spoken).toEqual([]);
  });

  it('still gates non-current agents in sequential mode (status channel is moderator-only)', async () => {
    const seqRoom: Room = {
      ...MOD_ROOM, code: 'SEQ-ROO-M01', replyMode: 'sequential',
      modeConfig: { leadAgentName: 'Mod', leadAgentClient: 'cc' },
    };
    const seqTurn = {
      turnId: 8888, mode: 'sequential',
      leadName: 'Mod', leadClient: 'cc',
      currentName: 'Mod', currentClient: 'cc', currentRole: 'lead',
      deadline: FAR_FUTURE, leadGraceUntil: FAR_FUTURE, queue: [], spoken: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(seqRoom) }))   // getRoom
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(seqTurn) }));  // getTurnState
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    await expect(
      appendMessage(client, 'SEQ-ROO-M01', { ...WORKER_MSG }),
    ).rejects.toBeInstanceOf(NotYourTurnError);
  });
});

describe('appendMessage — sequential status heartbeat', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renews the current sequential speaker deadline on a kind=status ping', async () => {
    const now = Date.now();
    const seqRoom: Room = {
      code: 'SEQ-HBT-001', topic: 't', createdAt: 0, createdBy: 'host',
      status: 'active', version: 1,
      replyMode: 'sequential',
      modeConfig: { leadAgentName: 'Lead', leadAgentClient: 'cc' },
      participants: [
        { name: 'host', role: '', color: '#111', initials: 'HO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
        { name: 'Lead', role: '', color: '#222', initials: 'LE', client: 'cc', joinedAt: 10, lastSeenAt: 10, canSpeak: true },
      ],
    };
    // Lead is the current speaker with a deadline that's still in the future
    // (so advanceOnTimeout doesn't skip them before the heartbeat is seen).
    const seqTurn = {
      turnId: 5000, mode: 'sequential',
      leadName: 'Lead', leadClient: 'cc',
      currentName: 'Lead', currentClient: 'cc', currentRole: 'lead',
      deadline: now + 5_000, hardDeadline: now + 600_000, queue: [], spoken: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(seqRoom) }))   // getRoom
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(seqTurn) }))   // getTurnState
      .mockResolvedValueOnce(mockResp({ result: 'OK' }))                      // setTurnState
      .mockResolvedValueOnce(mockResp([
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const leadMsg: Message = {
      id: 5, type: 'msg', name: 'Lead', initials: 'LE', color: '#222',
      role: '', text: 'still running the build', client: 'cc', time: 5,
    };
    const result = await appendMessage(client, 'SEQ-HBT-001', leadMsg, 'status');

    // The ping is appended as a status message and flagged as a renewal.
    expect(result.appended).toBe(true);
    expect(result.metadata.roleAtSend).toBe('status');
    expect(result.metadata.invocationType).toBe('status_update');
    expect(result.metadata.extendsTurn).toBe(true);

    // The turn did NOT advance — Lead keeps the floor, queue/spoken untouched
    // — and the deadline was pushed forward by the heartbeat.
    const setCmd = JSON.parse((fetchMock.mock.calls[2]![1] as any).body);
    expect(setCmd[0]).toBe('SET');
    const persisted = JSON.parse(setCmd[2]);
    expect(persisted.currentName).toBe('Lead');
    expect(persisted.currentRole).toBe('lead');
    expect(persisted.spoken).toEqual([]);
    expect(persisted.deadline).toBeGreaterThan(seqTurn.deadline);
  });
});

describe('listMessages', () => {
  beforeEach(() => vi.restoreAllMocks());

  // Helper: mock the GET-count + LLEN pipeline that listMessages issues first,
  // then the LRANGE that follows.
  function mockListMessagesFlow(opts: {
    countRaw: string | number | null;
    listLen: number;
    rangeResult: string[];
  }) {
    return vi.fn()
      .mockResolvedValueOnce(mockResp([
        { result: opts.countRaw },
        { result: opts.listLen },
      ]))
      .mockResolvedValueOnce(mockResp({ result: opts.rangeResult }));
  }

  it('uses GET-count + LLEN to compute LRANGE start, then parses the range', async () => {
    const msg1: Message = { id: 1, type: 'msg', name: 'A', initials: 'AA', color: '#111', role: '', text: 'hi', client: 'web', time: 1 };
    const msg2: Message = { ...msg1, id: 2, text: 'yo' };
    // Room has 7 messages ever appended, list currently holds 7 (no LTRIM yet).
    // Caller's cursor=5 → start = 5 - (7 - 7) = 5.
    const fetchMock = mockListMessagesFlow({
      countRaw: '7',
      listLen: 7,
      rangeResult: [JSON.stringify(msg1), JSON.stringify(msg2)],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const got = await listMessages(client, 'ABC-DEF-GHJ', 5);
    expect(got).toEqual([msg1, msg2]);

    // Sanity: the LRANGE call we issued used start=5, end=-1.
    const [, rangeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((rangeInit as any).body)).toEqual(['LRANGE', 'room-msgs:ABC-DEF-GHJ', 5, -1]);
  });

  it('returns [] when the list is empty (skips LRANGE entirely)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp([{ result: null }, { result: 0 }]));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient(ENV);
    expect(await listMessages(client, 'ABC-DEF-GHJ', 0)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // metadata only, no LRANGE
  });

  it('heals a stored message with no text (crashed every web viewer of the room)', async () => {
    // Regression: an older MCP client posted a status_update with no `text`
    // field. Persisted verbatim, it crashed the room page for every viewer
    // ("Cannot read properties of undefined (reading 'length')" in Bubble).
    const { text: _dropped, ...textless } = MSG;
    const fetchMock = mockListMessagesFlow({
      countRaw: '1',
      listLen: 1,
      rangeResult: [JSON.stringify(textless)],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const got = await listMessages(client, 'ABC-DEF-GHJ', 0);
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe('');
  });

  it('legacy room (no count key): falls back to using fromIndex as a list-index', async () => {
    // Pre-fix room — counter never INCRed. listMessages must not break, just
    // behave like the old code would (LRANGE fromIndex -1).
    const fetchMock = mockListMessagesFlow({
      countRaw: null,
      listLen: 100,
      rangeResult: [],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    await listMessages(client, 'XYZ-123-ABC', 42);

    const [, rangeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((rangeInit as any).body)).toEqual(['LRANGE', 'room-msgs:XYZ-123-ABC', 42, -1]);
  });

  // Regression test for the LTRIM cursor-drift bug. Before the fix:
  //   list had 499 entries → +2 RPUSH → list=501 → LTRIM keeps last 500
  //   → first new message is now at index 498, second at 499
  //   → an agent at cursor=499 LRANGE 499 -1 returns ONE message instead of two
  //   → first new message silently lost
  // After the fix the counter compensates the offset and the agent gets BOTH.
  it('LTRIM cursor-drift regression: returns ALL unread messages even after head was trimmed', async () => {
    const newMsg1: Message = { id: 9001, type: 'msg', name: 'A', initials: 'AA', color: '#111', role: '', text: 'first-new', client: 'web', time: 9001 };
    const newMsg2: Message = { ...newMsg1, id: 9002, text: 'second-new', time: 9002 };

    // totalCount = 501 (499 old + 2 new), listLen = 500 (LTRIM dropped 1 head entry).
    // Caller's cursor = 499 (had read all 499 originals).
    // Correct start = 499 - (501 - 500) = 498. LRANGE 498 -1 → both new messages.
    const fetchMock = mockListMessagesFlow({
      countRaw: '501',
      listLen: 500,
      rangeResult: [JSON.stringify(newMsg1), JSON.stringify(newMsg2)],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const got = await listMessages(client, 'ABC-DEF-GHJ', 499);

    expect(got).toEqual([newMsg1, newMsg2]); // would have been [newMsg2] under the old code

    const [, rangeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((rangeInit as any).body)).toEqual(['LRANGE', 'room-msgs:ABC-DEF-GHJ', 498, -1]);
  });

  it('cursor far behind LTRIM horizon: clamps start to 0 and hands back surviving prefix', async () => {
    // Cursor 50 but 200 head entries have already been LTRIMmed away. start
    // would be 50 - 200 = -150, which we clamp to 0. The very-old messages
    // are unrecoverable (LTRIM is destructive — see msgsKey comment).
    const fetchMock = mockListMessagesFlow({
      countRaw: '700',
      listLen: 500,
      rangeResult: [],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    await listMessages(client, 'ABC-DEF-GHJ', 50);

    const [, rangeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((rangeInit as any).body)).toEqual(['LRANGE', 'room-msgs:ABC-DEF-GHJ', 0, -1]);
  });

  it('cursor at or past totalCount: skips LRANGE and returns []', async () => {
    // start = 700 - (700 - 500) = 500; listLen = 500 → start >= listLen → [].
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp([{ result: '700' }, { result: 500 }]));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient(ENV);
    expect(await listMessages(client, 'ABC-DEF-GHJ', 700)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no LRANGE issued
  });
});
