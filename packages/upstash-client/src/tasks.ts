// Evidence-gated task board for a room. Lives in its own Redis key
// (`task-board:{code}`) with the same TTL as the room, like turn state, so the
// room JSON stays small and the board can churn independently.
//
// This module is the server-side enforcement of the delivery state machine
// described in @agent-room/shared's Task types. The whole point is that the
// rules below cannot be talked around by an agent — they are checked here, not
// in a prompt:
//   - submitTask REQUIRES three non-empty evidence parts; missing any part
//     throws EvidenceIncompleteError and the task does not move.
//   - A producer can only reach 'awaiting_review'. There is no code path that
//     lets the owner set 'done'.
//   - verifyTask is the ONLY way to reach 'done' / 'rejected', and it rejects
//     (NotVerifierError) anyone who is not the task's designated verifier — and
//     always rejects the owner verifying their own task (OwnerCannotVerifyError).
import type { ClientKind, SubTask, Task, TaskBoard, TaskEvidence, TaskRoleChange, TaskState } from '@agent-room/shared';
import { ROOM_TTL_SECONDS, TASK_BLOCK_DEMOTE_THRESHOLD } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { ConcurrencyError, UpstashError } from './errors.js';

export class TaskNotFoundError extends UpstashError {
  constructor(id: string) { super(`Task ${id} not found`); this.name = 'TaskNotFoundError'; }
}
export class TaskExistsError extends UpstashError {
  constructor(id: string) { super(`Task ${id} already exists`); this.name = 'TaskExistsError'; }
}
export class EvidenceIncompleteError extends UpstashError {
  constructor(missing: string) {
    super(`Evidence incomplete: ${missing}. A submission must include a non-empty fileListing, fileExcerpt, and runOutput (with an exitCode).`);
    this.name = 'EvidenceIncompleteError';
  }
}
export class NotVerifierError extends UpstashError {
  constructor(id: string, verifier?: string) {
    super(verifier
      ? `Only the designated verifier (${verifier}) can verify task ${id}.`
      : `Only a non-owner agent can verify task ${id}.`);
    this.name = 'NotVerifierError';
  }
}
export class OwnerCannotVerifyError extends UpstashError {
  constructor(id: string) {
    super(`The producer of task ${id} cannot verify their own delivery — a different agent must rule on the evidence.`);
    this.name = 'OwnerCannotVerifyError';
  }
}
export class VerifierCannotClaimError extends UpstashError {
  constructor(id: string, verifier: string) {
    super(
      `The designated verifier (${verifier}) cannot claim task ${id} — that would make the producer also the only allowed verifier (owner==verifier deadlock).`,
    );
    this.name = 'VerifierCannotClaimError';
  }
}
export class TaskStateError extends UpstashError {
  constructor(message: string) { super(message); this.name = 'TaskStateError'; }
}

/** True when a claim would set owner to the task's designated verifier (T-13 deadlock). */
function claimerIsDesignatedVerifier(
  task: Task,
  claimer: { name: string; client: ClientKind },
): boolean {
  if (!task.verifier) return false;
  const sameName = task.verifier.trim().toLowerCase() === claimer.name.trim().toLowerCase();
  if (!sameName) return false;
  // Client-tolerant (same direction as verifyTask in #318): if verifierClient is
  // unset, a name match alone is enough to block; if set, require client match too.
  if (task.verifierClient === undefined) return true;
  return task.verifierClient === claimer.client;
}

// Now that casWriteTaskBoard is a real CAS that rejects on conflict, the
// important mutations (claim/submit/verify/reassign) must survive a few lost
// races under contention (poll review + cron + multiple agents writing). 3 was
// fine when the write was unconditional; give more headroom now.
const CAS_MAX_ATTEMPTS = 6;

function taskBoardKey(code: string): string {
  return `task-board:${code}`;
}

// Index of rooms that have ever had a task created, so a periodic cron sweep
// can find boards to review without SCANning all of Redis. Rooms are pruned
// from this set by the sweep when their board is gone / all-done / the room
// ended. The set self-expires (refreshed on each register) so an abandoned
// deploy doesn't leak it forever.
const BOARD_ROOMS_KEY = 'task-board:rooms';

