import type { Task, TaskBoard } from './types.js';

/**
 * What the board is waiting on from one agent.
 *
 * The board does notify — that part works. Every action emits a sys message
 * naming the agent (emitTaskSysMessage in api/room.ts), and a stall nudge fires
 * off the room poll loop listing everything still open. Both land in the
 * transcript, so anyone holding a room_listen sees them.
 *
 * The problem is that a transcript notification is ephemeral: it reaches
 * whoever is present at that instant and nobody else. Reconnect and you get the
 * last 16 messages plus a digest, in which a board event from four hours and
 * three hundred messages ago does not survive. There is no durable "what do I
 * owe" an agent can ask for on the way back in — room_task list exists, but
 * nothing tells a returning agent to call it.
 *
 * Observed 2026-09-07 in RCC-FY5-75M. Claude held one continuous session and
 * knew about every task the moment it moved. Codex kept dropping out, so the
 * pushes went out while it was gone; T-02 and T-04 sat in awaiting_review on it
 * for just under four hours, its verifier slot reassigned four times while
 * people worked around it. When it was finally told by hand, it re-ran both
 * suites independently and caught a release blocker nobody else had. It was
 * never unwilling. It was never there when the room said its name.
 *
 * So this is the same information, made durable and pull-able.
 *
 * Verifier work is listed before owner work: a task in awaiting_review is
 * blocking somebody else, an owned todo is not.
 */
export interface TaskInbox {
  /** Ids awaiting this agent's verdict. */
  toVerify: string[];
  /** Ids this agent owns that are not finished. */
  toDo: string[];
  /** Owned tasks that must be executed/resumed before another listen. */
  current: string[];
  /** Owned todo tasks waiting to be claimed. */
  queued: string[];
  /** One line naming what is waiting, or '' when nothing is. */
  hint: string;
}

const OPEN_OWNER_STATES = new Set(['todo', 'in_progress', 'rejected', 'blocked']);

const CREATE_CALL = 'room_task({ action: "create", title, dod }) then action: "claim".';

/** Said only when the room addressed this agent and the board holds nothing for it. */
const OPEN_ONE =
  'BOARD: nothing on the board is yours. If what was just asked of you is work, it is a task — '
  + `open it yourself, nobody assigns them here: ${CREATE_CALL}`;

function isFor(who: string | undefined, name: string): boolean {
  return Boolean(who) && who!.trim().toLowerCase() === name.trim().toLowerCase();
}

/**
 * The channel was silent at the one moment it mattered most.
 *
 * Everything above answers "what does the board owe me", and returns nothing
 * when the answer is "nothing" — correct for a returning agent, and exactly
 * wrong for an agent that has just been asked to do something. ED9-FKF-4SK and
 * FQ5-H8E-CXN, 2026-09-08: the human asked for work, the board was empty, so
 * the field was omitted entirely and the only guidance left was a tool
 * description the agent would have had to go and look up.
 *
 * `addressed` is the server's own answer to "was this aimed at you" (wakesAgent,
 * or soleAgentOf in a one-agent room). When it is true, an empty inbox is not
 * silence — it is the moment to open a task. Naming the call and its arguments
 * matters more here than anywhere else: a Codex host puts tool descriptions in
 * a sandbox array rather than the model's context, so the argument list may
 * never have been read at all. A result field always arrives.
 */
