// Deliver mode's orchestration: stuck-task handling, the plan's two ends, and
// the checks the task board applies in a deliver room.
//
// The hosted deployment runs this from its room API and a cron. This repo has
// neither, so it lives here in the shared core and is called from the places
// that do run: the MCP server (task actions, and the sweep inside
// room_listen) and the web client (the host's Start and goal, and the sweep
// while the host's room is open).
//
// Deliver rooms have one lead and a verifier on every task, so two things can
// quietly stop a plan: a verifier who is gone while a submission waits, and an
// owner who is gone while their task sits in progress. The room cannot see
// either from chat — both agents just stop talking — so the board sweep does:
//   - review overdue and verifier gone → hand the review to a present agent;
//   - nobody to hand it to → tell the host;
//   - owner gone for the owner-work window → wake the lead;
//   - a task rejected maxRejects times → tell the host (verifyDeliverTask);
//   - the host stated a goal and the lead made no plan in the window → tell the host.
// And the plan's two ends: the host's go wakes each owner, and a settled plan
// posts one delivery report that wakes the lead for [RESULT].
// Escalations repeat at most once per task per kind per
// DELIVER_ESCALATION_COOLDOWN_MS, so the sweep is safe to run on every poll.

import type { ClientKind, DeliverEscalationKind, DeliverPlan, Participant, Room, Task, TaskBoard, TaskState } from '@agent-room/shared';
import {
  DELIVER_ESCALATION_COOLDOWN_MS,
  DEFAULT_DELIVER_OWNER_WORK_MS,
  activeDeliverPlan,
  deliverPlanSettled,
  deliverPlanTasks,
  deliverReportText,
  deliverSettings,
  isDeliverStartReply,
} from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { appendSystemMessage } from './messages.js';
import { isParticipantStale, taskRoleSeatProblem } from './rooms.js';
import {
  cancelTask,
  createTask,
  getTaskBoard,
  hostSetTaskState,
  markDeliverPlanReported,
  reassignTaskRoles,
  recordDeliverEscalation,
  recordDeliverGoal,
  recordDeliverGoalEscalated,
  reopenTask,
  startDeliverPlan,
  verifyTask,
} from './tasks.js';
import { isDeliverLead, pickLeadForSequential } from './turnState.js';

export type DeliverRoom = Pick<Room, 'replyMode' | 'participants' | 'modeConfig' | 'createdBy'>;

type Seat = { name: string; client: ClientKind };

export type DeliverSweepAction =
  | { kind: 'reassign_verifier'; task: Task; to: Seat; waitedMs: number }
  | { kind: 'escalate'; reason: Extract<DeliverEscalationKind, 'no_verifier' | 'owner_stale'>; task: Task; waitedMs: number }
  | { kind: 'wake_lead'; task: Task; lead: Seat; waitedMs: number };

const sameName = (a: string | undefined, b: string | undefined): boolean =>
  !!a?.trim() && !!b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();

function seatOf(room: DeliverRoom, name: string | undefined): Participant | undefined {
  return room.participants.find(p => sameName(p.name, name));
}

function isPresent(room: DeliverRoom, name: string | undefined, now: number): boolean {
  const seat = seatOf(room, name);
  return !!seat && !isParticipantStale(seat, now);
}

function escalationDue(task: Task, kind: DeliverEscalationKind, now: number): boolean {
  const last = task.escalatedAt?.[kind];
  return last === undefined || now - last >= DELIVER_ESCALATION_COOLDOWN_MS;
}

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

// ── Checks the board applies in a deliver room ──

/** Every deliver task needs an owner and a different verifier, both seated agents. */
export function deliverRolesProblem(
  room: Pick<Room, 'participants'>,
  owner: string | undefined,
  verifier: string | undefined,
): string | null {
  if (!owner?.trim() || !verifier?.trim()) {
    return 'In a deliver room every task needs an owner and a different verifier — both agents in this room.';
  }
  return taskRoleSeatProblem(room, owner, verifier);
}

