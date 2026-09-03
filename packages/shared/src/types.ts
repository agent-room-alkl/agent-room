export type ClientKind = 'web' | 'cc';

export type MemberAuthScheme = 'oauth2' | 'openIdConnect' | 'mTLS';

export interface AuthenticatedMemberIdentity {
  cardFingerprint: string;
  fleetId: string;
  cardName: string;
  scheme: MemberAuthScheme;
  keyId: string;
  verifiedAt: number;
}

export interface Participant {
  name: string;
  role: string;          // empty string if not provided
  color: string;         // hex
  initials: string;      // 2 uppercase letters
  client: ClientKind;
  joinedAt: number;      // epoch ms
  lastSeenAt: number;    // epoch ms
  listenUntil?: number;  // epoch ms — set by room_listen, expires naturally
  // Host approval gate. Undefined for participants joined before this field
  // existed (treated as legacy-approved). New joiners default to false until
  // the host (createdBy) approves them via approveParticipant.
  canSpeak?: boolean;
  // Present only after a signed fleet Agent Card has been verified. This is
  // part of the room document so every RoomPersistence adapter retains it.
  authenticatedIdentity?: AuthenticatedMemberIdentity;
}

// How agent responses are coordinated in this room.
//   - 'open' (default, legacy): anyone can speak any time. Current behavior.
//   - 'sequential': a designated Lead answers first, the rest of the agents
//     supplement in join order. Only one agent is allowed to speak per turn;
//     human participants (web) and the host are always allowed.
//   - 'moderator': a designated Moderator agent receives the host's message,
//     then assigns work to specific agents. Non-assigned agents stay silent.
// Field is optional on Room so legacy stored rooms (written before reply-mode
// existed) parse fine; readers should treat undefined as 'open'.
export type ReplyMode = 'open' | 'sequential' | 'moderator' | 'consensus' | 'debate';

// Per-message marker for which role this message played in the turn machine.
// Used both for UI tagging and for prompt construction (e.g. a supplement
// agent's prompt needs to see prior lead/supplement messages from this turn).
export type RoleInTurn =
  | 'open'           // sent under reply-mode 'open' (no turn)
  | 'lead'           // sequential mode — the lead answer
  | 'supplement'     // sequential mode — a follow-up supplement
  | 'wrap'           // sequential mode — the Lead's closing wrap-up turn,
                     // issued once after the supplement queue drains so the
                     // turn ends with a conclusion / hand-off, not silence
  | 'moderator'      // moderator mode — moderator dispatching/summarizing
  | 'assignee'       // moderator mode — an agent answering a moderator assignment
  | 'status'         // moderator mode — a controlled agent's spontaneous
                     // status update (received / on it / done); always
                     // allowed, does not consume the Moderator's floor
  | 'host_directed'  // host used direct-invoke to call this agent (any mode)
  | 'human';         // sent by a web client / human participant

// Why this message was produced. UI / prompts can distinguish a normal turn
// message from a host's one-shot direct call from a moderator assignment.
export type InvocationType =
  | 'normal_turn'
  | 'host_directed'
  | 'moderator_assigned'
  | 'status_update';  // moderator mode — a controlled agent's status ping
                      // sent without being the current speaker / invoked

// Kind of system event encoded as a sys-typed Message. Surfaced in the chat
// so participants can see why state changed (mode switched, agent timed out,
// host manually skipped someone, etc).
export type SystemEventType =
  | 'mode_changed'
  | 'lead_changed'
  | 'moderator_changed'
  | 'timed_out'
  | 'skipped_by_host'
  | 'skipped_by_grace'
  | 'lead_left'
  | 'moderator_left'
  | 'moderator_fallback'
  | 'moderator_absent'
  | 'host_invoked'
  | 'moderator_dispatched'
  | 'moderator_mention_unmatched'
  | 'agent_provider_skip'
  | 'budget_downgrade'
  | 'free_cap_reached'
  | 'e2b_budget_reached'
  | 'login_nudge'
  | 'moderator_handoff'  // moderator timed out / left — floor handed to a deputy
  | 'task_update'        // evidence-gated task board changed state
  | 'project_prompt_updated'; // host set/cleared the room's project prompt

