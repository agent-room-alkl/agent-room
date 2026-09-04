import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PRESENCE_DISCONNECTED_MS, type Participant, type Room } from '@agent-room/shared';
import {
  createClient,
  createTask,
  claimTask,
  submitTask,
  submitForReview,
  updateTask,
  hostSetTaskState,
  getTaskBoard,
  openTasks,
  summarizeBoard,
  cancelTask,
  blockTask,
  boardHasNoOpenWork,
  isConfiguredModerator,
  isModeratorPresent,
  isParticipantStale,
  buildTaskSubmitStatusText,
  TaskStateError,
  TaskDoneImmutableError,
} from '../src/index.js';

const ENV = { url: 'https://example.upstash.io', token: 't' };
const CODE = 'ABC-DEF-GHJ';

// Same in-memory Upstash fake as tasks.test.ts: the CAS read-modify-write loop
// in tasks.ts has to actually round-trip against state for these to mean
// anything.
function installFakeRedis(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    const cmd = JSON.parse(init.body) as string[];
    const op = cmd[0];
    const key = cmd[1];
    let result: unknown = null;
    if (op === 'GET') result = store.has(key) ? store.get(key) : null;
    else if (op === 'SET') { store.set(key, cmd[2]); result = 'OK'; }
    else if (op === 'DEL') { result = store.delete(key) ? 1 : 0; }
    else if (op === 'EVAL') {
      const evalKey = cmd[3];
      const mode = cmd[4];
      const expected = cmd[5];
      const next = cmd[6];
      const cur = store.has(evalKey) ? store.get(evalKey) : undefined;
      const ok = mode === 'absent' ? cur === undefined : cur === expected;
      if (ok) { store.set(evalKey, next); result = 1; } else { result = 0; }
    }
    return new Response(JSON.stringify({ result }), { headers: { 'Content-Type': 'application/json' } });
  }));
  return store;
}

const FULL_EVIDENCE = {
  fileListing: 'models.py\nmain.py',
  fileExcerpt: 'class Activity(Base): ...',
  runOutput: '1 passed in 0.12s',
  exitCode: 0,
};

const ACTOR = { name: 'Claude', client: 'cc' as const };
const OWNER = { name: 'Qwen', client: 'cc' as const };

describe('cancelTask', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('archives a todo task to cancelled with an audit record', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'Duplicate', createdBy: 'Claude' });

    const { task: cancelled } = await cancelTask(client, CODE, task.id, ACTOR, '  wrong premise  ');
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.cancellation).toMatchObject({ by: 'Claude', byClient: 'cc', reason: 'wrong premise' });
  });

  it('omits the reason field entirely when none is given', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    const { task: cancelled } = await cancelTask(client, CODE, task.id, ACTOR);
    expect(cancelled.cancellation).toBeDefined();
    expect('reason' in cancelled.cancellation!).toBe(false);
  });

  it('refuses a task that already carries submitted evidence', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);

    await expect(cancelTask(client, CODE, task.id, ACTOR)).rejects.toBeInstanceOf(TaskStateError);
    const board = await getTaskBoard(client, CODE);
    expect(board!.tasks[0]!.state).toBe('awaiting_review');
  });

  it('refuses a task whose only evidence is a readiness note', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await submitForReview(client, CODE, task.id, OWNER, 'wrote the doc');

    await expect(cancelTask(client, CODE, task.id, ACTOR)).rejects.toBeInstanceOf(TaskStateError);
  });

  it('refuses to cancel twice, and refuses a done task', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await cancelTask(client, CODE, task.id, ACTOR);
    await expect(cancelTask(client, CODE, task.id, ACTOR)).rejects.toBeInstanceOf(TaskStateError);

    const { task: t2 } = await createTask(client, CODE, { title: 'Y', createdBy: 'Claude' });
    await hostSetTaskState(client, CODE, t2.id, 'done', 'Robin');
    await expect(cancelTask(client, CODE, t2.id, ACTOR)).rejects.toBeInstanceOf(TaskDoneImmutableError);
  });

  it('keeps cancelled terminal: no new submission can resurrect it', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await cancelTask(client, CODE, task.id, ACTOR);

    await expect(submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE)).rejects.toBeInstanceOf(TaskStateError);
    await expect(submitForReview(client, CODE, task.id, OWNER, 'done-ish')).rejects.toBeInstanceOf(TaskStateError);
    await expect(hostSetTaskState(client, CODE, task.id, 'todo', 'Robin')).rejects.toBeInstanceOf(TaskDoneImmutableError);

    const board = await getTaskBoard(client, CODE);
    expect(board!.tasks[0]!.state).toBe('cancelled');
  });

  it('can be reopened by the host escape hatch (updateTask), then submitted again', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await cancelTask(client, CODE, task.id, ACTOR);

    const { task: reopened } = await updateTask(client, CODE, task.id, { state: 'todo' });
    expect(reopened.state).toBe('todo');
    const { task: submitted } = await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    expect(submitted.state).toBe('awaiting_review');
  });

  it('drops the task out of openTasks and the board summary', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'Dead end', createdBy: 'Claude' });
    await createTask(client, CODE, { title: 'Real work', createdBy: 'Claude' });
    await cancelTask(client, CODE, task.id, ACTOR);

    const board = (await getTaskBoard(client, CODE))!;
    expect(openTasks(board).map(t => t.title)).toEqual(['Real work']);
    expect(summarizeBoard(board)).not.toContain('Dead end');
  });
});