/** Why this task cannot be claimed yet, or null: its plan is waiting for the host's Start. */
export function deliverClaimProblem(board: TaskBoard | null | undefined, taskId: string): string | null {
  const target = board?.tasks.find(t => t.id === taskId);
  const plan = target?.planId ? board?.plans?.find(p => p.id === target.planId) : undefined;
  if (plan && !plan.startedAt) {
    return `${taskId} is in plan ${plan.id}, which the host has not started. Wait for the start message; do not begin work.`;
  }
  return null;
}

// ── Task actions with deliver's side effects ──

export interface DeliverTaskInput {
  id?: string;
  title: string;
  createdBy: string;
  owner?: string;
  ownerClient?: ClientKind;
  verifier?: string;
  verifierClient?: ClientKind;
  dod?: string;
}

/**
 * createTask for any room. In a deliver room it checks the roles, files the
 * task under the lead's plan (opening one if needed), and announces a newly
 * opened plan so the host knows to review it and press Start.
 */
export async function createRoomTask(
  client: UpstashClient,
  code: string,
  room: Room,
  input: DeliverTaskInput,
): Promise<{ board: TaskBoard; task: Task; plan?: DeliverPlan }> {
  const deliver = room.replyMode === 'deliver';
  const problem = deliver
    ? deliverRolesProblem(room, input.owner, input.verifier)
    : taskRoleSeatProblem(room, input.owner, input.verifier);
  if (problem) throw new DeliverRuleError(problem);
  const settings = deliverSettings(room.modeConfig);
  const created = await createTask(client, code, {
    ...input,
    ...(deliver ? {
      deliverPlan: {
        openAs: isDeliverLead(room, input.createdBy, 'cc') ? input.createdBy : undefined,
        autoStart: settings.autoStart,
      },
    } : {}),
  });
  const { plan, planOpened } = created;
  if (plan && planOpened) {
    const now = Date.now();
    try {
      await appendSystemMessage(client, code, {
        id: now, type: 'sys', name: 'system', initials: '📋', color: '#6366F1', role: '',
        text: plan.startedAt
          ? `📋 Plan ${plan.id} opened by @${plan.lead} and started (auto-start is on).`
          : `📋 Plan ${plan.id} opened by @${plan.lead}. ${room.createdBy}: review the tasks on the board, then press Start. Owners wait until then.`,
        client: 'cc', time: now,
        metadata: { eventType: 'deliver_plan', modeAtSend: 'deliver', targetAgentName: room.createdBy, planId: plan.id },
      });
    } catch { /* best-effort */ }
  }
  return { board: created.board, task: created.task, ...(plan ? { plan } : {}) };
}

/**
 * verifyTask with the deliver rules on: a done verdict needs a note that says
 * what was re-checked, a reject goes back to the owner until maxRejects, and
 * the maxRejects-th one escalates to the host. A verdict that settles the plan
 * posts the delivery report.
 */
export async function verifyRoomTask(
  client: UpstashClient,
  code: string,
  room: Room,
  id: string,
  verifier: Seat,
  verdict: 'done' | 'rejected',
  note: string | undefined,
): Promise<Awaited<ReturnType<typeof verifyTask>>> {
  const deliver = room.replyMode === 'deliver';
  const result = await verifyTask(
    client, code, id, verifier, verdict, note, Date.now(),
    deliver ? { deliver: { maxRejects: deliverSettings(room.modeConfig).maxRejects } } : undefined,
  );
  if (deliver) {
    if (result.rejectLimitReached) {
      await emitDeliverEscalation(client, code, room, result.task, 'max_rejects', rejectLimitText(result.task));
    }
    await maybeReportDeliverPlan(client, code, room, result.board).catch(() => false);
  }
  return result;
}

/** cancelTask, then the delivery report if that settled the plan. */
export async function cancelRoomTask(
  client: UpstashClient,
  code: string,
  room: Room,
  id: string,
  by: Seat,
  reason?: string,
): Promise<Awaited<ReturnType<typeof cancelTask>>> {
  const result = await cancelTask(client, code, id, by, reason);
  await maybeReportDeliverPlan(client, code, room, result.board).catch(() => false);
  return result;
}

