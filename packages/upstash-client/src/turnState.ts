import type { ClientKind, Participant, ReplyMode, RoleInTurn, Room } from '@agent-room/shared';
import {
  DEFAULT_LEAD_GRACE_MS,
  DEFAULT_TURN_TIMEOUTS_MS,
  FIRST_RESPONSE_GRACE_MS,
  ROOM_TTL_SECONDS,
  TURN_HARD_CAP_MS,
  TURN_RENEWAL_MS,
} from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { ConcurrencyError } from './errors.js';
import { casRoom } from './rooms.js';

// Turn state for a room. Lives in its own Redis key (`turn-state:{code}`) so
// the room JSON stays small and the high-write turn cursor (currentName /
// deadline / queue) doesn't churn the room's optimistic-concurrency version.
// Ephemeral by design — the TTL matches the room's, and a server restart
// mid-turn just resets the turn (intentional: see TURN_RESET_ON_RESTART_NOTE
// below). Persisted room config (replyMode, modeConfig) is what survives.
//
// Naming convention: 'turn' here refers to one user/host message + the
// resulting agent reply chain. A new turn starts when a fresh human message
// arrives in sequential/moderator mode. Within a turn the queue advances
// agent-by-agent until either every queued agent has spoken / been skipped,
// or the host sends another message (which aborts and starts a new turn).

export interface TurnQueueEntry {
  name: string;
  client: ClientKind;
  role: RoleInTurn;
}

export type TurnSpokenStatus =
  | 'replied'
  | 'skipped'
  | 'timed_out'
  | 'no_addition'
  | 'skipped_by_grace';

export interface TurnSpokenEntry {
  name: string;
  client: ClientKind;
  role: RoleInTurn;
  status: TurnSpokenStatus;
  at: number;
  // Sequential round-robin: which round (1-based) this entry belongs to.
  // Lets advanceRoundOrEnd tell whether the round just finished produced a
  // reply. Undefined for moderator mode.
  round?: number;
}

export interface TurnState {
  // Stable id for the current turn (epoch ms at turn start). Used in
  // Message.metadata.turnId so reports/UI can group lead+supplements
  // together.
  turnId: number;
  // Snapshot of the mode at turn-start. If room.replyMode changes mid-turn,
  // the next read of TurnState aborts and clears this object.
  mode: ReplyMode;

  // Sequential mode: the agent who answered first this turn. Stays set
  // for the whole turn even after they hand off to supplements.
  leadName?: string;
  leadClient?: ClientKind;

  // Moderator mode (Slice C): the routing agent.
  moderatorName?: string;
  moderatorClient?: ClientKind;

  // Who is currently allowed to speak. Undefined when the turn is complete
  // (every queued agent has spoken/skipped) but the turnState record is
  // still around for late-arrival debugging.
  currentName?: string;
  currentClient?: ClientKind;
  currentRole?: RoleInTurn;
  // Epoch-ms by which currentName must produce a message. If Date.now()
  // exceeds this on the next read, advanceOnTimeout() skips and moves on.
  // Sequential mode: starts as a short FIRST_RESPONSE_GRACE window and is
  // pushed out by each room_status heartbeat (see renewTurnDeadline).
  deadline?: number;

  // Sequential mode: absolute epoch-ms ceiling for the current speaker —
  // set when they take the floor (= now + TURN_HARD_CAP_MS). room_status
  // heartbeats renew `deadline` but never past this, so a single agent
  // cannot hold a turn forever. Unset for moderator mode and once the
  // turn has no current speaker.
  hardDeadline?: number;

  // Sequential mode only: epoch-ms until which the Lead has the floor
  // exclusively. After this instant the queue-head supplement may also
  // speak — whichever lands first wins the turn. Unset for moderator
  // mode and for turns where the current speaker isn't (and never was)
  // the Lead. Cleared by advanceTurn / applyGraceSupplementReply when
  // we leave the lead slot, so a stale value can't accidentally re-fire.
  leadGraceUntil?: number;

  // FIFO queue of upcoming speakers.
  queue: TurnQueueEntry[];

  // Sequential round-robin: the current round number (1-based). Each round
  // is one full pass through the room's cc agents. When the queue empties,
  // advanceRoundOrEnd starts the next round or ends the turn.
  round?: number;

  // History of who already spoke this turn and how.
  spoken: TurnSpokenEntry[];

  // One-shot direct-invoke allowlist. An entry permits its (name, client)
  // to send exactly one message even when they would otherwise be
  // turn-gated; the entry is consumed on use. Sources:
  //   - 'host':      the room host called room_direct_invoke. Works in
  //                  any non-open mode; on consume the recipient's
  //                  message gets roleAtSend='host_directed'.
  //   - 'moderator': the Moderator agent called room_direct_invoke
  //                  while in moderator mode. On consume, the
  //                  recipient's message gets roleAtSend='assignee'
  //                  so the report can distinguish moderator-routed
  //                  work from host-overridden interjections.
  hostDirected?: Array<{
    name: string;
    client: ClientKind;
    addedAt: number;
    source?: 'host' | 'moderator';
  }>;
}

// TURN_RESET_ON_RESTART_NOTE — by design. Redis is the source of truth for
// turnState, with TTL = ROOM_TTL_SECONDS. If a serverless instance dies in
// the middle of a turn we still see the persisted record on next read and
// resume from `currentName`, so a restart does NOT reset a turn — only an
// explicit `clearTurnState` (mode change, host skip-all, room end) does.