// Default per-role timeout values (in ms). Used when a room hasn't been
// configured with custom overrides. Agent turns can involve real code edits,
// tests, screenshots, or security triage, so the default must allow actual
// work rather than only short chat replies.
export const DEFAULT_TURN_TIMEOUTS_MS = {
  lead: 600_000,
  supplement: 600_000,
  wrap: 600_000,
  moderator: 600_000,
  assignee: 600_000,
} as const;

// Sequential mode: how long after a turn starts the Lead has the floor
// exclusively. Once this elapses the queue-head supplement may also speak;
// whichever lands first wins the turn and the loser is logged as
// status='skipped_by_grace'. Stops sequential head-of-line blocking when
// the Lead is slow or offline.
export const DEFAULT_LEAD_GRACE_MS = 20_000;

// Sequential-mode tiered turn deadlines. When an agent becomes the current
// speaker it gets a FIRST_RESPONSE window to produce *something* — a reply,
// or a room_status heartbeat ping. A speaker that stays completely silent
// past this window is skipped fast so the room never stalls on a dead agent.
// Each room_status ping then renews the deadline by TURN_RENEWAL, but never
// past TURN_HARD_CAP measured from when the agent took the floor — so a single
// agent can't hold a turn indefinitely. Replaces the flat 600s sequential
// deadline; moderator mode is unchanged.
//
// 150s (was 60s): hosted agents don't send heartbeats — they run one LLM call
// (often with tool use / code execution) and post once at the end — so the
// FIRST_RESPONSE window IS their whole effective deadline. 60s skipped them
// mid-thought constantly. A genuinely dead agent still gets reclaimed within
// 2.5 min, and a slow agent's reply still lands later (its invocation isn't
// killed by the skip — the queue just advances so the room doesn't stall).
export const FIRST_RESPONSE_GRACE_MS = 150_000;
export const TURN_RENEWAL_MS = 300_000;
export const TURN_HARD_CAP_MS = 600_000;

// Per-room reply-mode configuration. All fields optional so a room can be
// created without naming a Lead/Moderator until the host actually picks a
// non-open mode. setReplyMode validates that the right fields are present
// for the requested mode.
export interface ReplyModeConfig {
  // Sequential mode: the agent who answers first. Identity is (name, client)
  // because the same display name can appear from different clients (rare
  // but legal). When unset in sequential mode, the first cc-client agent
  // that joined is used as Lead by fallback.
  leadAgentName?: string;
  leadAgentClient?: ClientKind;

  // Moderator mode: the agent that dispatches work. Required when setting
  // mode to 'moderator'.
  moderatorAgentName?: string;
  moderatorAgentClient?: ClientKind;

  // Optional per-role timeout overrides (ms). Missing roles fall back to
  // DEFAULT_TURN_TIMEOUTS_MS. Stored at room level (not turn state) so
  // settings survive server restarts.
  timeoutMs?: Partial<typeof DEFAULT_TURN_TIMEOUTS_MS>;

  // Sequential mode: lead-grace window in ms. After this elapses the
  // queue-head supplement may speak even though the Lead is still current
  // — see canAgentSpeakNow / applyGraceSupplementReply. Defaults to
  // DEFAULT_LEAD_GRACE_MS. Must satisfy 0 <= leadGraceMs <= lead deadline
  // (a grace window longer than the Lead's own deadline is nonsensical).
  leadGraceMs?: number;
}

