// Deliver mode's review rules, shared by the server state machine
// (upstash-client tasks.ts), the room API, and the board sweep.
import type { DeliverPlan, ReplyModeConfig, Task, TaskBoard } from './types.js';

export const DEFAULT_DELIVER_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_DELIVER_MAX_REJECTS = 2;
/** One escalation per task per kind in this window. */
export const DELIVER_ESCALATION_COOLDOWN_MS = 30 * 60 * 1000;
/**
 * An owner mid-task is often coding, not chatting. Do not treat that as
 * abandoned until this long with no board update — 2 × reviewTimeout (20 min)
 * was shorter than a normal implementation turn and woke the lead mid-work.
 */
export const DEFAULT_DELIVER_OWNER_WORK_MS = 2 * 60 * 60 * 1000;

export interface DeliverSettings {
  autoStart: boolean;
  reviewTimeoutMs: number;
  maxRejects: number;
}

export function deliverSettings(config?: ReplyModeConfig): DeliverSettings {
  const timeout = config?.reviewTimeoutMs;
  const rejects = config?.maxRejects;
  return {
    autoStart: config?.autoStart === true,
    reviewTimeoutMs: typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
      ? timeout : DEFAULT_DELIVER_REVIEW_TIMEOUT_MS,
    maxRejects: typeof rejects === 'number' && Number.isInteger(rejects) && rejects >= 1
      ? rejects : DEFAULT_DELIVER_MAX_REJECTS,
  };
}

// A verdict that is only approval: "LGTM", "looks good", "通过". Anything after
// the approval word ("looks good, re-ran npm test: 12 passed") is not matched.
const APPROVAL_ONLY_RE = /^(lgtm|looks good( to me)?|all good|good|great|ok(ay)?|fine|done|verified|approved?|confirmed?|pass(ed)?|works|ship it|没问题|通过|可以|好的|已验证|确认|验证通过|完成)$/i;
const MIN_VERIFY_NOTE_CHARS = 12;

/**
 * Why a deliver-mode `done` note is not enough, or null when it is.
 *
 * Deliveries that held up in production were re-checked by a different agent;
 * a verdict that says only "looks good" records that nobody re-checked.
 */
export function verifyNoteProblem(note: string | undefined): string | null {
  const clean = (note ?? '').trim();
  const bare = clean.replace(/[\s.,!?;:。，！？；：~…-]+/g, ' ').trim();
  if (!bare) {
    return 'A done verdict in a deliver room needs a note saying what you re-ran or opened and what you saw.';
  }
  if (APPROVAL_ONLY_RE.test(bare) || [...bare].length < MIN_VERIFY_NOTE_CHARS) {
    return `"${clean.slice(0, 40)}" does not say what you checked. Name the command you re-ran or the artifact you opened, and what you saw.`;
  }
  return null;
}

// ── Plans ──


/**
 * Deliver work in flight — the 30-minute chat-silence cron must not end the
 * room. Quiet execution is the mode: owners code, status pings are optional,
 * and board sys lines do not count as speech.
 */
export function deliverWorkHoldsRoom(board: Pick<TaskBoard, 'tasks' | 'plans' | 'deliverGoalAt'> | null | undefined): boolean {
  if (!board) return false;
  if (activeDeliverPlan(board)) return true;
  if (board.tasks.some(t =>
    t.state === 'todo' || t.state === 'in_progress' || t.state === 'awaiting_review' || t.state === 'blocked',
  )) return true;
  const goalAt = board.deliverGoalAt;
  if (typeof goalAt === 'number' && Number.isFinite(goalAt)
    && !(board.plans ?? []).some(p => p.createdAt >= goalAt)) {
    return true;
  }
  return false;
}

/** The plan the room is working on: the latest one not yet reported. */
export function activeDeliverPlan(board: Pick<TaskBoard, 'plans'> | null | undefined): DeliverPlan | undefined {
  const last = board?.plans?.[board.plans.length - 1];
  return last && !last.reportedAt ? last : undefined;
}

/** The plan the UI should show: the active one, else the last reported one. */
export function latestDeliverPlan(board: Pick<TaskBoard, 'plans'> | null | undefined): DeliverPlan | undefined {
  return board?.plans?.[board.plans.length - 1];
}