export async function registerBoardRoom(client: UpstashClient, code: string): Promise<void> {
  await client.pipeline([
    ['SADD', BOARD_ROOMS_KEY, code],
    ['EXPIRE', BOARD_ROOMS_KEY, ROOM_TTL_SECONDS],
  ]);
}

export async function unregisterBoardRoom(client: UpstashClient, code: string): Promise<void> {
  await client.command(['SREM', BOARD_ROOMS_KEY, code]);
}

export async function listBoardRooms(client: UpstashClient): Promise<string[]> {
  const members = await client.command<string[] | null>(['SMEMBERS', BOARD_ROOMS_KEY]);
  return Array.isArray(members) ? members : [];
}

async function getTaskBoardRaw(client: UpstashClient, code: string): Promise<string | null> {
  const raw = await client.command<string | null>(['GET', taskBoardKey(code)]);
  return raw === null || raw === undefined ? null : raw;
}

export async function getTaskBoard(client: UpstashClient, code: string): Promise<TaskBoard | null> {
  const raw = await getTaskBoardRaw(client, code);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as TaskBoard;
  } catch {
    return null;
  }
}

// Atomic compare-and-swap write, run server-side in Redis via EVAL: set the
// board to nextRaw ONLY if the stored value is still exactly what we last read
// (expectedRaw), or still absent when expectedRaw is null. Returns true if it
// wrote, false on a conflict. This is the real CAS the previous unconditional
// SET lacked — without it, two concurrent writers (a verify, a board-review
// stamp, a marker apply, the cron) both read vN and both wrote vN+1, so the
// later write clobbered the earlier one (a 'done' would flash then revert), and
// a transient null read made the mutator run on an empty board and blank the
// whole board to 0. The CAS makes both cases retry against fresh state instead.
const CAS_SCRIPT =
  "local cur = redis.call('GET', KEYS[1])\n" +
  "if ARGV[1] == 'absent' then\n" +
  "  if cur then return 0 end\n" +
  "else\n" +
  "  if cur ~= ARGV[2] then return 0 end\n" +
  "end\n" +
  "redis.call('SET', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[4]))\n" +
  "return 1";

async function casWriteTaskBoard(
  client: UpstashClient,
  code: string,
  expectedRaw: string | null,
  nextRaw: string,
): Promise<boolean> {
  const res = await client.command<number>([
    'EVAL', CAS_SCRIPT, '1', taskBoardKey(code),
    expectedRaw === null ? 'absent' : 'present',
    expectedRaw ?? '',
    nextRaw,
    String(ROOM_TTL_SECONDS),
  ]);
  return Number(res) === 1;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// CAS wrapper. The mutator returns the next board; it may throw to abort (e.g. a
// validation error), which propagates out. On a write conflict we re-read the
// fresh board and re-run the mutator, so a concurrent change is never clobbered.
async function casTaskBoard(
  client: UpstashClient,
  code: string,
  mutator: (current: TaskBoard) => TaskBoard,
): Promise<TaskBoard> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const raw = await getTaskBoardRaw(client, code);
    let current: TaskBoard;
    if (raw === null) {
      current = { code, tasks: [], version: 0 };
    } else {
      try { current = JSON.parse(raw) as TaskBoard; }
      catch { current = { code, tasks: [], version: 0 }; } // corrupt → reset; CAS still guards
    }
    let next: TaskBoard;
    try {
      next = mutator(current);
    } catch (e) {
      if (e instanceof ConcurrencyError) { lastError = e; continue; }
      throw e;
    }
    next.version = current.version + 1;
    if (await casWriteTaskBoard(client, code, raw, JSON.stringify(next))) {
      return next;
    }
    // Lost the race — another writer changed the board between our read and
    // write. Back off briefly and retry against the fresh state.
    lastError = new ConcurrencyError();
    await sleep(20 + Math.floor(Math.random() * 50));
  }
  throw lastError instanceof ConcurrencyError ? lastError : new ConcurrencyError();
}

function findTask(board: TaskBoard, id: string): Task {
  const t = board.tasks.find(x => x.id === id);
  if (!t) throw new TaskNotFoundError(id);
  return t;
}

function replaceTask(board: TaskBoard, next: Task): TaskBoard {
  return { ...board, tasks: board.tasks.map(t => (t.id === next.id ? next : t)) };
}

export interface CreateTaskInput {
  id?: string;            // optional; auto-assigned T-NN when omitted
  title: string;
  owner?: string;
  ownerClient?: ClientKind;
  verifier?: string;
  verifierClient?: ClientKind;
  dod?: string;
  createdBy: string;
}

