import { describe, expect, it } from 'vitest';
import type { DeliverPlan, Task } from './types.js';
import {
  activeDeliverPlan,
  deliverPlanProgress,
  deliverPlanSettled,
  deliverReportText,
  deliverTaskEscalated,
  deliverWorkHoldsRoom,
  isDeliverStartReply,
} from './deliver.js';

const task = (over: Partial<Task>): Task => ({
  id: 'T-01', title: 'Build', owner: 'Codex', verifier: 'Gemini', state: 'todo',
  createdBy: 'Claude', createdAt: 0, updatedAt: 10, planId: 'P-01', ...over,
});
const PLAN: DeliverPlan = { id: 'P-01', lead: 'Claude', createdAt: 0, startedAt: 1 };

describe('deliverWorkHoldsRoom', () => {
  it('holds while a plan is open or a task is still moving', () => {
    expect(deliverWorkHoldsRoom({ tasks: [], plans: [PLAN] })).toBe(true);
    expect(deliverWorkHoldsRoom({ tasks: [task({ state: 'in_progress' })] })).toBe(true);
    expect(deliverWorkHoldsRoom({ tasks: [task({ state: 'blocked' })] })).toBe(true);
    expect(deliverWorkHoldsRoom({ tasks: [], deliverGoalAt: 10 })).toBe(true);
  });

  it('releases after the plan reports and the board is settled', () => {
    expect(deliverWorkHoldsRoom({ tasks: [task({ state: 'done' })], plans: [{ ...PLAN, reportedAt: 5 }] })).toBe(false);
    expect(deliverWorkHoldsRoom({ tasks: [], plans: [{ ...PLAN, reportedAt: 5 }] })).toBe(false);
    expect(deliverWorkHoldsRoom(null)).toBe(false);
  });
});

describe('deliver plans', () => {
  it('treats the last unreported plan as active', () => {
    expect(activeDeliverPlan({ plans: [PLAN] })).toBe(PLAN);
    expect(activeDeliverPlan({ plans: [{ ...PLAN, reportedAt: 5 }] })).toBeUndefined();
    expect(activeDeliverPlan(null)).toBeUndefined();
  });

  it('settles when everything is done or cancelled with at least one done', () => {
    expect(deliverPlanSettled([task({ state: 'done' }), task({ id: 'T-02', state: 'cancelled' })])).toBe(true);
    expect(deliverPlanSettled([task({ state: 'cancelled' })])).toBe(false);
    expect(deliverPlanSettled([task({ state: 'done' }), task({ id: 'T-02', state: 'awaiting_review' })])).toBe(false);
    expect(deliverPlanSettled([task({ state: 'done' }), task({ id: 'T-02', state: 'rejected' })])).toBe(false);
  });

  it('counts an escalation only until the task moves again', () => {
    expect(deliverTaskEscalated(task({ state: 'awaiting_review', escalatedAt: { no_verifier: 10 } }))).toBe(true);
    expect(deliverTaskEscalated(task({ state: 'awaiting_review', escalatedAt: { no_verifier: 9 } }))).toBe(false);
    const p = deliverPlanProgress([
      task({ state: 'todo' }),
      task({ id: 'T-02', state: 'in_progress' }),
      task({ id: 'T-03', state: 'awaiting_review', escalatedAt: { no_verifier: 20 }, updatedAt: 10 }),
      task({ id: 'T-04', state: 'rejected' }),
      task({ id: 'T-05', state: 'done' }),
    ]);
    expect(p).toEqual({ total: 5, notStarted: 1, inProgress: 1, awaitingReview: 0, done: 1, escalated: 2, cancelled: 0 });
  });

  it('writes a report with verifier, note, evidence, cancellations and escalations', () => {
    const text = deliverReportText(PLAN, [
      task({ state: 'done', verdict: { verdict: 'done', note: 're-ran npm test: 12 passed', by: 'Gemini', byClient: 'cc', at: 5 }, evidence: { fileListing: 'src/a.ts\nsrc/b.ts', fileExcerpt: 'x', checks: 'y', submittedBy: 'Codex', submittedClient: 'cc', at: 4 }, rejectCount: 1 }),
      task({ id: 'T-02', title: 'Docs', state: 'cancelled', cancellation: { by: 'Robin', byClient: 'web', at: 6, reason: 'out of scope' } }),
    ]);
    expect(text).toContain('Plan P-01 delivered — 1 task(s) verified done. @Claude');
    expect(text).toContain('✅ T-01 Build — @Codex, verified by @Gemini: re-ran npm test: 12 passed [evidence: src/a.ts]');
    expect(text).toContain('🗑️ T-02 Docs — out of scope');
    expect(text).toContain('🚩 T-01 Build — rejected 1×');
  });

  it('starts only on a bare go', () => {
    for (const t of ['开工', '开工！', 'Start', 'go.', "let's go"]) expect(isDeliverStartReply(t)).toBe(true);
    for (const t of ['开工前先确认一下', 'start with the API', '']) expect(isDeliverStartReply(t)).toBe(false);
  });
});