export function deliverPlanTasks(board: Pick<TaskBoard, 'tasks'>, planId: string): Task[] {
  return board.tasks.filter(t => t.planId === planId);
}

/** Settled: every task is done or cancelled, and at least one is done. */
export function deliverPlanSettled(tasks: Task[]): boolean {
  return tasks.some(t => t.state === 'done')
    && tasks.every(t => t.state === 'done' || t.state === 'cancelled');
}

/**
 * An open task whose latest escalation has not been acted on. Escalating does
 * not touch updatedAt, so any change to the task since (reassign, submit,
 * verdict) clears it.
 */
export function deliverTaskEscalated(t: Task): boolean {
  if (t.state === 'done' || t.state === 'cancelled' || t.state === 'rejected') return false;
  const times = Object.values(t.escalatedAt ?? {}).filter((n): n is number => typeof n === 'number');
  return times.length > 0 && Math.max(...times) >= t.updatedAt;
}

export interface DeliverPlanProgress {
  total: number;
  notStarted: number;     // todo
  inProgress: number;     // in_progress + blocked
  awaitingReview: number;
  done: number;
  escalated: number;      // rejected, or escalated and still open
  cancelled: number;
}

export function deliverPlanProgress(tasks: Task[]): DeliverPlanProgress {
  const p: DeliverPlanProgress = { total: tasks.length, notStarted: 0, inProgress: 0, awaitingReview: 0, done: 0, escalated: 0, cancelled: 0 };
  for (const t of tasks) {
    if (t.state === 'rejected' || deliverTaskEscalated(t)) p.escalated++;
    else if (t.state === 'todo') p.notStarted++;
    else if (t.state === 'in_progress' || t.state === 'blocked') p.inProgress++;
    else if (t.state === 'awaiting_review') p.awaitingReview++;
    else if (t.state === 'done') p.done++;
    else if (t.state === 'cancelled') p.cancelled++;
  }
  return p;
}

const firstLine = (text: string | undefined, max: number): string =>
  (text ?? '').trim().split('\n').find(Boolean)?.trim().slice(0, max) ?? '';

/** Text of the deliver_report system message. */
export function deliverReportText(plan: DeliverPlan, tasks: Task[]): string {
  const done = tasks.filter(t => t.state === 'done');
  const cancelled = tasks.filter(t => t.state === 'cancelled');
  const escalated = tasks.filter(t => (t.rejectCount ?? 0) > 0 || (t.escalatedAt && Object.keys(t.escalatedAt).length > 0));
  const lines = [
    `📦 Plan ${plan.id} delivered — ${done.length} task(s) verified done. @${plan.lead}: post one [RESULT] for the host.`,
    ...done.map(t => {
      const note = firstLine(t.verdict?.note, 120);
      const evidence = firstLine(t.evidence?.fileListing, 120) || firstLine(t.readinessNote, 120);
      return `✅ ${t.id} ${t.title} — @${t.owner ?? '?'}, verified by @${t.verdict?.by ?? t.verifier ?? '?'}`
        + (note ? `: ${note}` : '')
        + (evidence ? ` [evidence: ${evidence}]` : '');
    }),
  ];
  if (cancelled.length) {
    lines.push('Cancelled:', ...cancelled.map(t => `🗑️ ${t.id} ${t.title}${t.cancellation?.reason ? ` — ${firstLine(t.cancellation.reason, 120)}` : ''}`));
  }
  if (escalated.length) {
    lines.push('Needed help on the way:', ...escalated.map(t => `🚩 ${t.id} ${t.title}${t.rejectCount ? ` — rejected ${t.rejectCount}×` : ''}${t.escalatedAt ? ` — ${Object.keys(t.escalatedAt).join(', ')}` : ''}`));
  }
  return lines.join('\n');
}

// The host's go. UI copy is English (Start); typed replies still match
// exact short phrases in the user's language. Longer sentences do not start.
const START_REPLY_RE = /^\s*(开工|开始|开始吧|开工吧|start|go|start it|start the plan|let'?s go)\s*[!！。.]*\s*$/i;

export function isDeliverStartReply(text: string | undefined): boolean {
  return START_REPLY_RE.test(text ?? '');
}