function turnStateKey(code: string): string {
  return `turn-state:${code}`;
}

const CAS_MAX_ATTEMPTS = 3;

// Sequential mode runs as a round-robin: every cc agent speaks once per
// round, round after round, until a round produces no new content (everyone
// has converged) — capped here so a discussion that never converges still
// ends instead of looping forever.
export const SEQUENTIAL_MAX_ROUNDS = 10;

export async function getTurnState(client: UpstashClient, code: string): Promise<TurnState | null> {
  const raw = await client.command<string | null>(['GET', turnStateKey(code)]);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as TurnState;
  } catch {
    return null;
  }
}

export async function setTurnState(client: UpstashClient, code: string, state: TurnState): Promise<void> {
  await client.command(['SET', turnStateKey(code), JSON.stringify(state), 'EX', ROOM_TTL_SECONDS]);
}

export async function clearTurnState(client: UpstashClient, code: string): Promise<void> {
  await client.command(['DEL', turnStateKey(code)]);
}

// CAS wrapper analogous to casRoom. The mutator may return `null` to mean
// "delete this turnState" (mode change abort, host skip-all). Returning a
// new TurnState writes it back; returning the same reference is fine — we
// always SET on success.
export async function casTurnState(
  client: UpstashClient,
  code: string,
  mutator: (current: TurnState | null) => TurnState | null,
): Promise<TurnState | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const current = await getTurnState(client, code);
    let next: TurnState | null;
    try {
      next = mutator(current);
    } catch (e) {
      if (e instanceof ConcurrencyError) {
        lastError = e;
        continue;
      }
      throw e;
    }
    if (next === null) {
      if (current !== null) await clearTurnState(client, code);
      return null;
    }
    await setTurnState(client, code, next);
    return next;
  }
  throw lastError instanceof ConcurrencyError ? lastError : new ConcurrencyError();
}

// Resolve the lead-grace window in ms for this room. Honors the
// per-room override if present, otherwise DEFAULT_LEAD_GRACE_MS.
export function leadGraceMs(room: Room): number {
  return room.modeConfig?.leadGraceMs ?? DEFAULT_LEAD_GRACE_MS;
}

// Sequential mode: the deadline fields for an agent that has just become
// the current speaker — a short first-response window plus the absolute
// hard cap. room_status heartbeats renew `deadline` (see renewTurnDeadline)
// up to `hardDeadline`, which can never be pushed.
function freshSequentialDeadline(now: number): { deadline: number; hardDeadline: number } {
  return { deadline: now + FIRST_RESPONSE_GRACE_MS, hardDeadline: now + TURN_HARD_CAP_MS };
}

// Sequential mode: a room_status heartbeat from the current speaker pushes
// their working deadline out by TURN_RENEWAL_MS, capped at `hardDeadline`
// so the whole turn can never exceed TURN_HARD_CAP_MS from when the agent
// took the floor. No-op (returns the input) when the turn isn't sequential
// or has no current speaker. The deadline never moves backwards — a late
// ping can't shorten a turn.
export function renewTurnDeadline(state: TurnState, now: number = Date.now()): TurnState {
  if (state.mode !== 'sequential' || !state.currentName) return state;
  const cap = state.hardDeadline ?? now + TURN_RENEWAL_MS;
  const renewed = Math.min(now + TURN_RENEWAL_MS, cap);
  const deadline = Math.max(state.deadline ?? 0, renewed);
  return { ...state, deadline };
}

// Resolve the per-role timeout in ms for this room's modeConfig, falling
// back to DEFAULT_TURN_TIMEOUTS_MS for any role the host didn't override.
export function timeoutForRole(room: Room, role: RoleInTurn): number {
  const overrides = room.modeConfig?.timeoutMs ?? {};
  switch (role) {
    case 'lead': return overrides.lead ?? DEFAULT_TURN_TIMEOUTS_MS.lead;
    case 'supplement': return overrides.supplement ?? DEFAULT_TURN_TIMEOUTS_MS.supplement;
    case 'wrap': return overrides.wrap ?? DEFAULT_TURN_TIMEOUTS_MS.wrap;
    case 'moderator': return overrides.moderator ?? DEFAULT_TURN_TIMEOUTS_MS.moderator;
    case 'assignee': return overrides.assignee ?? DEFAULT_TURN_TIMEOUTS_MS.assignee;
    // 'open', 'human', 'host_directed' have no deadline — return a sentinel
    // (Infinity) so callers using min() treat them as never-expiring.
    default: return Number.POSITIVE_INFINITY;
  }
}

// Sequential mode: pick the agent who answers first. Honors the host's
// explicit choice in modeConfig; otherwise falls back to "first cc-client
// agent in join order". Returns undefined if no cc agents are present.
export function pickLeadForSequential(room: Room): { name: string; client: ClientKind } | undefined {
  const wantName = room.modeConfig?.leadAgentName;
  const wantClient = room.modeConfig?.leadAgentClient;
  const ccAgents = room.participants
    .filter(p => p.client === 'cc' && p.canSpeak !== false && p.name !== room.createdBy)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  if (wantName && wantClient) {
    const explicit = ccAgents.find(p => p.name === wantName && p.client === wantClient);
    if (explicit) return { name: explicit.name, client: explicit.client };
    // Configured Lead has left the room. Caller should detect this and
    // either pick the fallback (returned here as first cc) or abort the
    // mode — Slice B falls back, Slice C escalates to system message.
  }
  const fallback = ccAgents[0];
  return fallback ? { name: fallback.name, client: fallback.client } : undefined;
}