function nextTaskId(board: TaskBoard): string {
  let max = 0;
  for (const t of board.tasks) {
    const m = /^T-(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `T-${String(max + 1).padStart(2, '0')}`;
}

export async function createTask(
  client: UpstashClient,
  code: string,
  input: CreateTaskInput,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  // Validate before touching Redis so a bad creation fails fast. A task whose
  // designated verifier IS the owner would be self-verifiable, defeating the
  // whole evidence gate — verifyTask would then let the producer rule on their
  // own delivery. Compare case-insensitively so "gpt" vs "GPT" can't slip by.
  const ownerName = input.owner?.trim().toLowerCase();
  const verifierName = input.verifier?.trim().toLowerCase();
  if (ownerName && verifierName && ownerName === verifierName) {
    throw new TaskStateError(
      `Task verifier (${input.verifier}) must be different from the owner (${input.owner}) — a producer cannot verify their own delivery.`,
    );
  }
  let created: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const id = input.id?.trim() || nextTaskId(current);
    if (current.tasks.some(t => t.id === id)) throw new TaskExistsError(id);
    created = {
      id,
      title: input.title,
      owner: input.owner,
      ownerClient: input.ownerClient,
      verifier: input.verifier,
      verifierClient: input.verifierClient,
      dod: input.dod,
      state: 'todo',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    return { ...current, tasks: [...current.tasks, created], lastProgressAt: now };
  });
  // Index this room for the periodic board-review sweep (best-effort).
  await registerBoardRoom(client, code).catch(() => { /* best-effort */ });
  return { board, task: created! };
}

// A producer claims a task → 'in_progress'. Records ownership if not already set.
// Rejects when the claimer is the designated verifier — otherwise owner==verifier
// and the task can never be verified (T-13 deadlock). Mirrors createTask's guard.
export async function claimTask(
  client: UpstashClient,
  code: string,
  id: string,
  owner: { name: string; client: ClientKind },
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'done') {
      throw new TaskStateError(`Task ${id} is already done; reopen it before claiming.`);
    }
    if (claimerIsDesignatedVerifier(task, owner)) {
      throw new VerifierCannotClaimError(id, task.verifier!);
    }
    updated = {
      ...task,
      owner: owner.name,
      ownerClient: owner.client,
      state: 'in_progress',
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: updated! };
}

// Moderator-mode reassignment: hand a blocked agent's task to a different agent.
// The task is reset to 'todo' (fresh work for the new owner) with any stale
// evidence/verdict cleared, and the OLD owner's reliability `blocks` tally is
// incremented; crossing TASK_BLOCK_DEMOTE_THRESHOLD marks them low-capability
// (demotedAt). `demoted` in the result is true only on the turn it first
// crosses, so the caller can announce it once.
export async function reassignTask(
  client: UpstashClient,
  code: string,
  id: string,
  newOwner: { name: string; client: ClientKind },
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task; fromOwner?: string; demoted: boolean; blocks: number }> {
  let updated: Task;
  let fromOwner: string | undefined;
  let demoted = false;
  let blocks = 0;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'done') {
      throw new TaskStateError(`Task ${id} is already done; reopen it before reassigning.`);
    }
    fromOwner = task.owner;
    updated = {
      ...task,
      owner: newOwner.name,
      ownerClient: newOwner.client,
      state: 'todo',
      evidence: undefined,
      verdict: undefined,
      readinessNote: undefined,
      updatedAt: now,
    };
    let next: TaskBoard = { ...replaceTask(current, updated), lastProgressAt: now };
    // Only tally a block when we actually moved it off a *different* owner.
    if (fromOwner && fromOwner !== newOwner.name) {
      const rel = { ...(next.reliability ?? {}) };
      const prev = rel[fromOwner] ?? { blocks: 0 };
      blocks = prev.blocks + 1;
      const justCrossed = prev.demotedAt === undefined && blocks >= TASK_BLOCK_DEMOTE_THRESHOLD;
      demoted = justCrossed;
      rel[fromOwner] = { blocks, demotedAt: prev.demotedAt ?? (justCrossed ? now : undefined) };
      next = { ...next, reliability: rel };
    }
    return next;
  });
  return { board, task: updated!, fromOwner, demoted, blocks };
}

