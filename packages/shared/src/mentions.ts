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

/**
 * The reason the filter above exists is that a room has several agents and a
 * message is only about one of them. In a room with exactly one agent that
 * reason is gone: there is nobody else the message could be for, and requiring
 * an `@` makes the room's only agent the one participant who has to be
 * addressed by name to answer a question asked directly to it.
 *
 * Observed 2026-09-08, one human and one agent, open mode. Three un-@'d
 * messages got answers; the fourth — a request the agent could not fulfil —
 * got two and a half minutes of silence and then a generic status line. The
 * difference is not the wording. All four arrived through the branch that says
 * "speak only if you can clearly add something. Saying nothing is a fine
 * answer", which is a correct rule for room chatter and the wrong one for the
 * only question in a two-participant room. The agent used it as an escape hatch
 * on the single request it could not do, instead of saying it could not do it.
 *
 * The cost asymmetry that shaped `wakesAgent` also inverts here. There it was
 * four agents burning a turn each on a message for someone else; here there is
 * one agent, so a wake it did not need costs one turn, and a miss costs the
 * meeting. Bounded on purpose: a second agent joining restores the @ filter.
 */
export function soleAgentOf(
  participants: { name: string; client: string }[],
  selfName: string,
): boolean {
  const self = selfName.trim();
  if (!self) return false;
  const agents = participants.filter(p => p.client === 'cc');
  return agents.length === 1 && agents[0]!.name === self;
}