// Sequential mode: build the supplement queue from remaining cc agents in
// join order. Excludes the Lead and the host. Filters out muted agents.
export function buildSupplementQueue(
  room: Room,
  lead: { name: string; client: ClientKind } | undefined,
): TurnQueueEntry[] {
  return room.participants
    .filter(p => p.client === 'cc')
    .filter(p => p.canSpeak !== false)
    .filter(p => p.name !== room.createdBy)
    .filter(p => !(lead && p.name === lead.name && p.client === lead.client))
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(p => ({ name: p.name, client: p.client, role: 'supplement' as RoleInTurn }));
}

// Begin a new moderator turn triggered by a fresh human message. Unlike
// sequential, the moderator has no fixed queue — they speak first, then
// route work to specific agents via room_direct_invoke (which adds those
// agents to `hostDirected`). The Moderator stays the `current` speaker
// for the whole turn; their deadline resets each time they post a real
// message. If the Moderator goes silent past their deadline OR leaves the
// room, sweepTimeouts auto-falls-back to 'open' mode (Slice C).
//
// Returns null if the named Moderator is not present in the room (or has
// been muted). Callers should treat that as "moderator mode is currently
// non-functional — switch to open or pick a new moderator".
export function newModeratorTurn(
  room: Room,
  triggerMessageId: number,
  now: number = Date.now(),
): TurnState | null {
  const wantName = room.modeConfig?.moderatorAgentName;
  const wantClient = room.modeConfig?.moderatorAgentClient;
  if (!wantName || !wantClient) return null;
  const mod = room.participants.find(p =>
    p.name === wantName && p.client === wantClient && p.canSpeak !== false,
  );
  if (!mod) return null;
  return {
    turnId: now,
    mode: 'moderator',
    moderatorName: mod.name,
    moderatorClient: mod.client,
    currentName: mod.name,
    currentClient: mod.client,
    currentRole: 'moderator',
    deadline: now + timeoutForRole(room, 'moderator'),
    queue: [],
    spoken: [],
  };
}

// Begin a new sequential turn triggered by a fresh human message. Returns
// the new TurnState, or null if there are no cc agents in the room (in
// which case the human's message stands alone and no agent reply is
// expected).
export function newSequentialTurn(
  room: Room,
  triggerMessageId: number,
  now: number = Date.now(),
): TurnState | null {
  const lead = pickLeadForSequential(room);
  if (!lead) return null;
  const queue = buildSupplementQueue(room, lead);
  const leadRole: RoleInTurn = 'lead';
  return {
    turnId: now,
    mode: 'sequential',
    leadName: lead.name,
    leadClient: lead.client,
    currentName: lead.name,
    currentClient: lead.client,
    currentRole: leadRole,
    ...freshSequentialDeadline(now),
    // Lead-grace: queue-head supplement is unlocked after this instant
    // (only set if there's actually a supplement waiting — pointless
    // grace window if the Lead is the only agent).
    ...(queue.length > 0 ? { leadGraceUntil: now + leadGraceMs(room) } : {}),
    queue,
    round: 1,
    spoken: [],
  };
}

// Sequential turn drain. When the round's queue empties, decide whether the
// round-robin discussion continues or ends:
//   - if the round that just finished produced no substantive reply
//     (every agent sent __no_addition__ or timed out) the agents have
//     converged — the turn ends;
//   - else if SEQUENTIAL_MAX_ROUNDS rounds have already run, end anyway
//     (runaway guard for discussions that never converge);
//   - otherwise a fresh round starts: the speaker order is re-seeded from
//     the room's live cc agents (so agents who joined/left mid-discussion
//     are picked up) and the Lead takes the floor again.
//
// `spoken` is the already-extended spoken log; its entries are tagged with
// the round they belong to, so we can tell whether the finished round had
// a reply. `now` anchors the next speaker's deadline.
function advanceRoundOrEnd(
  state: TurnState,
  room: Room,
  spoken: TurnSpokenEntry[],
  now: number,
): TurnState {
  const ended: TurnState = {
    ...state,
    currentName: undefined,
    currentClient: undefined,
    currentRole: undefined,
    deadline: undefined,
    hardDeadline: undefined,
    leadGraceUntil: undefined,
    queue: [],
    spoken,
  };
  if (state.mode !== 'sequential') return ended;
  const round = state.round ?? 1;
  const roundReplied = spoken.some(e => e.round === round && e.status === 'replied');
  // Converged (nobody added anything this round) or hit the round cap.
  if (!roundReplied || round >= SEQUENTIAL_MAX_ROUNDS) return ended;
  // Start the next round, re-seeding the speaker order from the room.
  const lead = pickLeadForSequential(room);
  if (!lead) return ended;
  const queue = buildSupplementQueue(room, lead);
  return {
    ...state,
    round: round + 1,
    currentName: lead.name,
    currentClient: lead.client,
    currentRole: 'lead',
    ...freshSequentialDeadline(now),
    leadGraceUntil: queue.length > 0 ? now + leadGraceMs(room) : undefined,
    queue,
    spoken,
  };
}