export interface ReassignTaskRolesPatch {
  owner?: string;
  ownerClient?: ClientKind;
  verifier?: string;
  verifierClient?: ClientKind;
}

// Role reassignment (host / moderator escape hatch): change a task's owner
// and/or verifier WITHOUT touching its state — the in-system path for handing
// work off an agent whose client is tool-blocked. Unlike reassignTask above
// it does not reset the task to 'todo', clear evidence, or tally reliability
// blocks; it only swaps who is responsible, and appends each change to the
// task's roleHistory so the escape hatch stays auditable (who, when, from → to).
//
// AUTHORIZATION IS THE CALLER'S JOB (api/room.ts gates this on the proven
// host or the room's configured Moderator/Lead resolved from stored room
// state) — this function only enforces the state machine:
//   - a 'done' task is locked (TaskDoneImmutableError), same as host edits;
//   - the RESULTING owner and verifier must differ (the same case-insensitive
//     guard createTask applies), so a reassignment can never make a task
//     self-verifiable and defeat the evidence gate.
export async function reassignTaskRoles(
  client: UpstashClient,
  code: string,
  id: string,
  patch: ReassignTaskRolesPatch,
  actor: { name: string; client: ClientKind },
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  const newOwner = patch.owner?.trim();
  const newVerifier = patch.verifier?.trim();
  if (patch.owner !== undefined && !newOwner) throw new TaskStateError('New owner name cannot be empty.');
  if (patch.verifier !== undefined && !newVerifier) throw new TaskStateError('New verifier name cannot be empty.');
  if (newOwner === undefined && newVerifier === undefined) {
    throw new TaskStateError('Reassigning task roles requires a new owner and/or verifier.');
  }
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'done') throw new TaskDoneImmutableError(id);
    // Validate the RESULT of applying the patch — a new owner colliding with
    // the existing verifier (or vice versa) is just as self-verifiable as
    // setting both at once. Mirrors the createTask owner==verifier guard.
    const resultingOwner = newOwner ?? task.owner;
    const resultingVerifier = newVerifier ?? task.verifier;
    if (resultingOwner && resultingVerifier
      && resultingOwner.trim().toLowerCase() === resultingVerifier.trim().toLowerCase()) {
      throw new TaskStateError(
        `Task verifier (${resultingVerifier}) must be different from the owner (${resultingOwner}) — a producer cannot verify their own delivery.`,
      );
    }
    const audit: TaskRoleChange[] = [];
    if (newOwner !== undefined && newOwner !== task.owner) {
      audit.push({ by: actor.name, byClient: actor.client, at: now, field: 'owner', from: task.owner, to: newOwner });
    }
    if (newVerifier !== undefined && newVerifier !== task.verifier) {
      audit.push({ by: actor.name, byClient: actor.client, at: now, field: 'verifier', from: task.verifier, to: newVerifier });
    }
    updated = {
      ...task,
      ...(newOwner !== undefined ? { owner: newOwner, ownerClient: patch.ownerClient } : {}),
      ...(newVerifier !== undefined ? { verifier: newVerifier, verifierClient: patch.verifierClient } : {}),
      ...(audit.length ? { roleHistory: [...(task.roleHistory ?? []), ...audit] } : {}),
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: updated! };
}

function assertEvidenceComplete(e: Partial<TaskEvidence>): void {
  if (!e.fileListing || !e.fileListing.trim()) throw new EvidenceIncompleteError('fileListing is empty');
  if (!e.fileExcerpt || !e.fileExcerpt.trim()) throw new EvidenceIncompleteError('fileExcerpt is empty');
  if (!e.runOutput || !e.runOutput.trim()) throw new EvidenceIncompleteError('runOutput is empty');
  if (typeof e.exitCode !== 'number' || !Number.isFinite(e.exitCode)) {
    throw new EvidenceIncompleteError('exitCode is missing or not a number');
  }
}

