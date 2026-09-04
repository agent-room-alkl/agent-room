// Which agent harness is on the other end of the hosted HTTPS MCP endpoint.
//
// The npx package (agent-room-mcp) has known this for a long time: it reads
// process env, classifies the harness, and caps `room_listen` so a blocking
// tool call never outlives what the client will wait for. None of that
// knowledge was on the HTTP path — every zero-install client got the same
// window and the same prompt text, including the ones documented in
// docs/integrations/PRESENCE.md as unable to hold a long request.
//
// That mattered because of how agents actually leave rooms. A `room_listen`
// that outlives the client's own tool-call timeout does not come back with
// messages; it comes back as a tool ERROR. An error is the single result most
// likely to make a model stop calling tools and write a paragraph about what
// went wrong — and a reply with no tool call after it is exactly what leaving
// a room looks like. So the fix for a weak client is not more prompt text, it
// is a hold short enough to return cleanly every time.
//
// STATELESS BY DESIGN. api/mcp.ts creates a fresh Server per POST
// (`sessionIdGenerator: undefined`), so `initialize` and `tools/call` are
// separate requests and the SDK's remembered clientInfo is usually gone by the
// time a tool runs. The User-Agent header is the one signal present on every
// POST, so it is the primary source here; clientInfo is accepted as a second
// opinion for the requests that do carry it.
//
// CONSERVATIVE IN ONE DIRECTION ONLY. Detection may only ever TIGHTEN a
// window, never widen one, and an unidentified client is left exactly as it
// was before this existed (`maxListenMs: undefined` — nothing is clamped).
// Guessing "weak" for an unknown client would silently cut Claude Code and
// Codex from a 240s hold to 45s and multiply their wake-ups — and every
// wake-up re-sends that agent's whole conversation, so a wrong guess here is
// paid for on every turn, forever.

export type HarnessKind =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'cursor'
  | 'antigravity'
  | 'gemini-cli'
  | 'cline'
  | 'windsurf'
  | 'copilot'
  | 'unknown';

export interface HttpHarness {
  kind: HarnessKind;
  /** Human-readable label to splice into hints. */
  label: string;
  /**
   * Longest single blocking tool call this client is known to survive.
   * `undefined` means "not identified" — clamp nothing, change nothing.
   */
  maxListenMs?: number;
}

/**
 * Ceiling for clients that cap MCP tool calls at around 60s — Cursor,
 * Antigravity, Cline, Windsurf, the Claude desktop app. Same number the npx
 * package uses (WEAK_MAX_LISTEN_MS), deliberately: an agent that switches
 * between the bundled stdio server and this URL should not see its listen
 * window change underneath it.
 */
export const WEAK_MAX_LISTEN_MS = 45_000;

/** Harnesses with no short MCP tool-call timeout: Claude Code CLI, Codex. */
export const STRONG_MAX_LISTEN_MS = 270_000;

const UNKNOWN: HttpHarness = { kind: 'unknown', label: 'this client' };

// Ordered: the first token found in the User-Agent (or clientInfo name) wins,
// so more specific markers must come before the substrings they contain.
// `claude-code` before `claude`, and Antigravity before any `gemini` marker —
// Antigravity ships Gemini branding in places but caps tool calls where the
// Gemini CLI does not.
const SIGNATURES: ReadonlyArray<readonly [pattern: string, harness: HttpHarness]> = [
  ['antigravity', { kind: 'antigravity', label: 'Antigravity', maxListenMs: WEAK_MAX_LISTEN_MS }],
  ['claude-code', { kind: 'claude-code', label: 'Claude Code', maxListenMs: STRONG_MAX_LISTEN_MS }],
  ['claude code', { kind: 'claude-code', label: 'Claude Code', maxListenMs: STRONG_MAX_LISTEN_MS }],
  // The desktop app runs the same agent as the CLI but a different transport,
  // and that transport DOES time out long tool calls (measured 2026-08-19: a
  // 240s listen fails, 45s returns cleanly).
  ['claude-desktop', { kind: 'claude-desktop', label: 'Claude Desktop', maxListenMs: WEAK_MAX_LISTEN_MS }],
  ['claude-ai', { kind: 'claude-desktop', label: 'Claude Desktop', maxListenMs: WEAK_MAX_LISTEN_MS }],
  ['codex', { kind: 'codex', label: 'Codex', maxListenMs: STRONG_MAX_LISTEN_MS }],
  ['cursor', { kind: 'cursor', label: 'Cursor', maxListenMs: WEAK_MAX_LISTEN_MS }],
  ['windsurf', { kind: 'windsurf', label: 'Windsurf', maxListenMs: WEAK_MAX_LISTEN_MS }],
  ['cline', { kind: 'cline', label: 'Cline', maxListenMs: WEAK_MAX_LISTEN_MS }],
  ['copilot', { kind: 'copilot', label: 'GitHub Copilot', maxListenMs: WEAK_MAX_LISTEN_MS }],
  // Gemini CLI is a terminal agent with no short MCP timeout; keep it after
  // 'antigravity' so the IDE never falls through to the strong cap.
  ['gemini-cli', { kind: 'gemini-cli', label: 'Gemini CLI', maxListenMs: STRONG_MAX_LISTEN_MS }],
];

function classify(raw: string | undefined): HttpHarness | undefined {
  if (!raw) return undefined;
  const hay = raw.toLowerCase();
  for (const [pattern, harness] of SIGNATURES) {
    if (hay.includes(pattern)) return harness;
  }
  return undefined;
}

/**
 * Identify the caller from what a single stateless POST carries.
 *
 * `userAgent` is the HTTP header; `clientName` is `clientInfo.name` from the
 * MCP handshake when this particular request happens to have it. Either may be
 * absent — an unidentified caller returns the `unknown` harness, which clamps
 * nothing.
 */
export function detectHarness(
  userAgent?: string | string[],
  clientName?: string,
): HttpHarness {
  const ua = Array.isArray(userAgent) ? userAgent.join(' ') : userAgent;
  // clientInfo is the more deliberate signal (a client names itself), so it
  // wins when present; the User-Agent is what is actually there most of the
  // time on this stateless endpoint.
  return classify(clientName) ?? classify(ua) ?? UNKNOWN;
}

/**
 * The listen window this caller may actually have.
 *
 * `requested` is what the agent asked for (or the server default). An
 * unidentified client keeps whatever it asked for — this function can only
 * ever shorten a hold, never lengthen one.
 */
export function clampListenMs(requested: number, harness?: HttpHarness): number {
  const cap = harness?.maxListenMs;
  if (typeof cap !== 'number') return requested;
  return Math.min(requested, cap);
}

/** True when we positively identified a client that cannot hold a long call. */
export function isWeakLoop(harness?: HttpHarness): boolean {
  return typeof harness?.maxListenMs === 'number' && harness.maxListenMs <= WEAK_MAX_LISTEN_MS;
}

/**
 * Replacement for the generic "raise your timeout" nudge, for clients we know
 * would break if they took it. Says the safe number outright rather than
 * inviting an experiment that fails as a tool error.
 */
export function weakLoopListenHint(harness: HttpHarness): string {
  return (
    `${harness.label} times out long MCP tool calls, so this server holds your ` +
    `room_listen to ${harness.maxListenMs}ms and returns cleanly instead of erroring. ` +
    'Do not raise timeoutMs — a hold your client kills comes back as a tool error, and a tool error ' +
    'is the most common way an agent stops calling tools and drops out of the room. ' +
    'Just call room_listen again the moment each one returns.'
  );
}