// Advance the turn after the current speaker has produced a message (or
// been skipped). Pops the next queue entry into `current`, sets deadline.
// If the queue is empty, sequential mode issues a one-shot Lead 'wrap'
// turn (see endOrWrapSequential); once that wrap completes — or for
// moderator mode — current/deadline are cleared (turn complete; record is
// retained for `__no_addition__` lookback but accepts no more agents).
//
// `status` describes what the current speaker did:
//   - 'replied':      sent a regular reply
//   - 'no_addition':  responded with the supplement skip token
//   - 'timed_out':    deadline expired without a reply
//   - 'skipped':      host or system forced a skip
// In every case the spent speaker moves to the `spoken` log.
export function advanceTurn(
  state: TurnState,
  status: TurnSpokenStatus,
  room: Room,
  now: number = Date.now(),
): TurnState {
  if (!state.currentName || !state.currentClient || !state.currentRole) {
    return state;
  }
  const finished: TurnSpokenEntry = {
    name: state.currentName,
    client: state.currentClient,
    role: state.currentRole,
    status,
    at: now,
    round: state.round,
  };
  const nextQueue = state.queue.slice();
  const next = nextQueue.shift();
  if (!next) {
    return advanceRoundOrEnd(state, room, [...state.spoken, finished], now);
  }
  return {
    ...state,
    currentName: next.name,
    currentClient: next.client,
    currentRole: next.role,
    ...freshSequentialDeadline(now),
    // Grace only applies while a Lead is current. Once we hand off
    // (or skip past) the Lead, drop the field so dump-readers don't
    // see a stale value.
    leadGraceUntil: undefined,
    queue: nextQueue,
    spoken: [...state.spoken, finished],
  };
}

// Moderator mode: the Moderator just replied to the host. Unlike
// sequential, this does NOT advance the queue — the Moderator stays the
// current speaker until they either leave the room or stop responding
// (auto-fallback). We do log the reply in `spoken` for the transcript
// and refresh the deadline.
export function moderatorReply(
  state: TurnState,
  room: Room,
  now: number = Date.now(),
): TurnState {
  if (!state.currentName || !state.currentClient) return state;
  const finished: TurnSpokenEntry = {
    name: state.currentName,
    client: state.currentClient,
    role: 'moderator',
    status: 'replied',
    at: now,
  };
  return {
    ...state,
    deadline: now + timeoutForRole(room, 'moderator'),
    spoken: [...state.spoken, finished],
  };
}

// Lazy timeout check called from runRoomListenPoll and appendMessage. If
// the current speaker's deadline has passed, skip them and advance. Returns
// `[newState, skipped]` where `skipped` lists every speaker auto-skipped
// in this call (callers emit one sys message per skip). In practice this
// skips at most one speaker per call: each successor takes the floor with a
// fresh FIRST_RESPONSE_GRACE window measured from `now`, so a speaker is
// never retroactively skipped for time that elapsed (e.g. coalesced listen
// polls) before they actually held the turn. The cascade loop is kept for
// safety but normally runs a single iteration.
export function advanceOnTimeout(
  state: TurnState | null,
  room: Room,
  now: number = Date.now(),
): { state: TurnState | null; skipped: TurnSpokenEntry[] } {
  if (!state) return { state, skipped: [] };
  const skipped: TurnSpokenEntry[] = [];
  let cur: TurnState | null = state;
  // Cascade: keep skipping while the current speaker has a deadline that
  // has already expired. Stops at the first non-expired speaker or when
  // the queue empties out.
  while (cur && cur.deadline !== undefined && cur.deadline <= now && cur.currentName) {
    const skip: TurnSpokenEntry = {
      name: cur.currentName,
      client: cur.currentClient!,
      role: cur.currentRole!,
      status: 'timed_out',
      at: now,
      round: cur.round,
    };
    skipped.push(skip);
    cur = advanceTurn(cur, 'timed_out', room, now);
    // If the new `current` had no deadline (e.g. queue empty), exit loop.
    if (!cur.currentName) break;
  }
  return { state: cur, skipped };
}

// Is (name, client) the current turn-holder? Kept for tests and back-compat;
// production code should use canAgentSpeakNow which also honors lead grace.
export function isCurrentSpeaker(
  state: TurnState | null,
  name: string,
  client: ClientKind,
): boolean {
  if (!state || !state.currentName || !state.currentClient) return false;
  return state.currentName === name && state.currentClient === client;
}

// Internal: is this agent the queue-head supplement AND has lead-grace
// elapsed? Encapsulates the "supplement may preempt Lead" rule used by
// both canAgentSpeakNow and myRoleInTurn (and exported so messages.ts can
// branch on it after a successful speaker check).
function isGraceEligibleQueueHead(
  state: TurnState,
  name: string,
  client: ClientKind,
  now: number,
): boolean {
  if (state.mode !== 'sequential') return false;
  if (state.currentRole !== 'lead') return false;
  if (state.leadGraceUntil === undefined || now < state.leadGraceUntil) return false;
  const head = state.queue[0];
  if (!head) return false;
  return head.name === name && head.client === client;
}

// May (name, client) send a normal_turn message right now? True when they
// are the current speaker OR when sequential lead grace has elapsed and
// they are the queue-head supplement (head-of-line break). The Lead can
// still speak in parallel until their own deadline — first reply wins
// via CAS; the loser gets logged as skipped_by_grace.
export function canAgentSpeakNow(
  state: TurnState | null,
  name: string,
  client: ClientKind,
  now: number = Date.now(),
): boolean {
  if (!state || !state.currentName || !state.currentClient) return false;
  if (state.currentName === name && state.currentClient === client) return true;
  return isGraceEligibleQueueHead(state, name, client, now);
}

