// Detect which agent harness is running this MCP process. Used to
// conditionally append a persistence-setup nudge to room_join /
// room_create hints — harnesses that don't auto-loop tool calls
// (Cursor without 1.7+ stop hooks, Antigravity, etc.)
// silently drop out of rooms unless the user has run
// `npx agent-room-mcp init`.

export type ClientKind =
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'antigravity'
  | 'claude-desktop'
  | 'cline'
  | 'windsurf'
  | 'copilot'
  | 'unknown';

export interface HarnessInfo {
  kind: ClientKind;
  /** True when the harness is known NOT to auto-loop tool calls and
   *  therefore needs the agent-room-mcp stop hook installed for
   *  persistent listening. Conservative default for unknown clients
   *  is `true` — better to over-nudge than have an agent silently
   *  drop out of every room. */
  needsPersistenceSetup: boolean;
  /** Human-readable harness label to splice into hints. */
  label: string;
  /** Safe duration for a single blocking MCP tool call (e.g. room_listen) on
   *  this harness. Strong-loop harnesses (Claude Code, Codex) have no short MCP
   *  timeout and allow long listens; Cursor / Antigravity / other IDE clients cap
   *  MCP calls (~60s), so their listens must stay well under that. */
  maxListenMs: number;
}

/** Long listen window for harnesses with no short MCP tool-call timeout. */
export const STRONG_MAX_LISTEN_MS = 270_000;
/** Conservative cap for harnesses that time out long MCP tool calls — Cursor,
 *  Antigravity, Cline, Windsurf, and unknown clients. Keep listens under ~60s. */
export const WEAK_MAX_LISTEN_MS = 45_000;

const KNOWN_STRONG_LOOP: HarnessInfo[] = [
  { kind: 'claude-code', needsPersistenceSetup: false, label: 'Claude Code', maxListenMs: STRONG_MAX_LISTEN_MS },
  // Codex covers the CLI, IDE extensions (VS Code / Cursor / JetBrains), and
  // the Codex desktop app — they all share ~/.codex/config.toml. Single label.
  { kind: 'codex', needsPersistenceSetup: false, label: 'Codex', maxListenMs: STRONG_MAX_LISTEN_MS },
];

export function detectHarness(env: NodeJS.ProcessEnv = process.env): HarnessInfo {
  // Order matters: most specific signals first. Each branch keys off a
  // single env var the host harness is documented to set. Conservative
  // by design — when in doubt we return 'unknown', which is treated as
  // weak-loop (user gets a setup nudge, low downside).

  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) {
    return KNOWN_STRONG_LOOP[0]!;
  }
  if (env.CODEX_RUN_ID || (env.CODEX_HOME && !env.CLAUDECODE)) {
    return KNOWN_STRONG_LOOP[1]!;
  }
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT || env.TERM_PROGRAM === 'Cursor') {
    return { kind: 'cursor', needsPersistenceSetup: true, label: 'Cursor', maxListenMs: WEAK_MAX_LISTEN_MS };
  }
  if (
    env.ANTIGRAVITY_CLI ||
    env.ANTIGRAVITY ||
    env.GOOGLE_ANTIGRAVITY ||
    env.TERM_PROGRAM === 'Antigravity' ||
    env.GEMINI_CLI ||
    env.GOOGLE_GEMINI_CLI
  ) {
    return { kind: 'antigravity', needsPersistenceSetup: true, label: 'Antigravity', maxListenMs: WEAK_MAX_LISTEN_MS };
  }
  // The Claude desktop app embeds the same Code/Cowork agent runtime as the
  // CLI — surface differs, product is the same. Label as `Claude Code` so
  // hint copy stays consistent across surfaces.
  if (env.CLAUDE_DESKTOP_VERSION || env.__CFBundleIdentifier === 'com.anthropic.claudefordesktop') {
    return { kind: 'claude-desktop', needsPersistenceSetup: false, label: 'Claude Code', maxListenMs: STRONG_MAX_LISTEN_MS };
  }
  if (env.CLINE_VERSION) {
    return { kind: 'cline', needsPersistenceSetup: true, label: 'Cline', maxListenMs: WEAK_MAX_LISTEN_MS };
  }
  if (env.WINDSURF_VERSION || env.TERM_PROGRAM === 'Windsurf') {
    return { kind: 'windsurf', needsPersistenceSetup: true, label: 'Windsurf', maxListenMs: WEAK_MAX_LISTEN_MS };
  }
  // GitHub Copilot agent mode (VS Code). Explicit markers first (users set
  // GITHUB_COPILOT=1 in mcp.json env per INSTALL.md); generic VS Code
  // process markers (VSCODE_PID/VSCODE_CWD/VSCODE_IPC_HOOK_CLI) rank LAST
  // before 'unknown' because every VS Code-hosted extension (Cline, etc.)
  // inherits them — the branches above must win when their specific vars are
  // present. Bare markers stay sufficient: MCP servers spawned by VS Code
  // itself (not an integrated terminal) may carry no TERM_PROGRAM.
  if (
    env.GITHUB_COPILOT ||
    env.COPILOT_AGENT ||
    env.VSCODE_COPILOT ||
    env.VSCODE_GITHUB_COPILOT ||
    env.VSCODE_PID ||
    env.VSCODE_CWD ||
    env.VSCODE_IPC_HOOK_CLI ||
    env.TERM_PROGRAM === 'vscode'
  ) {
    return { kind: 'copilot', needsPersistenceSetup: true, label: 'GitHub Copilot (VS Code)', maxListenMs: WEAK_MAX_LISTEN_MS };
  }
  return { kind: 'unknown', needsPersistenceSetup: true, label: 'this client', maxListenMs: WEAK_MAX_LISTEN_MS };
}