export interface Room {
  code: string;
  topic: string;
  createdAt: number;
  createdBy: string;
  ownerId?: string;
  ownerEmail?: string;
  ownerName?: string;
  // Optional durable project this room is attached to. Projects are the paid,
  // long-lived knowledge namespace; rooms remain ephemeral work sessions.
  projectId?: string;
  projectName?: string;
  // Set when this room is a visitor session of an Agent App (/a/:slug).
  // Drives per-app spend metering in respond.ts. Absent on ordinary rooms.
  appId?: string;
  status: 'active' | 'ended';
  endedAt?: number;      // epoch ms — set when meeting ends
  version: number;       // for optimistic concurrency
  participants: Participant[];
  // Omitted for legacy rooms. Authenticated joins must select one of these.
  acceptedMemberAuthSchemes?: MemberAuthScheme[];
  // Hash of the secret returned to the host on createRoom. Anyone trying to
  // join with name === createdBy must present the matching secret, otherwise
  // they get HostNameTakenError. This stops trivial impersonation by anyone
  // who only knows the room code.
  hostKeyHash?: string;
  // Reply-mode coordination. Optional + undefined-means-'open' so rooms
  // created before this field existed continue to work. AI Interview rooms
  // (topic includes "interview") ignore replyMode entirely — see
  // isInterviewTopic() in upstash-client/rooms.ts; mode changes are
  // server-rejected on interview rooms.
  replyMode?: ReplyMode;
  modeConfig?: ReplyModeConfig;
  // Host-editable "project prompt": the room-as-project's standing background
  // and constraints. Set via the host-gated setProjectPrompt action, injected
  // into agent context (join responses + hosted-agent system prompts), and
  // persisted to room_summaries so a revived room keeps it. Optional so
  // legacy stored rooms parse fine; empty is represented as undefined (a
  // clear removes the field rather than storing '').
  projectPrompt?: string;
  // Read-only project memory injected at room creation / revive time. Distinct
  // from the host-editable projectPrompt so agents can separate standing user
  // instructions from accumulated facts, decisions, deliverables, and open
  // questions.
  projectMemoryContext?: string;
  // Bumped by 1 on every successful setProjectPrompt write, including clears.
  // Undefined means "never set" (treat as 0).
  projectPromptVersion?: number;
  // Epoch ms of the last successful setProjectPrompt write (set or clear).
  projectPromptUpdatedAt?: number;
}

export type MessageKind = 'msg' | 'sys';

// Optional per-message tagging for reply-mode turns. All fields optional —
// messages stored before this field existed have no metadata, and even in a
// reply-mode-enabled room, an 'open'-mode message has metadata=undefined
// (or just `modeAtSend: 'open'`). Surfaced in the chat for UI tagging and
// for prompt construction (a Sequential supplement agent needs to see prior
// turn messages to know what was already said).
export interface MessageMetadata {
  modeAtSend?: ReplyMode;
  roleAtSend?: RoleInTurn;
  // Stable id for the current turn (epoch ms of when the turn started).
  // Lets UI / reports group lead+supplements together.
  turnId?: number;
  invocationType?: InvocationType;
  // For sys-typed messages: which event the system message is reporting.
  // Used by the UI to render skips/timeouts/mode-changes differently than
  // a free-text system message.
  eventType?: SystemEventType;
  // For host_directed / moderator_assigned / event messages: the participant
  // this message is about. e.g. "Moderator assigned this to Claude" stores
  // targetAgentName='Claude'. For timed_out events, the agent that timed out.
  targetAgentName?: string;
  targetAgentClient?: ClientKind;
  // For skipped_by_host / timed_out events: who/what triggered the skip.
  skippedBy?: 'system' | 'host';
  // Sequential mode: set on a room_status heartbeat sent by the current
  // speaker — the ping renewed their turn deadline instead of ending the
  // turn. Lets the UI / report show "still working" pings distinctly.
  extendsTurn?: boolean;
  /** Hosted agent reply: the exact model id the API call actually used for
   *  this message (after any over-budget downgrade) + its provider. Lets the
   *  UI show the real model per reply, so "displayed" always equals "used". */
  model?: string;
  provider?: string;
  /** Hosted demo: interactive scenario picker rendered below this message. */
  demoScenarioButtons?: DemoScenarioButton[];
  /** Hosted demo: hint shown above the optional user input textarea. */
  demoInputHint?: string;
  /** Hosted demo: user-triggered next step in the guided flow. */
  demoContinueAction?: 'run_builder' | 'run_reviewer' | 'run_artifact';
  /** Hosted demo: scenario id for the current guided session. */
  demoScenarioId?: string;
}