// True iff this agent passes canAgentSpeakNow specifically via the
// grace-eligible-queue-head path (i.e. they are NOT the current speaker).
// Used by messages.ts to pick the right roleAtSend + advance strategy.
export function isGraceSupplementSpeaker(
  state: TurnState | null,
  name: string,
  client: ClientKind,
  now: number = Date.now(),
): boolean {
  if (!state) return false;
  if (state.currentName === name && state.currentClient === client) return false;
  return isGraceEligibleQueueHead(state, name, client, now);
}

// Sequential lead-grace path: the queue-head supplement just replied while
// the Lead was still current. Mark the Lead as skipped_by_grace, log the
// supplement, drop the supplement from the queue, advance to the next
// speaker (or end of turn). Returns the new state + the lead's spoken
// entry so the caller can emit a sys message about the grace skip.
export function applyGraceSupplementReply(
  state: TurnState,
  supplementName: string,
  supplementClient: ClientKind,
  room: Room,
  now: number = Date.now(),
  supplementStatus: TurnSpokenStatus = 'replied',
): { state: TurnState; leadSkipped: TurnSpokenEntry } {
  const leadSkipped: TurnSpokenEntry = {
    name: state.currentName!,
    client: state.currentClient!,
    role: 'lead',
    status: 'skipped_by_grace',
    at: now,
    round: state.round,
  };
  const supplementEntry: TurnSpokenEntry = {
    name: supplementName,
    client: supplementClient,
    role: 'supplement',
    status: supplementStatus,
    at: now,
    round: state.round,
  };
  // Drop the queue-head supplement (the one that just spoke), THEN
  // advance to the next speaker. Note: we deliberately drop the Lead
  // from `current` without re-queueing — `skipped_by_grace` is terminal.
  const remaining = state.queue.slice(1);
  const next = remaining.shift();
  const spoken = [...state.spoken, leadSkipped, supplementEntry];
  if (!next) {
    // Queue drained via the grace path — hand off to the round-robin drain,
    // which starts the next round or ends the turn on convergence.
    return {
      state: advanceRoundOrEnd(state, room, spoken, now),
      leadSkipped,
    };
  }
  return {
    state: {
      ...state,
      currentName: next.name,
      currentClient: next.client,
      currentRole: next.role,
      ...freshSequentialDeadline(now),
      leadGraceUntil: undefined,
      queue: remaining,
      spoken,
    },
    leadSkipped,
  };
}

// Sequential lead-grace path: the queue-head supplement sent the
// __no_addition__ token while still in grace. We honor the supplement's
// opt-out (drop them from the queue, log no_addition) but do NOT preempt
// the Lead — they keep the floor until their own deadline. Opting out
// is a soft signal, not a claim on the mic.
export function skipQueueHead(
  state: TurnState,
  status: TurnSpokenStatus = 'no_addition',
  now: number = Date.now(),
): TurnState {
  const head = state.queue[0];
  if (!head) return state;
  const entry: TurnSpokenEntry = {
    name: head.name,
    client: head.client,
    role: head.role,
    status,
    at: now,
    round: state.round,
  };
  return {
    ...state,
    queue: state.queue.slice(1),
    spoken: [...state.spoken, entry],
  };
}

// Pop a host-directed one-shot allowlist entry if present. Returns true if
// the caller should be allowed to speak as a host-directed message; false
// otherwise. Mutates `state.hostDirected` (caller is responsible for
// persisting via setTurnState/casTurnState).
export function consumeHostDirected(
  state: TurnState,
  name: string,
  client: ClientKind,
): boolean {
  if (!state.hostDirected || state.hostDirected.length === 0) return false;
  const idx = state.hostDirected.findIndex(e => e.name === name && e.client === client);
  if (idx < 0) return false;
  state.hostDirected.splice(idx, 1);
  return true;
}

// Add (or refresh) a host-directed one-shot entry. Used by the
// room_direct_invoke MCP tool. No-op if already present — re-invoking
// the same target before they reply doesn't stack. `source` records
// whether this was a host override or a moderator dispatch; consumers
// surface roleAtSend differently for the two ('host_directed' vs
// 'assignee'). Defaults to 'host' for back-compat.
export function addHostDirected(
  state: TurnState,
  name: string,
  client: ClientKind,
  source: 'host' | 'moderator' = 'host',
  now: number = Date.now(),
): TurnState {
  const existing = state.hostDirected ?? [];
  if (existing.some(e => e.name === name && e.client === client)) {
    return state;
  }
  return {
    ...state,
    hostDirected: [...existing, { name, client, addedAt: now, source }],
  };
}

// Pop the matching allowlist entry AND return its source so the caller
// can pick the right roleAtSend ('host_directed' for source='host',
// 'assignee' for source='moderator'). Mutates state.hostDirected.
export function consumeHostDirectedDetailed(
  state: TurnState,
  name: string,
  client: ClientKind,
): { consumed: boolean; source?: 'host' | 'moderator' } {
  if (!state.hostDirected || state.hostDirected.length === 0) {
    return { consumed: false };
  }
  const idx = state.hostDirected.findIndex(e => e.name === name && e.client === client);
  if (idx < 0) return { consumed: false };
  const entry = state.hostDirected[idx]!;
  state.hostDirected.splice(idx, 1);
  return { consumed: true, source: entry.source ?? 'host' };
}

