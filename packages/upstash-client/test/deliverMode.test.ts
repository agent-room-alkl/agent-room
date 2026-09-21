import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, Participant, Room } from '@agent-room/shared';
import { normalizeReplyMode } from '@agent-room/shared';
import {
  appendMessage, claimTask, createClient, createTask, getTaskBoard, isDeliverLead, isDeliverQuietSend,
  reassignTaskRoles, recordDeliverEscalation, submitTask, verifyTask, VerifyNoteRequiredError,
  cancelTask, markDeliverPlanReported, recordDeliverGoal, recordDeliverGoalEscalated, startDeliverPlan,
} from '../src/index.js';

const ENV = { url: 'https://example.upstash.io', token: 't' };
const mockResp = (body: unknown) => new Response(JSON.stringify(body));

const seat = (name: string, client: 'web' | 'cc', joinedAt: number): Participant => ({
  name, role: 'r', color: '#111', initials: name.slice(0, 2).toUpperCase(), client, joinedAt, lastSeenAt: joinedAt, canSpeak: true,
});

const ROOM: Room = {
  code: 'ABC-DEF-GHJ', topic: 't', createdAt: 0, createdBy: 'Robin', status: 'active', version: 1,
  replyMode: 'deliver',
  participants: [seat('Robin', 'web', 0), seat('Claude', 'cc', 1), seat('Codex', 'cc', 2)],
};

const msg = (name: string, client: 'web' | 'cc', text: string): Message => ({
  id: 1, type: 'msg', name, initials: 'XX', color: '#111', role: 'r', text, client, time: 1,
});

describe('deliver mode: reading stored modes', () => {
  it('keeps deliver alongside consensus / debate, and reads unknown modes as open', () => {
    expect(normalizeReplyMode('deliver')).toBe('deliver');
    expect(normalizeReplyMode('consensus')).toBe('consensus');
    expect(normalizeReplyMode('debate')).toBe('debate');
    expect(normalizeReplyMode('game')).toBe('open');
    expect(normalizeReplyMode(undefined)).toBe('open');
  });
});

describe('deliver mode: the lead', () => {
  it('falls back to the first agent to join', () => {
    expect(isDeliverLead(ROOM, 'Claude', 'cc')).toBe(true);
    expect(isDeliverLead(ROOM, 'Codex', 'cc')).toBe(false);
  });

  it('honours a configured lead', () => {
    const room = { ...ROOM, modeConfig: { leadAgentName: 'Codex', leadAgentClient: 'cc' as const } };
    expect(isDeliverLead(room, 'Codex', 'cc')).toBe(true);
    expect(isDeliverLead(room, 'Claude', 'cc')).toBe(false);
  });

  it('has no lead outside deliver mode', () => {
    expect(isDeliverLead({ ...ROOM, replyMode: 'sequential' }, 'Claude', 'cc')).toBe(false);
  });
});

describe('deliver mode: quiet execution', () => {
  it('posts an untagged message from a non-lead agent as status', () => {
    expect(isDeliverQuietSend(ROOM, msg('Codex', 'cc', 'on it, reading the repo'), 'message')).toBe(true);
  });

  it('keeps [RESULT] / [BLOCKER] / [DECISION] / [PLAN] as messages', () => {
    for (const tag of ['[RESULT]', '[BLOCKER]', '[DECISION]', '[PLAN]', '[result]']) {
      expect(isDeliverQuietSend(ROOM, msg('Codex', 'cc', `${tag} details`), 'message')).toBe(false);
    }
  });

  it('never quiets the lead or a human', () => {
    expect(isDeliverQuietSend(ROOM, msg('Claude', 'cc', 'thinking out loud'), 'message')).toBe(false);
    expect(isDeliverQuietSend(ROOM, msg('Robin', 'web', 'any update?'), 'message')).toBe(false);
  });

  it('treats an explicit status ping as status for any agent', () => {
    expect(isDeliverQuietSend(ROOM, msg('Claude', 'cc', 'still working'), 'status')).toBe(true);
  });
});

describe('deliver mode: appendMessage', () => {
  beforeEach(() => vi.restoreAllMocks());

  async function pushedMetadata(message: Message) {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(ROOM) }))
      .mockResolvedValueOnce(mockResp([{ result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 }]));
    vi.stubGlobal('fetch', fetchMock);
    await appendMessage(createClient(ENV), 'ABC-DEF-GHJ', message);
    const [, init] = fetchMock.mock.calls[1]!;
    const cmds = JSON.parse((init as { body: string }).body);
    return JSON.parse(cmds[0][2]).metadata;
  }

  it('stores an untagged worker message as a status update, with no turn machinery', async () => {
    expect(await pushedMetadata(msg('Codex', 'cc', 'looking into it'))).toEqual({
      modeAtSend: 'deliver', roleAtSend: 'status', invocationType: 'status_update',
    });
  });

  it('stores a tagged worker message as an ordinary message', async () => {
    expect(await pushedMetadata(msg('Codex', 'cc', '[RESULT] tests pass, see T-02'))).toEqual({
      modeAtSend: 'deliver', roleAtSend: 'open', invocationType: 'normal_turn',
    });
  });
});