/** The host's Set state, then the delivery report if that settled the plan. */
export async function hostSetRoomTaskState(
  client: UpstashClient,
  code: string,
  room: Room,
  id: string,
  state: TaskState,
): Promise<Awaited<ReturnType<typeof hostSetTaskState>>> {
  const result = await hostSetTaskState(client, code, id, state, room.createdBy);
  await maybeReportDeliverPlan(client, code, room, result.board).catch(() => false);
  return result;
}

export { reopenTask };

export class DeliverRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliverRuleError';
  }
}

// ── The plan's two ends ──

/**
 * A host message in a deliver room is either the go for a waiting plan
 * ("Start" / "go" / 开工) or a goal the lead should answer with a plan. Call
 * it after the host's message is stored; outside deliver mode it does nothing.
 */
export async function onDeliverHostMessage(
  client: UpstashClient,
  code: string,
  room: Room,
  text: string,
): Promise<void> {
  if (room.replyMode !== 'deliver') return;
  const board = await getTaskBoard(client, code).catch(() => null);
  const plan = activeDeliverPlan(board);
  if (plan && !plan.startedAt && isDeliverStartReply(text)) {
    await startDeliverPlanAndWake(client, code, room.createdBy);
    return;
  }
  if (!plan) await recordDeliverGoal(client, code);
}

/** Start the active plan and wake each owner with their tasks. */
export async function startDeliverPlanAndWake(
  client: UpstashClient,
  code: string,
  by: string,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; plan: DeliverPlan; tasks: Task[] }> {
  const started = await startDeliverPlan(client, code, by, now);
  await announcePlanStart(client, code, started.plan, started.tasks, by, now);
  return started;
}

export async function announcePlanStart(
  client: UpstashClient,
  code: string,
  plan: DeliverPlan,
  tasks: Task[],
  by: string,
  now: number = Date.now(),
): Promise<void> {
  const byOwner = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.owner || t.state === 'done' || t.state === 'cancelled') continue;
    byOwner.set(t.owner, [...(byOwner.get(t.owner) ?? []), t]);
  }
  let seq = 0;
  for (const [owner, owned] of byOwner) {
    const at = now + seq++;
    try {
      await appendSystemMessage(client, code, {
        id: at, type: 'sys', name: 'system', initials: '🚀', color: '#10B981', role: '',
        text: `🚀 Plan ${plan.id} started by ${by}. @${owner}, yours: ${owned.map(t => `${t.id} "${t.title}"`).join(', ')}. Claim, do the work, submit evidence.`,
        client: 'cc', time: at,
        metadata: { eventType: 'deliver_plan', modeAtSend: 'deliver', targetAgentName: owner, planId: plan.id },
      });
    } catch { /* best-effort */ }
  }
}

/**
 * Post the delivery report once the active plan is settled. Safe to call from
 * every path that can settle a task (verify, cancel, host set state, sweep):
 * markDeliverPlanReported lets exactly one caller through.
 */
export async function maybeReportDeliverPlan(
  client: UpstashClient,
  code: string,
  room: DeliverRoom,
  known?: TaskBoard | null,
  now: number = Date.now(),
): Promise<boolean> {
  if (room.replyMode !== 'deliver') return false;
  const board = known ?? await getTaskBoard(client, code).catch(() => null);
  const plan = activeDeliverPlan(board);
  if (!board || !plan) return false;
  const tasks = deliverPlanTasks(board, plan.id);
  if (!deliverPlanSettled(tasks)) return false;
  if (!await markDeliverPlanReported(client, code, plan.id, now)) return false;
  try {
    await appendSystemMessage(client, code, {
      id: now, type: 'sys', name: 'system', initials: '📦', color: '#10B981', role: '',
      text: deliverReportText(plan, tasks),
      client: 'cc', time: now,
      metadata: { eventType: 'deliver_report', modeAtSend: 'deliver', targetAgentName: plan.lead, planId: plan.id },
    });
  } catch { /* best-effort */ }
  return true;
}

// ── The sweep ──