// Identify whether an incoming message from (name, client) is "human" for
// turn purposes. Humans (web client OR the room's host name) are never
// turn-gated and can interject any time.
export function isHumanSender(room: Room, name: string, client: ClientKind): boolean {
  if (client === 'web') return true;
  // The host always speaks freely even if they're impersonating a cc agent
  // identity (rare but legal).
  if (name === room.createdBy) return true;
  return false;
}

// Should an incoming human message trigger a new turn? Yes when the room
// is in a turn-taking mode AND no in-flight turn currently has agents
// waiting to speak. Used by appendMessage to decide whether to start a
// fresh sequential queue.
export function shouldStartNewTurn(state: TurnState | null, room: Room): boolean {
  if (room.replyMode === 'open' || room.replyMode === undefined) return false;
  if (!state) return true;
  // If the prior turn is complete (current cleared, queue empty), a fresh
  // human message starts a new turn.
  return !state.currentName && state.queue.length === 0;
}

// Helper to look up a participant by (name, client) tuple — used by callers
// that need joinedAt or canSpeak after they've received a name/client pair
// from a message.
export function findParticipant(
  room: Room,
  name: string,
  client: ClientKind,
): Participant | undefined {
  return room.participants.find(p => p.name === name && p.client === client);
}

// Reasons sweepTimeouts may fall back the room's replyMode to 'open'.
export type FallbackReason =
  | 'moderator_timeout'   // moderator went silent past their deadline
  | 'moderator_left'      // moderator is no longer in participants
  | 'lead_left';          // sequential mode: configured Lead has left

export interface SweepResult {
  state: TurnState | null;
  skipped: TurnSpokenEntry[];
  // If the room's replyMode flipped to 'open' as a side effect of this
  // sweep (e.g. moderator timed out AND no deputy was available), this
  // carries the reason + the role that triggered it. The caller emits one
  // sys event per fallback.
  fallback?: { reason: FallbackReason; agentName: string; agentClient: ClientKind };
  // If a dead-ended moderator was instead handed off to a deputy moderator
  // (the room stays in 'moderator' mode), this carries who lost the floor
  // and who took it. The caller emits a sys event and — when the deputy is a
  // hosted agent — wakes them so they actually run.
  handoff?: { reason: FallbackReason; fromName: string; fromClient: ClientKind; toName: string; toClient: ClientKind };
}

// Pick a deputy to take the moderator floor when the configured moderator
// dead-ends (times out or leaves). The deputy is the earliest-joined OTHER cc
// agent that can still speak — humans never moderate, and the outgoing
// moderator is excluded. Returns undefined when nobody else can take over, in
// which case the caller falls the room back to 'open' as before.
export function pickDeputyModerator(
  room: Room,
  exclude: { name: string; client: ClientKind },
): Participant | undefined {
  return room.participants
    .filter(p =>
      p.client === 'cc'
      && p.canSpeak !== false
      && !(p.name === exclude.name && p.client === exclude.client),
    )
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];
}

// Idempotency claim for a dead-end transition (moderator timed out / left, or
// sequential Lead left). Concurrent sweeps that observe the SAME dead-end must
// only emit ONE skip + handoff/fallback notice; without this, two coalesced
// listen polls each post the notice, which surfaced in prod as duplicate
// "skipping … slot" + "handing the floor"/"falling back to open" spam. The
// `identity` is derived purely from `prev` (the absent role + the deadline that
// lapsed), so every racer computes the same key and exactly one SET NX wins.
// TTL is short — it only needs to outlive the window in which coalesced polls
// fire (seconds); a fresh dead-end later (new deadline) yields a new key.
// Returns true iff THIS caller won and should emit.
async function claimDeadEndNotice(
  client: UpstashClient,
  code: string,
  identity: string,
): Promise<boolean> {
  const key = `sweepDeadEnd:${code}:${identity}`;
  const won = await client.command<string | null>(['SET', key, '1', 'NX', 'EX', '30']);
  return won === 'OK';
}

