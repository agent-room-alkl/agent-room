// Room policy — the ONE statement of how speaking works in each reply mode.
//
// This text is a protocol contract, not UI copy. It is what a joining agent is
// briefed under, and it rides on every `room_listen` result as `roomPolicy`
// next to `policyVersion`. Two agents on different clients — or on two
// different deployments of Agent Room — must read the same words, or they are
// playing by different rules in the same room.
//
// Kept byte-identical to the hosted deployment's copy on purpose. If the
// wording below changes, bump ROOM_POLICY_VERSION so clients and analytics can
// tell which contract an agent was briefed under.

// Bump when the canonical policy WORDING below changes.
export const ROOM_POLICY_VERSION = 4;

export type RoomPolicyRole = 'moderator' | 'member';

// What the Moderator seat is actually for. A moderator that thinks its job is
// routing messages will route messages; saying "you are an active project
// lead, not a switchboard" out loud is the difference between a room that
// produces work and one that produces chatter.
const MODERATOR_BRIEF =
  'YOU are this room\'s Moderator. You are an active project lead, not a switchboard — and not the one doing the work. '
  + 'Break the goal down and assign each piece BY NAME to a specific agent in the roster ("@Name produce X now"), one concrete deliverable each. '
  + 'Answer your agents\' questions yourself — decide, state the assumption, unblock them — and escalate to the host only for a real preference or a scope call you cannot infer. '
  + 'Do NOT take the heavy execution (long analysis, drafting, coding, file production) yourself unless the host explicitly tells you to; assign it. '
  + 'Route verification to a DIFFERENT agent than the owner, and give a working agent time — silence is not a stall, so do not re-assign a task that is already in flight. '
  + 'Then synthesize what comes back into one answer in your own voice. Keep your own messages short: you direct and synthesize, you do not write the deliverable.';

/**
 * One canonical statement of how speaking works per mode.
 *
 * `gameId` is ignored (legacy signature; game mode was sunset). Kept so call
 * sites that still pass `modeConfig.gameId` keep compiling.
 *
 * `role` is the READER's seat. Only the Moderator gets its own text; every
 * other seat reads the mode summary, which already describes the member-side
 * contract.
 */
export function roomPolicySummary(
  replyMode: string | null | undefined,
  _gameId?: string | null,
  role: RoomPolicyRole = 'member',
): string {
  // Historical stored rooms may still have replyMode === 'game'; treat as open.
  const mode = replyMode === 'game' ? 'open' : (replyMode ?? 'open');
  const base = 'Tasks are evidence-gated: real work gets a board task with an owner and a DIFFERENT verifier; a task is done only when its verifier rules done.';
  if (mode === 'sequential') {
    return `[policy v${ROOM_POLICY_VERSION}] Sequential mode: dual-round convergence — lead answers, peers add ordered deltas, lead drafts, peers APPROVE or PATCH once, lead closes with [RESULT]. Speak only when you hold the floor. ${base}`;
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
  return `[policy v${ROOM_POLICY_VERSION}] Open mode: anyone may speak, but reply only when mentioned, assigned, or clearly adding value — do not answer every message. ${base}`;
}
