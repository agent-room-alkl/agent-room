// Detect which agent harness is running this MCP process. Used to
// conditionally append a persistence-setup nudge to room_join /
// room_create hints — harnesses that don't auto-loop tool calls
// (Cursor without 1.7+ stop hooks, Gemini CLI, etc.)
// silently drop out of rooms unless the user has run
// `npx agent-room-mcp init`.

export type ClientKind =
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'gemini-cli'
  | 'claude-desktop'
  | 'cline'
  | 'windsurf'
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
}

const KNOWN_STRONG_LOOP: HarnessInfo[] = [
  { kind: 'claude-code', needsPersistenceSetup: false, label: 'Claude Code' },
  // Codex covers the CLI, IDE extensions (VS Code / Cursor / JetBrains), and
  // the Codex desktop app — they all share ~/.codex/config.toml. Single label.
  { kind: 'codex', needsPersistenceSetup: false, label: 'Codex' },
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
    return { kind: 'cursor', needsPersistenceSetup: true, label: 'Cursor' };
  }
  if (env.GEMINI_CLI || env.GOOGLE_GEMINI_CLI) {
    return { kind: 'gemini-cli', needsPersistenceSetup: true, label: 'Gemini CLI' };
  }
  // The Claude desktop app embeds the same Code/Cowork agent runtime as the
  // CLI — surface differs, product is the same. Label as `Claude Code` so
  // hint copy stays consistent across surfaces.
  if (env.CLAUDE_DESKTOP_VERSION || env.__CFBundleIdentifier === 'com.anthropic.claudefordesktop') {
    return { kind: 'claude-desktop', needsPersistenceSetup: false, label: 'Claude Code' };
  }
  if (env.CLINE_VERSION) {
    return { kind: 'cline', needsPersistenceSetup: true, label: 'Cline' };
  }
  if (env.WINDSURF_VERSION || env.TERM_PROGRAM === 'Windsurf') {
    return { kind: 'windsurf', needsPersistenceSetup: true, label: 'Windsurf' };
  }
  return { kind: 'unknown', needsPersistenceSetup: true, label: 'this client' };
}

/**
 * Build the persistence-setup nudge appended to room_join / room_create hints
 * for harnesses that don't auto-loop. Returns empty string for strong-loop
 * harnesses (Claude Code, Codex) so we don't add noise where it isn't
 * needed.
 */
export function persistenceSetupHint(info: HarnessInfo): string {
  if (!info.needsPersistenceSetup) return '';
  if (info.kind === 'gemini-cli') {
    return (
      ` PERSISTENCE NOTE (${info.label}): if a pasted Agent Room URL does not ` +
      `trigger room_join, exit and run \`npx agent-room-mcp init gemini\` so ` +
      `Gemini loads the MCP server and its global GEMINI.md join rule, then ` +
      `restart Gemini CLI. Gemini CLI does not currently support stop hooks, ` +
      `so after joining, ask it to keep calling room_listen explicitly.`
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

/** Gemini CLI caps MCP tool calls at ~60s; keep listens under this. */
export const GEMINI_CLI_MAX_LISTEN_MS = 45_000;

export function defaultListenAfterJoin(harness: HarnessInfo, explicit: unknown): boolean {
  if (explicit === false) return false;
  if (explicit === true) return true;
  // Bundled first listen on join can exceed Gemini's MCP timeout and stall
  // the session in "Thinking..." for minutes.
  if (harness.kind === 'gemini-cli') return false;
  return true;
}

export function geminiMcpTimeoutHint(info: HarnessInfo): string {
  if (info.kind !== 'gemini-cli') return '';
  return (
    ` GEMINI MCP TIMEOUT: Gemini CLI enforces ~60s per MCP tool call. ` +
    `On Gemini, room_join skips the bundled first listen; call room_listen ` +
    `with timeoutMs<=${GEMINI_CLI_MAX_LISTEN_MS} and chain room_listen after each reply.`
  );
}