/** A present agent to take over a review: never the owner, fewest reviews waiting on them. */
export function pickReplacementVerifier(room: DeliverRoom, board: TaskBoard, task: Task, now: number): Seat | undefined {
  const pending = (name: string) => board.tasks.filter(
    t => t.state === 'awaiting_review' && sameName(t.verifier, name),
  ).length;
  return room.participants
    .filter(p => p.client === 'cc' && p.canSpeak !== false && p.name !== room.createdBy)
    .filter(p => !sameName(p.name, task.owner) && !sameName(p.name, task.verifier))
    .filter(p => !isParticipantStale(p, now))
    .sort((a, b) => pending(a.name) - pending(b.name) || a.joinedAt - b.joinedAt)
    .map(p => ({ name: p.name, client: p.client }))[0];
}

/** Pure: what the sweep should do about this board right now. */
export function planDeliverSweep(room: DeliverRoom, board: TaskBoard, now: number): DeliverSweepAction[] {
  if (room.replyMode !== 'deliver') return [];
  const { reviewTimeoutMs } = deliverSettings(room.modeConfig);
  const actions: DeliverSweepAction[] = [];
  for (const task of board.tasks) {
    if (task.state === 'awaiting_review') {
      const waitedMs = now - (task.reviewRequestedAt ?? task.updatedAt);
      if (waitedMs <= reviewTimeoutMs || isPresent(room, task.verifier, now)) continue;
      const to = pickReplacementVerifier(room, board, task, now);
      if (to) actions.push({ kind: 'reassign_verifier', task, to, waitedMs });
      else if (escalationDue(task, 'no_verifier', now)) actions.push({ kind: 'escalate', reason: 'no_verifier', task, waitedMs });
    } else if (task.state === 'in_progress') {
      const waitedMs = now - task.updatedAt;
      // Coding is quiet: wait the owner-work window, not the review window.
      if (waitedMs <= DEFAULT_DELIVER_OWNER_WORK_MS || !task.owner || isPresent(room, task.owner, now)) continue;
      if (!escalationDue(task, 'owner_stale', now)) continue;
      const lead = pickLeadForSequential(room as Room);
      if (lead && !sameName(lead.name, task.owner) && isPresent(room, lead.name, now)) {
        actions.push({ kind: 'wake_lead', task, lead, waitedMs });
      } else {
        actions.push({ kind: 'escalate', reason: 'owner_stale', task, waitedMs });
      }
    }
  }
  return actions;
}

/**
 * The host stated a goal, the review window passed, and no plan came of it.
 * Once per goal. An active plan means the host is talking about work already
 * under way, not asking for a new plan.
 */
export function deliverGoalOverdue(room: DeliverRoom, board: TaskBoard | null, now: number): boolean {
  if (room.replyMode !== 'deliver' || !board?.deliverGoalAt) return false;
  const goalAt = board.deliverGoalAt;
  if (now - goalAt <= deliverSettings(room.modeConfig).reviewTimeoutMs) return false;
  if ((board.deliverGoalEscalatedAt ?? 0) >= goalAt) return false;
  if (activeDeliverPlan(board)) return false;
  return !(board.plans ?? []).some(p => p.createdAt >= goalAt);
}

/** System message to the host. Best-effort. */
export async function emitDeliverEscalation(
  client: UpstashClient,
  code: string,
  room: DeliverRoom,
  task: Task | undefined,
  reason: DeliverEscalationKind,
  text: string,
  now: number = Date.now(),
): Promise<void> {
  try {
    await appendSystemMessage(client, code, {
      id: now, type: 'sys', name: 'system', initials: '🚩', color: '#DC2626', role: '',
      text, client: 'cc', time: now,
      metadata: {
        eventType: 'deliver_escalated', modeAtSend: 'deliver', targetAgentName: room.createdBy,
        escalationReason: reason, ...(task ? { taskId: task.id, planId: task.planId } : {}),
      },
    });
  } catch { /* best-effort */ }
}

/**
 * Everything the deliver board needs done right now. Idempotent within the
 * escalation cooldown, so callers may run it on every poll; outside deliver
 * mode it does nothing.
 */
