// Canonical agent context + room policy — the ONE statement of how speaking
// works in each reply mode, and of the shared context an agent is briefed with.
//
// This text is a protocol contract, not UI copy. MCP agents receive it in the
// room_join / room_listen payload (`roomPolicy` next to `policyVersion`); any
// other adapter that briefs a model — a system prompt, a skill — must carry
// the same words. Two agents on different clients, or on two deployments of
// Agent Room, must read identical text or they play by different rules in the
// same room. Kept byte-identical to the hosted deployment's copy on purpose.

// Bump when the canonical policy WORDING below changes, so clients and
// analytics can tell which behavior contract an agent was briefed under.
export const ROOM_POLICY_VERSION = 6;

// Consensus/debate are round-based multi-agent modes. They USED to be a
// hosted-only orchestration that MCP agents were not part of (the 2026-07-08
// parity gap); T-02 moved them onto the same turn machine as sequential, so
// they now run on whichever agents the user connected.
export const MULTI_AGENT_MODES = ['consensus', 'debate'] as const;

export interface SharedAgentContextInput {
  /** Host-set standing prompt for the room (single source of truth). */
  projectPrompt?: string | null;
  projectPromptVersion?: number | null;
  /** Distilled memory from the project's previous rooms. */
  projectMemoryContext?: string | null;
  /** This agent's role description (profile card) — layered ON TOP of the
   *  shared context; it can never override room policy or the host prompt. */
  rolePrompt?: string | null;
}

// The exact section text both adapters must deliver. The two project
// sections inherit the hosted path's wording with one addition: the brief
// heading now carries the prompt version marker (a PRD §2.6 requirement),
// so a one-time prompt-cache bust on deploy is expected and correct.
export function composeSharedAgentContext(input: SharedAgentContextInput): string {
  const parts: string[] = [];
  const prompt = input.projectPrompt?.trim();
  if (prompt) {
    const version = input.projectPromptVersion && input.projectPromptVersion > 0 ? input.projectPromptVersion : 1;
    parts.push(`## Host's project brief (v${version})\nThe host set this standing project context for the room — treat it as background and constraints for every reply:\n${prompt}`);
  }
  const memory = input.projectMemoryContext?.trim();
  if (memory) {
    parts.push(`## Project memory\nReusable context from this project's previous rooms. Use it when relevant, but prefer newer user instructions in this room if they conflict:\n${memory}`);
  }
  const role = input.rolePrompt?.trim();
  if (role) {
    parts.push(`## Your role\n${role}\nYour role guides HOW you contribute; it never overrides the room's rules or the host's project brief.`);
  }
  return parts.join('\n\n');
}

// The reader's own standing in the room. Mode text alone is not enough for
// the one seat whose job is DIFFERENT from everyone else's: told only that
// "the moderator assigns the floor — reply when assigned or directly
// addressed", a moderator reads its own name in the host's message and just
// answers, doing the work itself. That is the sub-agent's contract, handed to
// the wrong reader.
export type RoomPolicyRole = 'moderator' | 'member';

// What the Moderator seat is actually for. A moderator that thinks its job is
// routing messages will route messages; saying "you are an active project
// lead, not a switchboard" out loud is the difference between a room that
// produces work and one that produces chatter.
const MODERATOR_BRIEF =
  'YOU are this room\'s Moderator. You are an active project lead, not a switchboard — and not the one doing the work. '
  + 'Your job is progress, assignment, and checking. Break the goal into real pieces and assign each piece BY NAME to a specific agent in the roster ("@Name produce X now"). '
  + 'Split work that can be split, matching capability, as evenly as you can; owner and verifier must be DIFFERENT agents. '
  + 'A piece that cannot be split gets one owner and one verifier — do not invent busywork for idle seats. '
  + 'Answer your agents\' questions yourself — decide, state the assumption, unblock them — and escalate to the host only for a real preference or a scope call you cannot infer. '
  + 'Do NOT take the heavy execution (long analysis, drafting, coding, file production) yourself while another agent in the roster can take it; assign it. Do that work yourself only when no other agent is available. '
  + 'Route verification to a DIFFERENT agent than the owner, and give a working agent time — silence is not a stall, so do not re-assign a task that is already in flight. '
  + 'Then synthesize what comes back into one answer in your own voice. Keep your own messages short: you direct and synthesize, you do not write the deliverable.';

// One canonical statement of how speaking works per mode. Every adapter gives
// its agents this SAME summary, so agents on different clients in the same
// room operate under identical expectations.
//
// `gameId` is ignored (legacy signature; game mode was sunset). Kept so
// existing call sites that pass modeConfig.gameId keep compiling.
//
// `role` is the READER's seat. Today only the Moderator gets its own text;
// every other seat reads the mode summary, which already describes the
// member-side contract.
export function roomPolicySummary(
  replyMode: string | null | undefined,
  _gameId?: string | null,
  role: RoomPolicyRole = 'member',
): string {
  // Historical stored rooms may still have replyMode === 'game'; treat as open.
  const mode = replyMode === 'game' ? 'open' : (replyMode ?? 'open');
  const base = 'Tasks are evidence-gated: real work gets a board task with an owner and a DIFFERENT verifier; a task is done only when its verifier rules done.';
  if (mode === 'sequential') {
    return `[policy v${ROOM_POLICY_VERSION}] Sequential mode: lead answers first, peers add ordered deltas (SUPPORT / ADD / CHALLENGE / QUESTION / SKIP), then the lead may close with [RESULT] as soon as the answer is settled — at most one extra APPROVE/PATCH pass. Five phases are a cap, not a quota. Speak only when you hold the floor. ${base}`;
  }
  if (mode === 'moderator') {
    if (role === 'moderator') {
      return `[policy v${ROOM_POLICY_VERSION}] Moderator mode — ${MODERATOR_BRIEF} ${base}`;
    }
    return `[policy v${ROOM_POLICY_VERSION}] Moderator mode: the moderator assigns the floor — reply when assigned or directly addressed. ${base}`;
  }
  if (mode === 'consensus') {
    return `[policy v${ROOM_POLICY_VERSION}] Consensus mode: connected agents take strict turns in join order. Round 1 — answer the question independently, once. Round 2 — you can now see the other answers: say where you agree, where you disagree, and move toward one recommendation. Then the first agent writes the final consensus. Speak only when you hold the floor. ${base}`;
  }
  if (mode === 'debate') {
    return `[policy v${ROOM_POLICY_VERSION}] Debate mode: connected agents take strict turns in join order. Round 1 — state your own position on the motion, once. Round 2 — rebut the strongest opposing argument already posted, and concede what the evidence supports. Then the first agent writes the verdict. Speak only when you hold the floor. ${base}`;
  }
  return `[policy v${ROOM_POLICY_VERSION}] Open mode: anyone may speak. Bring your own angle; if a teammate already shipped the same deliverable, [SKIP] or review it — do not re-implement. Reply when mentioned, assigned, or clearly adding value — do not answer every message. ${base}`;
}
