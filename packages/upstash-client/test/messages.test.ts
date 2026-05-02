import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, Room } from '@agent-room/shared';
import { MAX_MESSAGES_PER_ROOM, ROOM_TTL_SECONDS } from '@agent-room/shared';
import { createClient, appendMessage, listMessages, NotApprovedError } from '../src/index.js';

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

  it('RPUSHes + INCRs the absolute counter, LTRIMs to the cap, and refreshes TTL on both keys', async () => {
    const fetchMock = vi.fn()
      // First call: getRoom (speak gate check)
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(APPROVED_ROOM) }))
      // Second call: pipeline (RPUSH+INCR+LTRIM+EXPIRE×2)
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
    expect(JSON.parse(cmds[0][2])).toEqual(MSG);
    expect(cmds[1][0]).toBe('INCR');
    expect(cmds[1][1]).toBe('room-msg-count:ABC-DEF-GHJ');
    expect(cmds[2][0]).toBe('LTRIM');
    expect(cmds[2][2]).toBe(-MAX_MESSAGES_PER_ROOM);
    expect(cmds[2][3]).toBe(-1);
    expect(cmds[3][0]).toBe('EXPIRE');
    expect(cmds[3][1]).toBe('room-msgs:ABC-DEF-GHJ');
    expect(cmds[3][2]).toBe(ROOM_TTL_SECONDS);
    expect(cmds[4][0]).toBe('EXPIRE');
    expect(cmds[4][1]).toBe('room-msg-count:ABC-DEF-GHJ');
    expect(cmds[4][2]).toBe(ROOM_TTL_SECONDS);
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
