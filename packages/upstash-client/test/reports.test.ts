import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, Room } from '@agent-room/shared';
import { createClient, createRoomReport, getRoomReport, buildRoomReport, REPORT_RETENTION, REPORT_TTL_SECONDS } from '../src/index.js';
import type { TaskBoard } from '@agent-room/shared';

const ENV = { url: 'https://example.upstash.io', token: 't' };

function mockResp(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function sampleRoom(): Room {
  return {
    code: 'ABC-DEF-GHJ',
    topic: 'Ship report assets',
    createdAt: 1,
    createdBy: 'Robin',
    ownerId: 'user_robin',
    ownerEmail: 'robin@example.com',
    ownerName: 'Robin',
    status: 'ended',
    version: 2,
    participants: [
      { name: 'Robin', role: 'Facilitator', color: '#F59E0B', initials: 'RO', client: 'web', joinedAt: 1, lastSeenAt: 2, canSpeak: true },
      { name: 'Codex', role: 'Platform', color: '#5B6AFF', initials: 'CO', client: 'cc', joinedAt: 1, lastSeenAt: 2, canSpeak: true },
    ],
  };
}

function sampleMessages(): Message[] {
  return [
    {
      id: 10,
      type: 'msg',
      name: 'Codex',
      role: 'Platform',
      text: '[DECISION] Store exported reports as permanent share assets.',
      time: 3,
      client: 'cc',
    },
  ];
}

describe('reports', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('documents exported report retention as 1 day (same lifetime as the room)', () => {
    expect(REPORT_RETENTION).toBe('1d');
  });

  it('stores exported reports with a 24-hour Redis TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResp({ result: null }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const report = await createRoomReport(client, sampleRoom(), sampleMessages());

    expect(report.code).toBe('ABC-DEF-GHJ');
    expect(report.ownerId).toBe('user_robin');
    const setCall = fetchMock.mock.calls.find(([, init]) => {
      const cmd = JSON.parse((init as RequestInit).body as string);
      return cmd[0] === 'SET' && cmd[1] === 'room-report:ABC-DEF-GHJ';
    });
    expect(setCall).toBeTruthy();
    const [, init] = setCall!;
    const cmd = JSON.parse((init as RequestInit).body as string);
    expect(JSON.parse(cmd[2]).topic).toBe('Ship report assets');
    expect(JSON.parse(cmd[2]).ownerEmail).toBe('robin@example.com');
    expect(cmd[3]).toBe('EX');
    expect(cmd[4]).toBe(REPORT_TTL_SECONDS);
  });

  it('seeds report highlights and summary from verified-done task board tasks', () => {
    const board: TaskBoard = {
      code: 'ABC-DEF-GHJ',
      version: 2,
      tasks: [{
        id: 'T-01',
        title: 'Core data model',
        state: 'done',
        createdBy: 'Claude',
        createdAt: 1,
        updatedAt: 2,
        verdict: { verdict: 'done', by: 'GPT', byClient: 'cc', at: 2 },
        evidence: {
          fileListing: 'models.py\nmain.py',
          fileExcerpt: 'class Activity(Base): ...',
          runOutput: '1 passed in 0.12s',
          exitCode: 0,
          submittedBy: 'Qwen',
          submittedClient: 'cc',
          at: 1,
        },
      }],
    };
    const report = buildRoomReport(sampleRoom(), sampleMessages(), board);
    expect(report.summary).toContain('1 task(s) verified done on the task board (T-01)');
    expect(report.highlights[0]).toContain('Verified done: T-01: Core data model (verified by GPT) — models.py');
  });

  it('reads a previously exported report by code', async () => {
    const stored = {
      ...await createRoomReport(
        { command: vi.fn().mockResolvedValue('OK'), pipeline: vi.fn() },
        sampleRoom(),
        sampleMessages()
      ),
      exportedAt: 100,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp({ result: JSON.stringify(stored) })));

    const client = createClient(ENV);
    await expect(getRoomReport(client, 'ABC-DEF-GHJ')).resolves.toMatchObject({
      code: 'ABC-DEF-GHJ',
      topic: 'Ship report assets',
      exportedAt: 100,
    });
  });
});