// Producer submits evidence → 'awaiting_review'. THIS is the gate: a submission
// with any missing evidence part is rejected and the task does not move. The
// submitter becomes the recorded owner if none was set.
export async function submitTask(
  client: UpstashClient,
  code: string,
  id: string,
  submitter: { name: string; client: ClientKind },
  evidence: Omit<TaskEvidence, 'submittedBy' | 'submittedClient' | 'at'>,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  // Validate before touching Redis so a bad submission fails fast.
  assertEvidenceComplete(evidence);
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    const fullEvidence: TaskEvidence = {
      fileListing: evidence.fileListing,
      fileExcerpt: evidence.fileExcerpt,
      runOutput: evidence.runOutput,
      exitCode: evidence.exitCode,
      submittedBy: submitter.name,
      submittedClient: submitter.client,
      at: now,
    };
    updated = {
      ...task,
      owner: task.owner ?? submitter.name,
      ownerClient: task.ownerClient ?? submitter.client,
      state: 'awaiting_review',
      evidence: fullEvidence,
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: updated! };
}

// Light "ready for review" path for marker-driven hosted-agent rooms: the
// owner states what they did (a non-code task has no runnable 3-part evidence)
// and the task moves to 'awaiting_review'. A NON-owner peer must still confirm
// via verifyTask to reach 'done', so peer verification — the actual
// anti-phantom-delivery property — is preserved; only the machine-checkable
// 3-part code evidence is relaxed. Code tasks should still use submitTask.
export async function submitForReview(
  client: UpstashClient,
  code: string,
  id: string,
  submitter: { name: string; client: ClientKind },
  note: string,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  const clean = note.trim();
  if (!clean) throw new TaskStateError('A readiness note is required to submit for review.');
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    updated = {
      ...task,
      owner: task.owner ?? submitter.name,
      ownerClient: task.ownerClient ?? submitter.client,
      state: 'awaiting_review',
      readinessNote: clean,
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: updated! };
}

// The ONLY path to 'done' / 'rejected'. Enforces:
//   - the task is awaiting review (you cannot verify thin air);
//   - the caller is not the owner (no self-verification, ever);
//   - if a verifier is designated, the caller must be that verifier.
export async function verifyTask(
  client: UpstashClient,
  code: string,
  id: string,
  verifier: { name: string; client: ClientKind },
  verdict: 'done' | 'rejected',
  note: string | undefined,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state !== 'awaiting_review') {
      throw new TaskStateError(`Task ${id} is '${task.state}', not 'awaiting_review' — nothing to verify. The producer must submit evidence first.`);
    }
    // Owner can never verify their own delivery. When ownerClient was never
    // recorded (createTask accepts an owner name alone), the safe direction is
    // to BLOCK on a bare name match — otherwise the producer could self-verify
    // just because the client kind was missing.
    if (task.owner && task.owner === verifier.name
      && (task.ownerClient === undefined || task.ownerClient === verifier.client)) {
      throw new OwnerCannotVerifyError(id);
    }
    // If a verifier is designated, only they may rule. When verifierClient was
    // never recorded, match on name alone — requiring an undefined client to
    // equal the caller's made such tasks permanently unverifiable.
    if (task.verifier && !(task.verifier === verifier.name
      && (task.verifierClient === undefined || task.verifierClient === verifier.client))) {
      throw new NotVerifierError(id, task.verifier);
    }
    updated = {
      ...task,
      state: verdict === 'done' ? 'done' : 'rejected',
      verdict: { verdict, note, by: verifier.name, byClient: verifier.client, at: now },
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: updated! };
}

// Edit a task's mutable fields and/or correct its scope. This is the path the
// periodic board review uses to fix a task that turned out to be wrong, split,
// or off-track, and to REOPEN a task (done/rejected/awaiting_review → todo or
// in_progress). It deliberately CANNOT set 'done' or 'awaiting_review': those
// remain reachable only through submitTask (evidence) + verifyTask (peer
// ruling), so the anti-phantom-delivery gate can't be edited around.
export interface UpdateTaskInput {
  title?: string;
  dod?: string;
  verifier?: string;
  verifierClient?: ClientKind;
  /** Reopen / re-scope only. Allowed: 'todo' | 'in_progress' | 'rejected'. */
  state?: Extract<TaskState, 'todo' | 'in_progress' | 'rejected'>;
}

const REOPENABLE_TARGET_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['todo', 'in_progress', 'rejected']);

