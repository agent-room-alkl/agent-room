// Who did this message address by name?
//
// Used to route a message to specific agents instead of the whole room:
// "@Claude 看下这个" should get one answer, not four. The same matching drives
// moderator assignments and host @-mentions, so it lives here rather than being
// re-implemented (slightly differently) at each call site.

/**
 * Agent names mentioned as `@Name` in `text`, in roster order.
 *
 * Matching is exact-first, then case-insensitive: people type "@claude" for an
 * agent named "Claude", and an unmatched mention used to mean the assignment
 * silently went nowhere. Callers decide what an empty result means — for host
 * messages it means "not addressed to anyone in particular", so they fall back
 * to waking the whole room rather than leaving it silent.
 */
export function mentionedAgents(text: string, agentNames: readonly string[]): string[] {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  return agentNames.filter(name =>
    text.includes(`@${name}`) || lowerText.includes(`@${name.toLowerCase()}`),
  );
}

/**
 * Does this text actually address somebody with `@Name` syntax?
 *
 * Callers use this to decide whether an empty mentionedAgents() result means
 * "nobody was addressed" (stay quiet) or "a mention was written but matched
 * nobody" (warn the author about the typo). A bare `/@\S/` test cannot tell
 * those apart — any `@` anywhere passes it, so quoting an email address
 * (`todd@toddshaner.com`) mid-answer fired a bogus "mentioned an agent that
 * isn't in this room" warning into the room.
 *
 * So: the `@` must START a token (line start, whitespace, or an opening
 * bracket/quote) and be followed by a letter or digit. That is how a mention
 * is written, and it is never how the `@` in an email address appears.
 */
export function hasMentionSyntax(text: string): boolean {
  if (!text) return false;
  return /(^|[\s(（[【{<"'“‘*_>])@[\p{L}\p{N}]/u.test(text);
}

/** Just enough of a message to decide who it is aimed at. */
export interface AddressableMessage {
  text?: string;
  metadata?: { targetAgentName?: string };
}

/** "Claude (2)" also answers to "Claude" — reconnects mint suffixed seats. */
function nameVariants(name: string): string[] {
  const base = name.replace(/\s*\(\d+\)\s*$/, '').trim();
  return base && base !== name ? [name, base] : [name];
}

/**
 * Should this message pull `selfName` out of a quiet room_listen?
 *
 * Presence is billed per turn: every early return from room_listen costs the
 * listening agent one LLM turn, and a turn re-sends that agent's whole
 * conversation to the model. With no filter, one message woke every agent in
 * the room — in a five-agent room, four of them read it, found nothing for
 * them, and went back to waiting. Four turns bought nothing.
 *
 * A message wakes an agent when the room records it as being *about* them
 * (`metadata.targetAgentName` — turn assignments, host_directed, moderator
 * routing, timeout events), or when it addresses them by name. Everything
 * else still reaches them: it rides along in the digest returned at the end
 * of the hold instead of interrupting mid-wait.
 *
 * Suffixed seats match a bare mention too. Waking one agent too many costs a
 * turn; missing the message that was meant for you costs the meeting.
 */
export function wakesAgent(message: AddressableMessage, selfName: string): boolean {
  if (!selfName.trim()) return false;
  const variants = nameVariants(selfName.trim());
  const target = message.metadata?.targetAgentName?.trim();
  if (target && variants.some(v => v.toLowerCase() === target.toLowerCase())) return true;
  return mentionedAgents(message.text ?? '', variants).length > 0;
}
