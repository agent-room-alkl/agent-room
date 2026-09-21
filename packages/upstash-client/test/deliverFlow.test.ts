import { describe, expect, it, vi } from 'vitest';
import type { Participant, Task, TaskBoard } from '@agent-room/shared';
import { DEFAULT_DELIVER_OWNER_WORK_MS, DELIVER_ESCALATION_COOLDOWN_MS, PRESENCE_DISCONNECTED_MS, verifyNoteProblem } from '@agent-room/shared';

// Ported from the hosted deployment's api/_deliver.test.ts: the same rules,
// now living in the shared core (src/deliverFlow.ts).
const upstash = vi.hoisted(() => ({
  appendSystemMessage: vi.fn(async () => {}),
  markDeliverPlanReported: vi.fn(async () => true),
}));
vi.mock('../src/messages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/messages.js')>()),
  appendSystemMessage: upstash.appendSystemMessage,
}));
vi.mock('../src/tasks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tasks.js')>()),
  markDeliverPlanReported: upstash.markDeliverPlanReported,
}));
const { deliverGoalOverdue, maybeReportDeliverPlan, planDeliverSweep, rejectLimitText } = await import('../src/deliverFlow.js');

const NOW = 100 * 60_000;
const TIMEOUT = 10 * 60_000;
const gone = NOW - PRESENCE_DISCONNECTED_MS - 1;

const seat = (name: string, client: 'web' | 'cc', joinedAt: number, lastSeenAt = NOW): Participant => ({
  name, role: 'r', color: '#111', initials: 'XX', client, joinedAt, lastSeenAt, canSpeak: true,
});

const room = (participants: Participant[]) => ({
  replyMode: 'deliver' as const,
  createdBy: 'Robin',
  modeConfig: { reviewTimeoutMs: TIMEOUT },
  participants,
});

const task = (over: Partial<Task>): Task => ({
  id: 'T-01', title: 'Build', owner: 'Codex', ownerClient: 'cc', verifier: 'Claude', verifierClient: 'cc',
  state: 'awaiting_review', createdBy: 'Claude', createdAt: 0, updatedAt: NOW - TIMEOUT - 1,
  reviewRequestedAt: NOW - TIMEOUT - 1, ...over,
});

const board = (...tasks: Task[]): TaskBoard => ({ code: 'ABC-DEF-GHJ', tasks, version: 1 });

describe('deliver sweep: overdue review', () => {
  it('hands the review to a present agent who is not the owner', () => {
    const r = room([seat('Robin', 'web', 0), seat('Claude', 'cc', 1, gone), seat('Codex', 'cc', 2), seat('Gemini', 'cc', 3)]);
    const [action] = planDeliverSweep(r, board(task({})), NOW);
    expect(action).toMatchObject({ kind: 'reassign_verifier', to: { name: 'Gemini', client: 'cc' } });
  });

  it('leaves a review alone while it is inside the window or the verifier is here', () => {
    const r = room([seat('Claude', 'cc', 1, gone), seat('Codex', 'cc', 2), seat('Gemini', 'cc', 3)]);
    expect(planDeliverSweep(r, board(task({ reviewRequestedAt: NOW - TIMEOUT + 1000 })), NOW)).toEqual([]);
    const present = room([seat('Claude', 'cc', 1), seat('Codex', 'cc', 2), seat('Gemini', 'cc', 3)]);
    expect(planDeliverSweep(present, board(task({})), NOW)).toEqual([]);
  });

  it('prefers the agent with fewer reviews already waiting', () => {
    const r = room([seat('Claude', 'cc', 1, gone), seat('Codex', 'cc', 2), seat('Gemini', 'cc', 3), seat('Kimi', 'cc', 4)]);
    const busy = task({ id: 'T-02', owner: 'Kimi', verifier: 'Gemini', reviewRequestedAt: NOW });
    const [action] = planDeliverSweep(r, board(task({}), busy), NOW);
    expect(action).toMatchObject({ kind: 'reassign_verifier', to: { name: 'Kimi' } });
  });

  it('escalates to the host when nobody can take it, once per cooldown', () => {
    const r = room([seat('Claude', 'cc', 1, gone), seat('Codex', 'cc', 2)]);
    expect(planDeliverSweep(r, board(task({})), NOW)).toMatchObject([{ kind: 'escalate', reason: 'no_verifier' }]);
    const recent = task({ escalatedAt: { no_verifier: NOW - DELIVER_ESCALATION_COOLDOWN_MS + 1 } });
    expect(planDeliverSweep(r, board(recent), NOW)).toEqual([]);
    const old = task({ escalatedAt: { no_verifier: NOW - DELIVER_ESCALATION_COOLDOWN_MS } });
    expect(planDeliverSweep(r, board(old), NOW)).toHaveLength(1);
  });
});

