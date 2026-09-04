/**
 * Reconnect suffixes, and how to count agents in spite of them.
 *
 * When an agent rejoins a room whose seat is still held by a live participant
 * of the same name, joinRoom mints "Copilot (2)", "Copilot (3)", … so two
 * intentional agents can coexist (see uniqueNameForRoom in upstash-client).
 * That is right for the live roster — those really are distinct seats — but it
 * lies to anything that counts *agents* over a room's history: one MCP client
 * flapping through a reconnect storm leaves a trail of names behind it. The
 * admin Rooms tab read one real room as "19 agents" when eleven ever spoke and
 * six were seated, because "Indiana Jones" alone had minted seven names.
 *
 * So: history counts fold the suffix away, live views may show seats.
 */

/** " (2)" at the end of a display name — the shape uniqueNameForRoom mints. */
const RECONNECT_SUFFIX_RE = / \((\d+)\)$/;

/**
 * The same suffix as a Postgres regex literal, for `regexp_replace` in SQL.
 * Kept beside the JS regex (and pinned to it by participantNames.test.ts) so
 * the analytics queries and the runtime can't drift apart.
 */
export const RECONNECT_SUFFIX_SQL = ' \\(\\d+\\)$';

/** "Copilot (2)" → "Copilot"; plain names return themselves. */
export function baseParticipantName(name: string): string {
  const trimmed = name.trim();
  return trimmed.replace(RECONNECT_SUFFIX_RE, '').trim() || trimmed;
}

/** Fold key: base name, case-insensitive — matches how joins compare names. */
export function participantNameKey(name: string): string {
  return baseParticipantName(name).toLowerCase();
}

/**
 * How many distinct participants these names represent, ignoring reconnect
 * suffixes and case. Blank names are skipped.
 */
export function countDistinctParticipants(names: Iterable<string>): number {
  const seen = new Set<string>();
  for (const name of names) {
    const key = participantNameKey(name ?? '');
    if (key) seen.add(key);
  }
  return seen.size;
}

type RosterMember = { client?: string | null; name: string };

/**
 * Roster counts for analytics metadata, in one place so every emitter agrees.
 *
 * `agentCount` is the number the admin UI calls "agents" — distinct, suffixes
 * folded — while `agentSeatCount` keeps the literal roster length for anything
 * that cares about seats (a stale "Copilot (2)" still occupies one).
 */
export function rosterCounts(participants: readonly RosterMember[]): {
  participantCount: number;
  humanCount: number;
  agentCount: number;
  agentSeatCount: number;
} {
  const agents = participants.filter(p => p.client === 'cc');
  return {
    participantCount: participants.length,
    humanCount: countDistinctParticipants(
      participants.filter(p => p.client === 'web').map(p => p.name),
    ),
    agentCount: countDistinctParticipants(agents.map(p => p.name)),
    agentSeatCount: agents.length,
  };
}