// Lazy timeout sweep, called from the long-poll loop in apps/mcp/src/tools.ts
// (and any future external watchers). Reads turnState, applies the timeout
// cascade, writes the new state if anything changed, and returns the list
// of speakers that got auto-skipped. Callers are expected to follow up
// with appendSystemMessage() per skip — keeping the message-emission out
// of this module avoids a cyclic dep on messages.ts.
//
// Additionally handles three dead-end conditions by falling the room's
// replyMode back to 'open':
//   - Moderator timed out (currentRole='moderator' and deadline expired)
//   - Moderator no longer in participants (left or got kicked)
//   - Sequential Lead no longer in participants while a turn is in flight
// In each case the room CAS flips replyMode='open' and the turnState is
// cleared; the caller emits one sys event per fallback so participants
// see what happened.
//
// Concurrency: a CAS-then-write race is possible (two listen polls both
// see the same expired deadline and both write). Idempotency comes from
// `spoken.at` being monotonically advanced: a second writer who lost the
// race will append duplicates only if both fired at the exact same ms,
// which is rare and self-healing on the next read.
export async function sweepTimeouts(
  client: UpstashClient,
  code: string,
  room: Room,
  now: number = Date.now(),
): Promise<SweepResult> {
  const prev = await getTurnState(client, code);
  if (!prev) return { state: null, skipped: [] };

  // Step 1: cascade any expired deadlines.
  const timeout = advanceOnTimeout(prev, room, now);
  let state = timeout.state;
  const skipped = timeout.skipped;

  // Step 2: dead-end checks. A dead-ended moderator is handed off to a deputy
  // when one exists; only when nobody can take over do we fall back to 'open'.
  let fallback: SweepResult['fallback'];

  if (room.replyMode === 'moderator' && prev.moderatorName && prev.moderatorClient) {
    // Moderator absent from participants, or its deadline expired this sweep.
    const modPresent = room.participants.some(p =>
      p.name === prev.moderatorName && p.client === prev.moderatorClient && p.canSpeak !== false,
    );
    let deadEnd: FallbackReason | undefined;
    if (!modPresent) {
      deadEnd = 'moderator_left';
    } else if (skipped.some(s => s.role === 'moderator')) {
      // Moderator's deadline expired in this sweep — UNLESS the moderator just
      // posted an assignment in the last 30s. After assigning sub-agents the
      // moderator legitimately goes quiet while they work; a sweep that fires in
      // that window must NOT disturb the floor, or the sub-agents' delayed
      // respond calls arrive to a room whose moderator turn was reset and the
      // assignments are silently ignored (the "assigned, nobody executed" bug).
      // Treat a just-spoken moderator as still holding the floor.
      const modJustSpoke = prev.spoken.some(s =>
        s.name === prev.moderatorName
        && s.client === prev.moderatorClient
        && s.status === 'replied'
        && now - s.at < 30_000,
      );
      if (!modJustSpoke) deadEnd = 'moderator_timeout';
    }

    if (deadEnd) {
      // Concurrency dedupe. Two listen polls can read the SAME expired
      // moderator deadline and both run this dead-end transition. The state
      // writes below are idempotent, but the caller emits a sys message per
      // returned skip/handoff/fallback — so a double sweep posts the skip
      // notice and the handoff/fallback notice TWICE (observed in prod as
      // duplicate "skipping moderator slot" + "handing the floor" spam). Gate
      // the emission on a SET NX lock keyed on the expired moderator + the
      // exact deadline that lapsed — both racers compute the identical key
      // from the same `prev`, so only the winner returns the messages; the
      // loser suppresses them (state already converges via the winner's
      // write). Best-effort: if the lock client errors, fall through and emit
      // (a rare duplicate beats a silently-dropped handoff notice).
      const claimed = await claimDeadEndNotice(
        client, code,
        `mod:${prev.moderatorName}:${prev.moderatorClient}:${prev.deadline ?? 'none'}`,
      ).catch(() => true);
      if (!claimed) return { state, skipped: [] };
      // Prefer handing the floor to a deputy over collapsing the room. A
      // collapsed moderator room loses its coordinator and devolves into the
      // open-mode free-for-all this whole machine exists to prevent.
      const deputy = pickDeputyModerator(room, { name: prev.moderatorName, client: prev.moderatorClient });
      if (deputy) {
        // Promote the deputy: keep moderator mode, repoint the configured
        // moderator, and start them on a fresh moderator turn so they hold the
        // floor (and get woken by the caller when hosted). Best-effort room
        // CAS; we compute the promoted room locally so newModeratorTurn picks
        // the deputy even if the CAS lost a race.
        const promotedRoom: Room = {
          ...room,
          replyMode: 'moderator',
          modeConfig: { ...room.modeConfig, moderatorAgentName: deputy.name, moderatorAgentClient: deputy.client },
        };
        try {
          await casRoom(client, code, (current) => ({
            ...current,
            replyMode: 'moderator',
            modeConfig: { ...current.modeConfig, moderatorAgentName: deputy.name, moderatorAgentClient: deputy.client },
          }));
        } catch { /* best-effort — local promotedRoom still drives the turn */ }
        const newTurn = newModeratorTurn(promotedRoom, now, now);
        if (newTurn) {
          try { await setTurnState(client, code, newTurn); } catch { /* best-effort */ }
          return {
            state: newTurn,
            skipped,
            handoff: {
              reason: deadEnd,
              fromName: prev.moderatorName,
              fromClient: prev.moderatorClient,
              toName: deputy.name,
              toClient: deputy.client,
            },
          };
        }
      }
      // No deputy (or couldn't start their turn) → fall back to 'open'.
      fallback = {
        reason: deadEnd,
        agentName: prev.moderatorName,
        agentClient: prev.moderatorClient,
      };
    }
  } else if (room.replyMode === 'sequential' && prev.leadName && prev.leadClient) {
    // Lead absent from participants → fallback (and only while a turn
    // is in flight — if the turn already drained, no fallback needed).
    const leadPresent = room.participants.some(p =>
      p.name === prev.leadName && p.client === prev.leadClient && p.canSpeak !== false,
    );
    if (!leadPresent && (state?.currentName || (state?.queue.length ?? 0) > 0)) {
      // Same concurrency dedupe as the moderator dead-end: only one racer emits
      // the lead-left fallback notice. Loser suppresses (state converges via the
      // winner's room CAS + turn clear below).
      const claimed = await claimDeadEndNotice(
        client, code,
        `lead:${prev.leadName}:${prev.leadClient}:${prev.deadline ?? 'none'}`,
      ).catch(() => true);
      if (!claimed) return { state, skipped: [] };
      fallback = {
        reason: 'lead_left',
        agentName: prev.leadName,
        agentClient: prev.leadClient,
      };
    }
  }

  if (fallback) {
    // Flip replyMode to 'open' and clear turnState. Best-effort: if the
    // room CAS fails (concurrent setReplyMode), we still clear local
    // state and surface the event — the room write will eventually
    // converge on the next setReplyMode call. We catch errors so a
    // sweep failure never breaks the listen loop.
    try {
      await casRoom(client, code, (current) => ({
        ...current,
        replyMode: 'open',
        // Keep modeConfig so the host can flip back later without
        // re-entering Lead/Moderator details.
      }));
    } catch { /* best-effort */ }
    try { await clearTurnState(client, code); } catch { /* best-effort */ }
    return { state: null, skipped, fallback };
  }

  // Persist whatever the timeout cascade produced.
  if (skipped.length > 0) {
    if (state) {
      await setTurnState(client, code, state);
    } else {
      await clearTurnState(client, code);
    }
  }
  return { state, skipped };
}