export async function updateTask(
  client: UpstashClient,
  code: string,
  id: string,
  patch: UpdateTaskInput,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  if (patch.state && !REOPENABLE_TARGET_STATES.has(patch.state)) {
    throw new TaskStateError(`updateTask cannot set state '${patch.state}'. Use submitTask (evidence) then verifyTask to reach 'awaiting_review'/'done'.`);
  }
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    updated = {
      ...task,
      ...(patch.title !== undefined && patch.title.trim() ? { title: patch.title.trim() } : {}),
      ...(patch.dod !== undefined ? { dod: patch.dod } : {}),
      ...(patch.verifier !== undefined ? { verifier: patch.verifier, verifierClient: patch.verifierClient } : {}),
      ...(patch.state ? { state: patch.state } : {}),
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: updated! };
}

export class TaskDoneImmutableError extends UpstashError {
  constructor(id: string) {
    super(`Task ${id} is 'done' — completed tasks are locked and cannot be changed.`);
    this.name = 'TaskDoneImmutableError';
  }
}

// Host override: the human who owns the room is the ultimate authority on the
// board, so they may set any NOT-done task to any state — including straight
// to 'done', bypassing the evidence gate (the gate exists to stop AGENTS from
// phantom-delivering; the paying human ruling by hand is the point of the
// gate, not a violation of it). The one hard rule, per product decision:
// 'done' is terminal for hosts — a completed task can never be flipped back.
// Caller MUST have already authenticated the host (hostKey) — this function
// only enforces the state machine.
export async function hostSetTaskState(
  client: UpstashClient,
  code: string,
  id: string,
  state: TaskState,
  hostName: string,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'done') throw new TaskDoneImmutableError(id);
    if (task.state === state) return current;
    updated = {
      ...task,
      state,
      ...(state === 'done' || state === 'rejected'
        ? { verdict: { verdict: state === 'done' ? 'done' as const : 'rejected' as const, note: 'Set by host', by: hostName, byClient: 'web' as ClientKind, at: now } }
        : {}),
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: updated! ?? findTask(board, id) };
}

function nextSubtaskId(task: Task): string {
  let max = 0;
  for (const s of task.subtasks ?? []) {
    const m = /^S-(\d+)$/.exec(s.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `S-${String(max + 1).padStart(2, '0')}`;
}

// Add a checklist item under a task. Subtasks are not evidence-gated.
export async function addSubtask(
  client: UpstashClient,
  code: string,
  taskId: string,
  title: string,
  by: { name: string; client: ClientKind },
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task; subtask: SubTask }> {
  const clean = title.trim();
  if (!clean) throw new TaskStateError('Subtask title is required.');
  let updated: Task;
  let created: SubTask;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, taskId);
    created = { id: nextSubtaskId(task), title: clean, done: false, updatedAt: now };
    updated = { ...task, subtasks: [...(task.subtasks ?? []), created], updatedAt: now };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: updated!, subtask: created! };
}

// Tick / untick a subtask. Self-ticking is fine — the parent task still needs
// peer verification to reach 'done'.
export async function toggleSubtask(
  client: UpstashClient,
  code: string,
  taskId: string,
  subtaskId: string,
  done: boolean,
  by: { name: string; client: ClientKind },
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, taskId);
    const subs = task.subtasks ?? [];
    if (!subs.some(s => s.id === subtaskId)) {
      throw new TaskNotFoundError(`${taskId}/${subtaskId}`);
    }
    updated = {
      ...task,
      subtasks: subs.map(s => (s.id === subtaskId
        ? { ...s, done, doneBy: done ? by.name : undefined, doneClient: done ? by.client : undefined, updatedAt: now }
        : s)),
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: updated! };
}

// Stamp lastReviewAt after a periodic board review pass. Best-effort bookkeeping
// (debounces the next review); does NOT bump lastProgressAt, so a no-op review
// doesn't reset the stall-nudge clock.
export async function recordBoardReview(client: UpstashClient, code: string, now: number = Date.now(), msgCount?: number): Promise<void> {
  await casTaskBoard(client, code, (current) => ({
    ...current,
    lastReviewAt: now,
    ...(msgCount !== undefined ? { lastReviewMsgCount: msgCount } : {}),
  }));
}

// True when the board has open work and it has been at least intervalMs since
// the last review pass (or there has never been one). Drives the ~20s review
// cadence; the caller debounces the actual agent wake-up off this.
export function boardNeedsReview(board: TaskBoard, intervalMs: number, now: number = Date.now()): boolean {
  if (openTasks(board).length === 0) return false;
  const last = board.lastReviewAt ?? 0;
  return now - last >= intervalMs;
}