export async function runDeliverSweep(
  client: UpstashClient,
  code: string,
  room: DeliverRoom,
  known?: TaskBoard | null,
  now: number = Date.now(),
): Promise<void> {
  if (room.replyMode !== 'deliver') return;
  const board = known ?? await getTaskBoard(client, code).catch(() => null);
  if (!board) return;
  if (deliverGoalOverdue(room, board, now)) {
    await recordDeliverGoalEscalated(client, code, now).catch(() => { /* best-effort */ });
    const lead = pickLeadForSequential(room as Room);
    await emitDeliverEscalation(
      client, code, room, undefined, 'no_plan',
      `🚩 ${minutes(now - board.deliverGoalAt!)} min since your goal and ${lead ? `the lead @${lead.name}` : 'no lead'} has not put a plan on the board. Nudge the lead, pick another lead, or restate the goal.`,
      now,
    );
  }
  await maybeReportDeliverPlan(client, code, room, board, now).catch(() => false);
  for (const action of planDeliverSweep(room, board, now)) {
    const { task } = action;
    try {
      if (action.kind === 'reassign_verifier') {
        const eligible = room.participants.filter(p => p.client === 'cc').length;
        await reassignTaskRoles(
          client, code, task.id,
          { verifier: action.to.name, verifierClient: action.to.client },
          { name: 'system', client: 'cc' }, now, eligible,
        );
        const from = task.verifier ? `@${task.verifier} has not reviewed it` : 'nobody was reviewing it';
        await appendSystemMessage(client, code, {
          id: now, type: 'sys', name: 'system', initials: '⏱️', color: '#F59E0B', role: '',
          text: `⏱️ ${task.id} "${task.title}" waited ${minutes(action.waitedMs)} min for review and ${from} — @${action.to.name} now verifies it. Re-check the evidence yourself, then room_task verify.`,
          client: 'cc', time: now,
          metadata: { eventType: 'deliver_verifier_reassigned', modeAtSend: 'deliver', targetAgentName: action.to.name, targetAgentClient: action.to.client, taskId: task.id },
        });
      } else if (action.kind === 'wake_lead') {
        await recordDeliverEscalation(client, code, task.id, 'owner_stale', now);
        await appendSystemMessage(client, code, {
          id: now, type: 'sys', name: 'system', initials: '🚩', color: '#F59E0B', role: '',
          text: `🚩 @${action.lead.name}: ${task.id} "${task.title}" has been in progress ${minutes(action.waitedMs)} min and its owner @${task.owner} is not in the room. Reassign it (room_task reassign) or tell the host why it should wait.`,
          client: 'cc', time: now,
          metadata: { eventType: 'deliver_escalated', modeAtSend: 'deliver', targetAgentName: action.lead.name, targetAgentClient: action.lead.client, taskId: task.id, escalationReason: 'owner_stale' },
        });
      } else {
        await recordDeliverEscalation(client, code, task.id, action.reason, now);
        const text = action.reason === 'no_verifier'
          ? `🚩 ${task.id} "${task.title}" has waited ${minutes(action.waitedMs)} min for review, ${task.verifier ? `@${task.verifier} is not in the room` : 'it has no verifier'}, and no other agent can take it. Verify it yourself, bring in another agent, or cancel it.`
          : `🚩 ${task.id} "${task.title}" has been in progress ${minutes(action.waitedMs)} min, its owner @${task.owner} is not in the room, and there is no lead to reassign it. Reassign it or cancel it.`;
        await emitDeliverEscalation(client, code, room, task, action.reason, text, now);
      }
    } catch { /* one task must not stop the sweep */ }
  }
}

/** Text for the maxRejects-th reject: every reason, for the host. */
export function rejectLimitText(task: Task): string {
  const reasons = (task.rejections ?? [])
    .map((r, i) => `${i + 1}. @${r.by}: ${(r.note ?? '').trim().slice(0, 300) || '(no reason given)'}`);
  return [
    `🚩 ${task.id} "${task.title}" was rejected ${task.rejectCount ?? reasons.length} times and stays rejected. Owner @${task.owner ?? '?'} and the verifiers disagree — decide: accept it, reopen it with clearer done-when, or cancel it.`,
    ...reasons,
  ].join('\n');
}