export interface DemoScenarioButton {
  id: string;
  title: string;
  description?: string;
}

export interface Message {
  id: number;            // epoch ms at creation
  type: MessageKind;
  name: string;
  initials: string;
  color: string;
  role: string;
  text: string;
  client: ClientKind;
  time: number;
  attachments?: MessageAttachment[];
  metadata?: MessageMetadata;
}

export interface MessageAttachment {
  id: string;
  type: 'file' | 'image';
  url: string;
  storageKey?: string;
  name: string;
  size: number;
  mime: string;
  uploadedAt: number;
  width?: number;
  height?: number;
  /** Server-extracted text content of the file (PDF / txt / md / csv / …),
   *  so hosted agents can actually read the document, not just its filename.
   *  Capped on upload; absent for images and unparseable files. */
  extractedText?: string;
  /** Live preview of a web app running inside the room's E2B sandbox
   *  (https://<port>-<sandbox>.e2b.app, from sandbox.getHost). When set, the
   *  room renders an embedded iframe + "open in new tab" instead of a file
   *  card. Public for the sandbox's lifetime; dies when the room ends. */
  previewUrl?: string;
}

export type ArtifactKind = 'decision' | 'todo' | 'status' | 'result';

export interface RoomArtifact {
  id: string;
  kind: ArtifactKind;
  text: string;
  sourceMessageId: number;
  author: string;
  time: number;
}

// ─── Evidence-gated task board ───────────────────────────────────────────
// A structured, server-enforced task list pinned to a room. It exists to kill
// the "phantom delivery" failure mode where an agent claims "done" without
// having produced (or verified) anything. The state machine is enforced at the
// server, not by prompts:
//   - A producer can only push a task to 'awaiting_review', and only by
//     attaching three-part evidence (file listing + file excerpt + run output
//     with an exit code). Missing any part is rejected at the tool layer.
//   - Only the task's *designated verifier* (never the producer) can move a
//     task to 'done' or 'rejected'. There is no API path for a producer to
//     mark its own task done — checkbox-theater is structurally impossible.
// State machine for a board task. Deliberately close to the A2A (Agent2Agent)
// Task lifecycle so the vocabulary is interoperable if we ever bridge external
// agents — mapping to A2A TaskState:
//   todo            ~ submitted
//   in_progress     ~ working
//   awaiting_review ~ (Agent Room-specific evidence gate; no direct A2A state)
//   done            ~ completed
//   rejected        ~ rejected  (a failed check; producer retries)
// A2A's `input-required` maps to our host/moderator answering the producer in
// chat rather than a distinct board state.
export type TaskState =
  | 'todo'             // created, nobody working it yet
  | 'in_progress'      // a producer claimed it
  | 'awaiting_review'  // producer submitted evidence; verifier must rule
  | 'done'             // verifier confirmed the evidence
  | 'rejected';        // verifier rejected; back to the producer

// The three-part proof a producer must attach to move a task to
// 'awaiting_review'. All three text fields must be non-empty.
export interface TaskEvidence {
  fileListing: string;   // e.g. `ls -la` output proving the files exist
  fileExcerpt: string;   // head/tail of the key file proving content
  runOutput: string;     // stdout of the test / smoke run proving it works
  exitCode: number;      // process exit code of the run (0 = pass)
  submittedBy: string;   // producer display name
  submittedClient: ClientKind;
  at: number;            // epoch ms
}

export interface TaskVerdict {
  verdict: 'done' | 'rejected';
  note?: string;         // verifier's reasoning / what to fix on reject
  by: string;            // verifier display name
  byClient: ClientKind;
  at: number;            // epoch ms
}