describe('deliver sweep: owner gone', () => {
  const inProgress = (over: Partial<Task> = {}) => task({ state: 'in_progress', updatedAt: NOW - DEFAULT_DELIVER_OWNER_WORK_MS - 1, ...over });

  it('wakes the lead after the owner-work window, not after 20 quiet minutes', () => {
    const r = room([seat('Claude', 'cc', 1), seat('Codex', 'cc', 2, gone)]);
    expect(planDeliverSweep(r, board(inProgress()), NOW)).toMatchObject([{ kind: 'wake_lead', lead: { name: 'Claude' } }]);
    expect(planDeliverSweep(r, board(inProgress({ updatedAt: NOW - DEFAULT_DELIVER_OWNER_WORK_MS + 1 })), NOW)).toEqual([]);
    expect(planDeliverSweep(r, board(inProgress({ updatedAt: NOW - 2 * TIMEOUT - 1 })), NOW)).toEqual([]);
    expect(planDeliverSweep(r, board(inProgress({ escalatedAt: { owner_stale: NOW - 1 } })), NOW)).toEqual([]);
  });

  it('goes to the host when the owner is the lead', () => {
    const r = room([seat('Codex', 'cc', 1, gone), seat('Claude', 'cc', 2)]);
    expect(planDeliverSweep(r, board(inProgress()), NOW)).toMatchObject([{ kind: 'escalate', reason: 'owner_stale' }]);
  });

  it('does nothing outside deliver mode', () => {
    const r = { ...room([seat('Claude', 'cc', 1), seat('Codex', 'cc', 2, gone)]), replyMode: 'open' as const };
    expect(planDeliverSweep(r, board(inProgress()), NOW)).toEqual([]);
  });
});

describe('deliver: reject limit and verify notes', () => {
  it('lists every reject reason for the host', () => {
    const text = rejectLimitText(task({
      state: 'rejected', rejectCount: 2,
      rejections: [
        { verdict: 'rejected', note: 'test 2 fails', by: 'Claude', byClient: 'cc', at: 1 },
        { verdict: 'rejected', note: 'empty input crashes', by: 'Claude', byClient: 'cc', at: 2 },
      ],
    }));
    expect(text).toContain('rejected 2 times');
    expect(text).toContain('1. @Claude: test 2 fails');
    expect(text).toContain('2. @Claude: empty input crashes');
  });

  it('treats approval-only notes as missing and specific ones as enough', () => {
    for (const note of ['', 'LGTM', 'Looks good to me.', '没问题！', 'verified']) expect(verifyNoteProblem(note)).not.toBeNull();
    for (const note of ['re-ran npm test: 12 passed', '打开 report.md 核对了三项验收标准，都满足']) expect(verifyNoteProblem(note)).toBeNull();
  });
});

describe('deliver: the plan clock and the report', () => {
  const r = room([seat('Claude', 'cc', 1), seat('Codex', 'cc', 2)]);
  const goalAt = NOW - TIMEOUT - 1;

  it('escalates a goal the lead left without a plan, once', () => {
    expect(deliverGoalOverdue(r, { ...board(), deliverGoalAt: goalAt }, NOW)).toBe(true);
    expect(deliverGoalOverdue(r, { ...board(), deliverGoalAt: NOW - TIMEOUT + 1 }, NOW)).toBe(false);
    expect(deliverGoalOverdue(r, { ...board(), deliverGoalAt: goalAt, deliverGoalEscalatedAt: goalAt + 1 }, NOW)).toBe(false);
    expect(deliverGoalOverdue(r, { ...board(), deliverGoalAt: goalAt, plans: [{ id: 'P-01', lead: 'Claude', createdAt: goalAt + 5, reportedAt: goalAt + 9 }] }, NOW)).toBe(false);
    expect(deliverGoalOverdue(r, { ...board(), deliverGoalAt: goalAt, plans: [{ id: 'P-01', lead: 'Claude', createdAt: 0 }] }, NOW)).toBe(false);
  });

  it('posts the report to the lead when the plan settles, and not before', async () => {
    const plans = [{ id: 'P-01', lead: 'Claude', createdAt: 0, startedAt: 1 }];
    const open = { ...board(task({ planId: 'P-01', state: 'awaiting_review' })), plans };
    expect(await maybeReportDeliverPlan({} as never, 'ABC-DEF-GHJ', r, open, NOW)).toBe(false);
    expect(upstash.markDeliverPlanReported).not.toHaveBeenCalled();

    const settled = { ...board(task({ planId: 'P-01', state: 'done' })), plans };
    expect(await maybeReportDeliverPlan({} as never, 'ABC-DEF-GHJ', r, settled, NOW)).toBe(true);
    expect(upstash.appendSystemMessage).toHaveBeenCalledWith({}, 'ABC-DEF-GHJ', expect.objectContaining({
      metadata: expect.objectContaining({ eventType: 'deliver_report', targetAgentName: 'Claude', planId: 'P-01' }),
    }));

    upstash.markDeliverPlanReported.mockResolvedValueOnce(false);
    upstash.appendSystemMessage.mockClear();
    expect(await maybeReportDeliverPlan({} as never, 'ABC-DEF-GHJ', r, settled, NOW)).toBe(false);
    expect(upstash.appendSystemMessage).not.toHaveBeenCalled();
  });
});