describe('blockTask', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('moves todo/in_progress to blocked and records who and why', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'Deploy', createdBy: 'Claude' });
    await claimTask(client, CODE, task.id, OWNER);

    const { task: blocked } = await blockTask(client, CODE, task.id, OWNER, '  no prod credentials  ');
    expect(blocked.state).toBe('blocked');
    expect(blocked.blocked).toMatchObject({ by: 'Qwen', byClient: 'cc', reason: 'no prod credentials' });
  });

  it('requires a non-empty reason', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await expect(blockTask(client, CODE, task.id, OWNER, '   ')).rejects.toBeInstanceOf(TaskStateError);

    const board = await getTaskBoard(client, CODE);
    expect(board!.tasks[0]!.state).toBe('todo');
  });

  it('refuses any state other than todo / in_progress', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE); // awaiting_review

    await expect(blockTask(client, CODE, task.id, OWNER, 'stuck')).rejects.toBeInstanceOf(TaskStateError);
  });

  it('stays OPEN work — a blocked board is not a finished board', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await blockTask(client, CODE, task.id, OWNER, 'missing input file');

    const board = (await getTaskBoard(client, CODE))!;
    expect(openTasks(board)).toHaveLength(1);
    expect(boardHasNoOpenWork(board)).toBe(false);
    expect(summarizeBoard(board)).toContain('missing input file');
  });

  it('keeps the block record as history after a reopen', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await blockTask(client, CODE, task.id, OWNER, 'waiting on Robin');
    const { task: reopened } = await updateTask(client, CODE, task.id, { state: 'in_progress' });

    expect(reopened.state).toBe('in_progress');
    expect(reopened.blocked?.reason).toBe('waiting on Robin');
  });
});

describe('boardHasNoOpenWork', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('is false while anything is todo / in_progress / awaiting_review / blocked', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    expect(boardHasNoOpenWork((await getTaskBoard(client, CODE))!)).toBe(false);
  });

  it('is true for a board that is only done / rejected / cancelled', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task: a } = await createTask(client, CODE, { title: 'A', createdBy: 'Claude' });
    const { task: b } = await createTask(client, CODE, { title: 'B', createdBy: 'Claude' });
    const { task: c } = await createTask(client, CODE, { title: 'C', createdBy: 'Claude' });
    await hostSetTaskState(client, CODE, a.id, 'done', 'Robin');
    await hostSetTaskState(client, CODE, b.id, 'rejected', 'Robin');
    await cancelTask(client, CODE, c.id, ACTOR);

    expect(boardHasNoOpenWork((await getTaskBoard(client, CODE))!)).toBe(true);
  });

  it('is true for an empty board — nothing to do is not open work', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await cancelTask(client, CODE, task.id, ACTOR);
    const board = (await getTaskBoard(client, CODE))!;
    expect(boardHasNoOpenWork({ ...board, tasks: [] })).toBe(true);
  });
});

// ── Pure helpers: no Redis needed ────────────────────────────────────────────

function room(over: Partial<Room> = {}): Room {
  return {
    code: CODE,
    topic: 'T',
    createdBy: 'Robin',
    createdAt: 0,
    participants: [],
    ...over,
  } as unknown as Room;
}

function participant(over: Partial<Participant> = {}): Participant {
  return { name: 'Claude', client: 'cc', joinedAt: 0, lastSeenAt: 0, ...over } as unknown as Participant;
}