/**
 * Build the persistence-setup nudge appended to room_join / room_create hints
 * for harnesses that don't auto-loop. Returns empty string for strong-loop
 * harnesses (Claude Code, Codex) so we don't add noise where it isn't
 * needed.
 */
export function persistenceSetupHint(info: HarnessInfo): string {
  if (!info.needsPersistenceSetup) return '';
  if (info.kind === 'copilot') {
    // Copilot agent mode has no stop/lifecycle hooks, so the init-hooks nudge
    // would be a dead end. autoWatch (background poller + logging
    // notifications) is the persistence path; the request budget is the real
    // ceiling users can raise.
    return (
      ` PERSISTENCE NOTE (${info.label}): Copilot has no stop hooks, so background ` +
      `room watching is active instead — new messages arrive as notifications. ` +
      `Keep this chat session open to stay in the room, and raise ` +
      `"chat.agent.maxRequests" in VS Code settings (default 25) for long ` +
      `meetings so the agent is not paused mid-room for a "Continue?" click.`
    );
  }
  if (info.kind === 'antigravity') {
    return (
      ` PERSISTENCE NOTE (${info.label}): if a pasted Agent Room URL does not ` +
      `trigger room_join, exit and run \`npx agent-room-mcp init antigravity\` so ` +
      `Antigravity loads the global MCP config and ~/.gemini/GEMINI.md join rule, ` +
      `then restart Antigravity. After joining, ask it to keep calling room_listen ` +
      `explicitly — Antigravity does not currently support stop hooks.`
    );
  }
  return (
    ` PERSISTENCE NOTE (${info.label}): if you cannot keep room_listen ` +
    `chained between turns, exit and run \`npx agent-room-mcp init\` ` +
    `(without --no-hooks) to install the stop hook, then rejoin. ` +
    `Without the hook your turn will end after each tool call and you'll ` +
    `silently drop out of the room.`
  );
}

export function defaultListenAfterJoin(harness: HarnessInfo, explicit: unknown): boolean {
  if (explicit === false) return false;
  if (explicit === true) return true;
  // Weak-loop harnesses (Cursor, Antigravity, Cline, …) time out long MCP tool
  // calls, so a bundled long first-listen on join can exceed their limit and
  // stall the session. They each have their own persistence (stop hook /
  // autoWatch / manual room_listen), so skip the bundled listen and let them
  // call a capped room_listen themselves.
  if (harness.needsPersistenceSetup) return false;
  return true;
}

// Hint appended to room_join for harnesses that time out long MCP tool calls
// (maxListenMs < STRONG). Tells the agent that join skipped the bundled listen
// and to keep each room_listen window under the cap.
export function mcpTimeoutHint(info: HarnessInfo): string {
  if (info.maxListenMs >= STRONG_MAX_LISTEN_MS) return '';
  return (
    ` MCP CALL TIMEOUT (${info.label}): this client times out long MCP tool calls, ` +
    `so room_join skipped the bundled first listen — call room_listen with ` +
    `timeoutMs≤${info.maxListenMs} and chain another room_listen after each reply.`
  );
}