export function taskInboxFor(
  board: Pick<TaskBoard, 'tasks'> | null | undefined,
  name: string,
  opts: { addressed?: boolean } = {},
): TaskInbox {
  const empty: TaskInbox = { toVerify: [], toDo: [], current: [], queued: [], hint: '' };
  if (!name.trim()) return empty;
  if (!board?.tasks?.length) return opts.addressed ? { ...empty, hint: OPEN_ONE } : empty;

  const toVerify: string[] = [];
  const active: string[] = [];
  const queued: string[] = [];
  for (const task of board.tasks as Task[]) {
    if (task.state === 'awaiting_review' && isFor(task.verifier, name)) {
      toVerify.push(task.id);
    } else if (OPEN_OWNER_STATES.has(task.state) && isFor(task.owner, name)) {
      if (task.state === 'in_progress' || task.state === 'rejected' || task.state === 'blocked') {
        active.push(task.id);
      } else {
        queued.push(task.id);
      }
    }
  }
  // Current work always comes before queued work, even if the board was
  // created in another order. This gives weak agents one unambiguous next
  // action instead of a flat bag of ids.
  const toDo = [...active, ...queued];
  if (!toVerify.length && !toDo.length) {
    if (!opts.addressed) return empty;
    // Somebody else's unclaimed todo is takeable; otherwise open your own.
    const free = (board.tasks as Task[]).filter(t => t.state === 'todo' && !isFor(t.owner, name));
    if (!free.length) return { ...empty, hint: OPEN_ONE };
    const ids = free.map(t => t.id).join(', ');
    return {
      ...empty,
      hint: `BOARD: nothing on the board is yours. ${ids} ${free.length === 1 ? 'is' : 'are'} unclaimed `
        + `— take one with room_task({ action: "claim", id }), or open a new one: ${CREATE_CALL}`,
    };
  }

  const parts: string[] = [];
  if (toVerify.length) {
    parts.push(
      `${toVerify.join(', ')} ${toVerify.length === 1 ? 'is' : 'are'} awaiting YOUR verdict `
      + '— nobody else can rule on them. Re-run the evidence yourself, then '
      + 'room_task({ action: "verify", id, verdict, note }).',
    );
  }
  if (toDo.length) {
    if (active.length) {
      parts.push(
        `CURRENT WORK: ${active.join(', ')}. Do the work now; do not answer with a status-only message. `
        + 'When its done-when criteria pass, update the board with room_task({ action: "submit", id, '
        + 'fileListing, fileExcerpt, and either runOutput + exitCode or checks }). ',
      );
    }
    if (queued.length) {
      const first = queued[0]!;
      parts.push(
        `${queued.join(', ')} ${queued.length === 1 ? 'is' : 'are'} `
        + `${active.length ? 'queued behind current work' : 'your queued work'}. `
        + `${active.length ? `After submitting ${active[0]}, immediately ` : 'Immediately '}`
        + `claim ${first} with room_task({ action: "claim", id: "${first}" }) and continue working; `
        + 'do not stop at a progress report or wait for review unless the next task depends on that verdict.',
      );
    }
  }
  return { toVerify, toDo, current: active, queued, hint: `BOARD: ${parts.join(' ')}` };
}

/**
 * Per-agent call-outs for the stall reminder, @-named.
 *
 * The naming is the point, not politeness. An agent listening with
 * wakeOn: "addressed" — which is what the Codex loop in SERVER_INSTRUCTIONS
 * now does — only surfaces early for messages that carry its name. The old
 * reminder said "@owners: submit evidence. Verifiers: rule on anything
 * awaiting_review", which names nobody, so it could not wake the agents it was
 * written for. It reached exactly the agents that did not need reminding: the
 * ones already sitting in the room reading everything.
 *
 * Ordered by first appearance on the board so the output is stable.
 */
export function boardCallouts(board: Pick<TaskBoard, 'tasks'> | null | undefined): string[] {
  if (!board?.tasks?.length) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  const remember = (who?: string) => {
    const name = who?.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };
  for (const task of board.tasks as Task[]) {
    if (task.state === 'awaiting_review') remember(task.verifier);
    else if (OPEN_OWNER_STATES.has(task.state)) remember(task.owner);
  }

  const lines: string[] = [];
  for (const name of names) {
    const { toVerify, toDo } = taskInboxFor(board, name);
    const parts: string[] = [];
    if (toVerify.length) {
      parts.push(`${toVerify.join(', ')} ${toVerify.length === 1 ? 'is' : 'are'} awaiting your verdict`);
    }
    if (toDo.length) {
      parts.push(`you own ${toDo.join(', ')}`);
    }
    if (parts.length) lines.push(`@${name} ${parts.join('; ')}.`);
  }
  return lines;
}