describe('isConfiguredModerator', () => {
  it('matches on name + client when both are configured', () => {
    const r = room({ modeConfig: { moderatorAgentName: 'Claude', moderatorAgentClient: 'cc' } });
    expect(isConfiguredModerator(r, 'Claude', 'cc')).toBe(true);
    expect(isConfiguredModerator(r, 'Claude', 'web')).toBe(false);
    expect(isConfiguredModerator(r, 'Cursor', 'cc')).toBe(false);
  });

  it('falls back to name-only for older rooms that carry no moderator client', () => {
    const r = room({ modeConfig: { moderatorAgentName: 'Claude' } });
    expect(isConfiguredModerator(r, 'Claude', 'cc')).toBe(true);
    expect(isConfiguredModerator(r, 'Claude', 'web')).toBe(true);
  });

  it('is false when no moderator is configured at all', () => {
    expect(isConfiguredModerator(room(), 'Claude', 'cc')).toBe(false);
    expect(isConfiguredModerator(room({ modeConfig: {} }), 'Claude', 'cc')).toBe(false);
  });
});

describe('isModeratorPresent', () => {
  it('is true only when the configured moderator is seated and able to speak', () => {
    const r = room({
      modeConfig: { moderatorAgentName: 'Claude', moderatorAgentClient: 'cc' },
      participants: [participant({ name: 'Claude', client: 'cc' })],
    });
    expect(isModeratorPresent(r)).toBe(true);
  });

  it('is false when the moderator is present but muted', () => {
    const r = room({
      modeConfig: { moderatorAgentName: 'Claude', moderatorAgentClient: 'cc' },
      participants: [participant({ name: 'Claude', client: 'cc', canSpeak: false })],
    });
    expect(isModeratorPresent(r)).toBe(false);
  });

  it('is false when only a same-named seat on another client is present', () => {
    const r = room({
      modeConfig: { moderatorAgentName: 'Claude', moderatorAgentClient: 'cc' },
      participants: [participant({ name: 'Claude', client: 'web' })],
    });
    expect(isModeratorPresent(r)).toBe(false);
  });

  it('is false when the room names no moderator', () => {
    expect(isModeratorPresent(room({ participants: [participant()] }))).toBe(false);
  });
});

describe('isParticipantStale', () => {
  const NOW = 1_000_000_000;

  it('is false while a listen lease is still live, even with an old lastSeenAt', () => {
    const p = participant({ lastSeenAt: 0, listenUntil: NOW + 1000 });
    expect(isParticipantStale(p, NOW)).toBe(false);
  });

  it('falls back to lastSeenAt once the lease has expired', () => {
    const expired = participant({ lastSeenAt: NOW - PRESENCE_DISCONNECTED_MS - 1, listenUntil: NOW - 1 });
    expect(isParticipantStale(expired, NOW)).toBe(true);

    const recent = participant({ lastSeenAt: NOW - 1000, listenUntil: NOW - 1 });
    expect(isParticipantStale(recent, NOW)).toBe(false);
  });

  it('treats the threshold as exclusive', () => {
    expect(isParticipantStale(participant({ lastSeenAt: NOW - PRESENCE_DISCONNECTED_MS }), NOW)).toBe(false);
    expect(isParticipantStale(participant({ lastSeenAt: NOW - PRESENCE_DISCONNECTED_MS - 1 }), NOW)).toBe(true);
  });

  it('treats a missing or non-finite lastSeenAt as never seen', () => {
    expect(isParticipantStale(participant({ lastSeenAt: undefined as unknown as number }), NOW)).toBe(true);
    expect(isParticipantStale(participant({ lastSeenAt: NaN }), NOW)).toBe(true);
  });

  it('ignores a non-finite listenUntil rather than trusting it', () => {
    const p = participant({ lastSeenAt: 0, listenUntil: NaN });
    expect(isParticipantStale(p, NOW)).toBe(true);
  });
});

describe('buildTaskSubmitStatusText', () => {
  it('collapses whitespace and keeps the [STATUS] prefix and task id', () => {
    expect(buildTaskSubmitStatusText('T-07', '  12 passed\n  0 failed  '))
      .toBe('[STATUS] 待审核 / awaiting_review T-07: 12 passed 0 failed');
  });

  it('caps the summary at 180 characters', () => {
    const text = buildTaskSubmitStatusText('T-01', 'x'.repeat(500));
    expect(text.endsWith('x'.repeat(180))).toBe(true);
    expect(text).not.toContain('x'.repeat(181));
  });

  it('falls back to a placeholder when there is no run output', () => {
    expect(buildTaskSubmitStatusText('T-01', '   ')).toContain('(no run output)');
  });
});