export async function clearTaskBoard(client: UpstashClient, code: string): Promise<void> {
  await client.command(['DEL', taskBoardKey(code)]);
  await unregisterBoardRoom(client, code).catch(() => { /* best-effort */ });
}

// ── Board-sweep helpers (used by the server's periodic task-board sweep) ──

export function allTasksDone(board: TaskBoard): boolean {
  return board.tasks.length > 0 && board.tasks.every(t => t.state === 'done');
}

// Agents the moderator has marked low-capability (no new assignments). Reads the
// reliability tally maintained by reassignTask.
export function demotedAgents(board: TaskBoard): string[] {
  const rel = board.reliability ?? {};
  return Object.keys(rel).filter(name => rel[name]?.demotedAt !== undefined);
}

export function isAgentDemoted(board: TaskBoard, name: string): boolean {
  return board.reliability?.[name]?.demotedAt !== undefined;
}

export function agentBlocks(board: TaskBoard, name: string): number {
  return board.reliability?.[name]?.blocks ?? 0;
}

export function openTasks(board: TaskBoard): Task[] {
  return board.tasks.filter(t => t.state !== 'done');
}

export function doneTasks(board: TaskBoard): Task[] {
  return board.tasks.filter(t => t.state === 'done');
}

// Source of truth for "delivered" in minutes / room summaries: verified-done
// board tasks. Returns null when there is no board (caller falls back to LLM).
export function deliveredFromBoard(board: TaskBoard | null | undefined): boolean | null {
  if (!board?.tasks.length) return null;
  return doneTasks(board).length > 0;
}

export function formatDeliveredTask(task: Task): string {
  const verifier = task.verdict?.by ? ` (verified by ${task.verdict.by})` : '';
  const listing = task.evidence?.fileListing?.trim().split('\n').find(Boolean);
  const evidence = listing ? ` — ${listing}` : '';
  return `${task.id}: ${task.title}${verifier}${evidence}`;
}

export function deliverablesFromBoard(board: TaskBoard | null | undefined): string[] {
  if (!board) return [];
  return doneTasks(board).map(formatDeliveredTask);
}

// Prompt / report seed: verified-done tasks the analytics layer must honor.
export function boardDeliveredSection(board: TaskBoard | null | undefined): string {
  if (!board?.tasks.length) return '';
  const done = doneTasks(board);
  if (!done.length) {
    return [
      `任务板（${board.tasks.length} 项任务，尚无 verified-done）：`,
      summarizeBoard(board),
      '若任务板存在但无一 done，"delivered" 必须为 false。',
    ].join('\n');
  }
  return [
    '任务板 verified-done 交付（以此为准判断 delivered，勿被聊天 prose 误导）：',
    ...done.map(formatDeliveredTask),
  ].join('\n');
}

// Board summary for reminder messages / the listen payload.
// Open tasks (todo / in_progress / awaiting_review / rejected) stay one line
// each; verified-done tasks collapse to a single trailing "✅ N done" line.
export function summarizeBoard(board: TaskBoard): string {
  const icon: Record<TaskState, string> = {
    todo: '⬜', in_progress: '🔵', awaiting_review: '🟡', done: '✅', rejected: '🔴',
  };
  const open = board.tasks.filter(t => t.state !== 'done');
  const doneCount = board.tasks.length - open.length;
  const lines = open.map(
    t => `${icon[t.state]} ${t.id} ${t.title}${t.owner ? ` (@${t.owner})` : ''} — ${t.state}`,
  );
  if (doneCount > 0) lines.push(`✅ ${doneCount} done`);
  return lines.join('\n');
}

// Debounce bookkeeping writes. Best-effort; callers ignore failures.
export async function recordStallNudge(client: UpstashClient, code: string, now: number = Date.now()): Promise<void> {
  await casTaskBoard(client, code, (current) => ({ ...current, lastStallNudgeAt: now }));
}

export async function recordCompletionAnnounced(client: UpstashClient, code: string, now: number = Date.now()): Promise<void> {
  await casTaskBoard(client, code, (current) => ({ ...current, completionAnnouncedAt: now }));
}

// Re-export the task state type so callers importing from upstash-client can
// reference the canonical union without also importing @agent-room/shared.
export type { Task, TaskBoard, TaskEvidence, TaskRoleChange, TaskState };