// ── Slice 2: review rules ──

function installFakeBoardRedis(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    const cmd = JSON.parse(init.body) as string[];
    let result: unknown = null;
    if (cmd[0] === 'GET') result = store.get(cmd[1]) ?? null;
    else if (cmd[0] === 'EVAL') {
      const cur = store.get(cmd[3]);
      const ok = cmd[4] === 'absent' ? cur === undefined : cur === cmd[5];
      if (ok) store.set(cmd[3], cmd[6]);
      result = ok ? 1 : 0;
    } else if (cmd[0] === 'SADD' || cmd[0] === 'EXPIRE') result = 1;
    return new Response(JSON.stringify({ result }), { headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('deliver mode: verify rules', () => {
  const OWNER = { name: 'Codex', client: 'cc' as const };
  const VERIFIER = { name: 'Claude', client: 'cc' as const };
  const EVIDENCE = { fileListing: 'a.ts', fileExcerpt: 'x', runOutput: '3 passed', exitCode: 0 };
  const DELIVER = { deliver: { maxRejects: 2 } };
  const CODE = 'ABC-DEF-GHJ';

  let client: ReturnType<typeof createClient>;
  beforeEach(async () => {
    vi.restoreAllMocks();
    installFakeBoardRedis();
    client = createClient(ENV);
    await createTask(client, CODE, { title: 'Build', owner: 'Codex', ownerClient: 'cc', verifier: 'Claude', verifierClient: 'cc', createdBy: 'Claude' });
    await claimTask(client, CODE, 'T-01', OWNER);
    await submitTask(client, CODE, 'T-01', OWNER, EVIDENCE, 1000);
  });

  it('stamps reviewRequestedAt on submit', async () => {
    const board = await getTaskBoard(client, CODE);
    expect(board!.tasks[0]!.reviewRequestedAt).toBe(1000);
  });

  it('refuses a done verdict with no note or a bare approval', async () => {
    for (const note of [undefined, '', '  ', 'LGTM', 'looks good!', '通过', 'ok.']) {
      await expect(verifyTask(client, CODE, 'T-01', VERIFIER, 'done', note, 2000, DELIVER))
        .rejects.toBeInstanceOf(VerifyNoteRequiredError);
    }
    expect((await getTaskBoard(client, CODE))!.tasks[0]!.state).toBe('awaiting_review');
  });

  it('accepts a note that says what was re-run', async () => {
    const { task } = await verifyTask(client, CODE, 'T-01', VERIFIER, 'done', 're-ran npm test: 3 passed', 2000, DELIVER);
    expect(task.state).toBe('done');
  });

  it('leaves other modes free to verify without a note', async () => {
    const { task } = await verifyTask(client, CODE, 'T-01', VERIFIER, 'done', undefined, 2000);
    expect(task.state).toBe('done');
  });

  it('sends a reject back to the owner, then keeps the maxRejects-th one rejected', async () => {
    const first = await verifyTask(client, CODE, 'T-01', VERIFIER, 'rejected', 'test 2 fails', 2000, DELIVER);
    expect(first.task.state).toBe('in_progress');
    expect(first.task.rejectCount).toBe(1);
    expect(first.returnedToOwner).toBe(true);
    expect(first.rejectLimitReached).toBe(false);

    await submitTask(client, CODE, 'T-01', OWNER, EVIDENCE, 3000);
    const second = await verifyTask(client, CODE, 'T-01', VERIFIER, 'rejected', 'still fails on empty input', 4000, DELIVER);
    expect(second.task.state).toBe('rejected');
    expect(second.task.rejectCount).toBe(2);
    expect(second.task.rejections!.map(r => r.note)).toEqual(['test 2 fails', 'still fails on empty input']);
    expect(second.rejectLimitReached).toBe(true);
    expect(second.returnedToOwner).toBe(false);
  });

  it('keeps a reject terminal outside deliver mode', async () => {
    const { task, returnedToOwner } = await verifyTask(client, CODE, 'T-01', VERIFIER, 'rejected', 'no', 2000);
    expect(task.state).toBe('rejected');
    expect(task.rejectCount).toBeUndefined();
    expect(returnedToOwner).toBeUndefined();
  });

  it('restarts the review clock when the verifier changes', async () => {
    const { task } = await reassignTaskRoles(client, CODE, 'T-01', { verifier: 'Gemini', verifierClient: 'cc' }, { name: 'system', client: 'cc' }, 5000, 3);
    expect(task.reviewRequestedAt).toBe(5000);
  });

  it('records an escalation per kind without counting it as progress', async () => {
    const before = (await getTaskBoard(client, CODE))!.lastProgressAt;
    await recordDeliverEscalation(client, CODE, 'T-01', 'no_verifier', 9000);
    const board = (await getTaskBoard(client, CODE))!;
    expect(board.tasks[0]!.escalatedAt).toEqual({ no_verifier: 9000 });
    expect(board.lastProgressAt).toBe(before);
  });
});

// ── Slice 3: plans ──

describe('deliver mode: plans', () => {
  const CODE = 'ABC-DEF-GHJ';
  const task = (title: string, openAs?: string, autoStart = false) => ({
    title, owner: 'Codex', ownerClient: 'cc' as const, verifier: 'Gemini', verifierClient: 'cc' as const,
    createdBy: openAs ?? 'Gemini', deliverPlan: { openAs, autoStart },
  });

  let client: ReturnType<typeof createClient>;
  beforeEach(() => {
    vi.restoreAllMocks();
    installFakeBoardRedis();
    client = createClient(ENV);
  });

  it('opens a plan on the lead\'s first task and puts later tasks in it', async () => {
    const first = await createTask(client, CODE, task('A', 'Claude'), 1000);
    expect(first.planOpened).toBe(true);
    expect(first.plan).toMatchObject({ id: 'P-01', lead: 'Claude', createdAt: 1000 });
    expect(first.plan!.startedAt).toBeUndefined();
    const second = await createTask(client, CODE, task('B'), 1100);
    expect(second.planOpened).toBe(false);
    expect(second.task.planId).toBe('P-01');
  });

  it('does not open a plan for a non-lead with no active plan', async () => {
    const { plan, task: created } = await createTask(client, CODE, task('A'), 1000);
    expect(plan).toBeUndefined();
    expect(created.planId).toBeUndefined();
  });

  it('starts at once with autoStart', async () => {
    const { plan } = await createTask(client, CODE, task('A', 'Claude', true), 1000);
    expect(plan!.startedAt).toBe(1000);
  });

  it('starts once, and refuses with no plan', async () => {
    await expect(startDeliverPlan(client, CODE, 'Robin', 1000)).rejects.toThrow(/no plan/);
    await createTask(client, CODE, task('A', 'Claude'), 1000);
    const { plan, tasks } = await startDeliverPlan(client, CODE, 'Robin', 2000);
    expect(plan).toMatchObject({ startedAt: 2000, startedBy: 'Robin' });
    expect(tasks.map(t => t.title)).toEqual(['A']);
    await expect(startDeliverPlan(client, CODE, 'Robin', 3000)).rejects.toThrow(/already started/);
  });

  it('marks a plan reported for exactly one caller, then opens the next plan', async () => {
    await createTask(client, CODE, task('A', 'Claude'), 1000);
    expect(await markDeliverPlanReported(client, CODE, 'P-01', 5000)).toBe(true);
    expect(await markDeliverPlanReported(client, CODE, 'P-01', 5001)).toBe(false);
    const next = await createTask(client, CODE, task('B', 'Claude'), 6000);
    expect(next.plan!.id).toBe('P-02');
  });

  it('lets the host cancel a task that carries evidence only when allowed', async () => {
    await createTask(client, CODE, task('A'), 1000);
    await claimTask(client, CODE, 'T-01', { name: 'Codex', client: 'cc' });
    await submitTask(client, CODE, 'T-01', { name: 'Codex', client: 'cc' }, { fileListing: 'a', fileExcerpt: 'b', checks: 'c' }, 1100);
    await expect(cancelTask(client, CODE, 'T-01', { name: 'Robin', client: 'web' }, 'x', 1200)).rejects.toThrow(/evidence/);
    const { task: cancelled } = await cancelTask(client, CODE, 'T-01', { name: 'Robin', client: 'web' }, 'x', 1200, { allowEvidence: true });
    expect(cancelled.state).toBe('cancelled');
  });

  it('records the host goal and its escalation', async () => {
    await recordDeliverGoal(client, CODE, 1000);
    await recordDeliverGoalEscalated(client, CODE, 2000);
    expect(await getTaskBoard(client, CODE)).toMatchObject({ deliverGoalAt: 1000, deliverGoalEscalatedAt: 2000 });
  });
});