// A lightweight checklist item under a Task. Subtasks are intentionally NOT
// evidence-gated — they're the producer's own breakdown of the work, ticked
// off as they go. The parent Task still requires peer verification (verifyTask)
// to reach 'done', so subtask self-ticking can't fake a real delivery.
export interface SubTask {
  id: string;            // unique within the parent task, e.g. "S-01"
  title: string;
  done: boolean;
  doneBy?: string;       // who ticked it (display name)
  doneClient?: ClientKind;
  updatedAt: number;
}

// One audit entry for a role reassignment on a task (reassignTaskRoles in
// upstash-client/tasks.ts). Appended, never rewritten, so the board keeps a
// record of who moved a task's owner/verifier, when, and from/to whom — the
// host/moderator escape hatch for tool-blocked clients stays accountable.
export interface TaskRoleChange {
  by: string;            // who performed the reassignment (host / moderator / lead)
  byClient: ClientKind;
  at: number;            // epoch ms
  field: 'owner' | 'verifier';
  from?: string;         // previous holder's display name (undefined = was unset)
  to?: string;           // new holder's display name
}

export interface Task {
  id: string;            // short human id, e.g. "T-01"
  title: string;
  // Producer who owns delivery. Identity is (name, client) like elsewhere.
  owner?: string;
  ownerClient?: ClientKind;
  // The single agent allowed to verify this task. When unset, any non-owner
  // cc agent may verify (still never the owner).
  verifier?: string;
  verifierClient?: ClientKind;
  dod?: string;          // definition of done / acceptance criteria
  state: TaskState;
  subtasks?: SubTask[];  // optional breakdown; self-ticked, not evidence-gated
  // Light "ready for review" note used by hosted-agent (marker-driven) rooms,
  // where a non-code task has no runnable 3-part evidence. The owner states
  // what they did; a NON-owner peer still has to confirm (verifyTask) to reach
  // 'done', so peer verification is preserved. Code tasks should still use the
  // full `evidence` path. Mutually informative, not mutually exclusive.
  readinessNote?: string;
  evidence?: TaskEvidence; // latest submitted evidence (kept across rejects)
  verdict?: TaskVerdict;   // latest verifier ruling
  // Audit trail of owner/verifier reassignments (host / moderator escape
  // hatch). Optional + append-only, so boards created before this field
  // existed keep working unchanged.
  roleHistory?: TaskRoleChange[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// Moderator-mode reliability record for one agent (see TaskBoard.reliability).
export interface AgentReliability {
  blocks: number;        // # of this agent's tasks reassigned because it was blocked
  demotedAt?: number;    // epoch ms when it crossed the demote threshold (low-capability)
}

export interface TaskBoard {
  code: string;
  tasks: Task[];
  version: number;       // optimistic-concurrency counter
  // epoch ms of the last meaningful board change (create/claim/submit/verify).
  // Used by the server's board sweep to detect a stalled board (no progress on
  // open tasks for a while) and nudge owners — distinct from `version`, which
  // also bumps on no-op writes.
  lastProgressAt?: number;
  // Per-agent reliability tally (moderator mode). Keyed by agent display name.
  // `blocks` counts how many of this agent's assigned tasks the moderator had to
  // reassign because the agent was blocked; once it hits TASK_BLOCK_DEMOTE_
  // THRESHOLD the agent is marked low-capability (demotedAt set) and gets no
  // new assignments.
  reliability?: Record<string, AgentReliability>;
  // Debounce bookkeeping for the board sweep's reminder sys messages.
  lastStallNudgeAt?: number;       // last "tasks not progressing" reminder
  completionAnnouncedAt?: number;  // set once when every task reached 'done'
  // epoch ms of the last agent-driven board REVIEW (the periodic ~20s "are
  // tasks done / are we drifting?" pass). Distinct from lastProgressAt: a
  // review that finds nothing to change still stamps this so the next review
  // is debounced, but does NOT count as task progress. Drives the review
  // cadence in the same way lastProgressAt drives the stall nudge.
  lastReviewAt?: number;
  // Total room message count captured at the last review. If unchanged at the
  // next due check, the room has had NO new activity since we last reviewed —
  // so we skip the review instead of burning a full moderator/leader LLM call
  // re-checking an unchanged board every minute (idle token waste).
  lastReviewMsgCount?: number;
}

// Board-sweep tuning (ms). A board with open tasks that hasn't progressed in
// STALL_MS triggers a reminder, re-emitted at most once per STALL_NUDGE_COOLDOWN_MS
// while it stays stalled. Generous by default so the reminder is a safety net,
// not a nag.
export const TASK_BOARD_STALL_MS = 300_000;            // 5 min with no progress
export const TASK_BOARD_STALL_NUDGE_COOLDOWN_MS = 300_000; // re-nudge ≤ every 5 min

// Cadence of the active board REVIEW — the periodic "are tasks actually done /
// are we drifting off the DoD?" pass driven by the mode's reviewer agent
// (closer in open, lead in sequential, moderator in moderator mode). This is the
// single debounce for BOTH drivers: the room poll loop (while a human is
// watching) and the cron sweep (when nobody is). ~3 min: frequent enough to
// keep the board moving, infrequent enough not to burn a full reviewer LLM call
// every minute. (Idle rooms are skipped entirely — see triggerBoardReviewIfDue's
// no-new-messages check — so this only governs ACTIVE rooms.)
export const TASK_BOARD_REVIEW_INTERVAL_MS = 180_000;

// Moderator-mode "blocked agent" handling. An assigned, non-terminal task whose
// owner makes NO progress for ~3 review cycles (TASK_BLOCK_STALL_MS) and who is
// silent or just talking without delivering is considered BLOCKED on that task.
// The moderator reassigns it ([REASSIGN]); after an agent accumulates
// TASK_BLOCK_DEMOTE_THRESHOLD blocked tasks it is auto-marked low-capability and
// gets no new assignments. Decision is the moderator's; the server tracks the
// tally and enforces the demotion (the LLM can't reliably count across turns).
export const TASK_BLOCK_STALL_MS = 180_000;        // ~3 × the 1-min review cadence
export const TASK_BLOCK_DEMOTE_THRESHOLD = 2;      // blocked tasks before demotion

export interface ReportParticipant {
  name: string;
  role: string;
  client: ClientKind;
}

// Auto-generated retrospective for a room, computed from the transcript's
// system events (timeouts, skips, task_update trail) and the task board.
// Every section degrades independently: rooms without a board have no
// `tasks`, pre-metadata rooms just show message distribution.
export interface RetroTaskEntry {
  id: string;
  title: string;
  state: TaskState;
  owner?: string;
  verifier?: string;
  createdAt: number;
  claimedAt?: number;    // first "(now in_progress)" task_update sys event
  submittedAt?: number;  // latest evidence.at
  decidedAt?: number;    // latest verdict.at
  cycleMs?: number;      // createdAt → decidedAt, only when decided
  rejections: number;    // count of "(now rejected)" task_update events
  reassignments: number; // roleHistory length
}

export interface RetroParticipantEntry {
  name: string;
  client: ClientKind;
  messages: number;
  chars: number;
  sharePct: number;      // share of chat characters, 0-100 rounded
  timeouts: number;      // turn timeouts attributed to this participant
  skips: number;         // host/grace skips attributed to this participant
}

export interface RoomRetro {
  generatedAt: number;
  durationMs: number;    // room creation → last activity
  messageCount: number;  // chat messages (type 'msg')
  sysEventCount: number;
  participants: RetroParticipantEntry[];
  tasks?: RetroTaskEntry[];
  totals: {
    timeouts: number;
    skips: number;
    rejections: number;
    tasksDone: number;
    tasksOpen: number;
  };
}

export interface RoomReport {
  code: string;
  topic: string;
  createdAt: number;
  exportedAt: number;
  ownerId?: string;
  ownerEmail?: string;
  ownerName?: string;
  participants: ReportParticipant[];
  messageCount: number;
  summary: string;
  highlights: string[];
  decisions: string[];
  actionItems: string[];
  artifacts: RoomArtifact[];
  transcript: Message[];
  retro?: RoomRetro;
}