// Host-driven force-skip of the current speaker. Used by the
// room_skip_current MCP tool. Advances the turn as if the current
// speaker had timed out, but the spoken entry carries status='skipped'
// and the sys event metadata identifies the host as the trigger.
// Returns the skipped speaker (if any) so the caller can post the sys
// event. If no turn is in flight, returns null and the caller should
// surface a "nothing to skip" hint.
export async function hostSkipCurrent(
  client: UpstashClient,
  code: string,
  room: Room,
  now: number = Date.now(),
): Promise<TurnSpokenEntry | null> {
  let skipped: TurnSpokenEntry | null = null;
  await casTurnState(client, code, (prev) => {
    if (!prev || !prev.currentName || !prev.currentClient || !prev.currentRole) {
      return prev;
    }
    skipped = {
      name: prev.currentName,
      client: prev.currentClient,
      role: prev.currentRole,
      status: 'skipped',
      at: now,
    };
    return advanceTurn(prev, 'skipped', room, now);
  });
  return skipped;
}

// Host-only one-shot direct invoke. Adds (target, source) to the
// hostDirected allowlist on the active turnState. If no turn is in
// flight, no-ops (returns false). Slice C wires the room_direct_invoke
// MCP tool to this. Source determines roleAtSend on consume:
// 'host' → 'host_directed', 'moderator' → 'assignee'.
export async function directInvoke(
  client: UpstashClient,
  code: string,
  target: { name: string; client: ClientKind },
  source: 'host' | 'moderator',
  now: number = Date.now(),
): Promise<boolean> {
  let added = false;
  await casTurnState(client, code, (prev) => {
    if (!prev) return prev;
    const existing = prev.hostDirected ?? [];
    if (existing.some(e => e.name === target.name && e.client === target.client)) {
      return prev;
    }
    added = true;
    return {
      ...prev,
      hostDirected: [...existing, { name: target.name, client: target.client, addedAt: now, source }],
    };
  });
  return added;
}

// Resolve the role this participant currently plays in the active turn, if
// any. Used by the MCP `room_join` and `room_listen` handlers to populate
// `myRoleInTurn`, so an agent knows whether it's the lead, an upcoming
// supplement, already-spoken, or just an observer.
export type MyRoleInTurn =
  | 'lead'
  | 'supplement'
  | 'wrap'          // sequential mode — holding the closing wrap-up turn
  | 'moderator'
  | 'assignee'
  | 'queued'        // in the queue, but not yet current
  | 'spoken'        // already replied or skipped this turn
  | 'host_directed' // present in the one-shot allowlist
  | 'observer';     // not part of the turn at all (or no turn active)

export function myRoleInTurn(
  state: TurnState | null,
  name: string,
  client: ClientKind,
  now: number = Date.now(),
): MyRoleInTurn {
  if (!state) return 'observer';
  if (state.hostDirected?.some(e => e.name === name && e.client === client)) {
    return 'host_directed';
  }
  if (state.currentName === name && state.currentClient === client) {
    return (state.currentRole ?? 'observer') as MyRoleInTurn;
  }
  // Grace-eligible queue-head supplement: surface as 'supplement' so the
  // agent knows they can speak now (not just 'queued').
  if (isGraceEligibleQueueHead(state, name, client, now)) {
    return 'supplement';
  }
  if (state.queue.some(q => q.name === name && q.client === client)) {
    return 'queued';
  }
  if (state.spoken.some(s => s.name === name && s.client === client)) {
    return 'spoken';
  }
  return 'observer';
}

// Is this sender the room's configured Moderator? Identity comes from the
// room config (modeConfig), NOT from turn state — the Moderator is still the
// Moderator between turns, and turn state is wiped outright on every mode
// switch. Callers that need "does the Moderator hold the floor right now"
// want the turn-state helpers instead.
export function isConfiguredModerator(
  room: Room,
  name: string,
  client: ClientKind,
): boolean {
  const wantName = room.modeConfig?.moderatorAgentName;
  if (!wantName || wantName !== name) return false;
  const wantClient = room.modeConfig?.moderatorAgentClient;
  // moderatorAgentClient is required by setReplyMode, but older rooms may
  // carry only the name — fall back to name-only.
  return wantClient === undefined || wantClient === client;
}

// Is the room's configured Moderator actually IN the room and able to speak?
// When this is false the room is in moderator mode in name only: no moderator
// turn can ever open, so nothing can hold the floor and every agent reply is
// off-floor traffic.
export function isModeratorPresent(room: Room): boolean {
  const wantName = room.modeConfig?.moderatorAgentName;
  if (!wantName) return false;
  const wantClient = room.modeConfig?.moderatorAgentClient;
  return room.participants.some(p =>
    p.name === wantName
    && (wantClient === undefined || p.client === wantClient)
    && p.canSpeak !== false,
  );
}
