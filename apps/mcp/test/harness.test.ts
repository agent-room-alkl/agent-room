import { describe, it, expect } from 'vitest';
import {
  defaultListenAfterJoin,
  detectHarness,
  mcpTimeoutHint,
  persistenceSetupHint,
} from '../src/harness.js';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe('detectHarness', () => {
  it('detects Claude Code via CLAUDECODE=1', () => {
    expect(detectHarness(env({ CLAUDECODE: '1' })).kind).toBe('claude-code');
  });

  it('detects Claude Code via CLAUDE_CODE_ENTRYPOINT', () => {
    expect(detectHarness(env({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).kind).toBe('claude-code');
  });

  it('detects Cursor via CURSOR_TRACE_ID', () => {
    expect(detectHarness(env({ CURSOR_TRACE_ID: 'abc' })).kind).toBe('cursor');
  });

  it('detects Cursor via TERM_PROGRAM', () => {
    expect(detectHarness(env({ TERM_PROGRAM: 'Cursor' })).kind).toBe('cursor');
  });

  it('detects Codex CLI via CODEX_RUN_ID', () => {
    expect(detectHarness(env({ CODEX_RUN_ID: 'r1' })).kind).toBe('codex');
  });

  it('detects Claude Desktop via macOS bundle identifier', () => {
    expect(
      detectHarness(env({ __CFBundleIdentifier: 'com.anthropic.claudefordesktop' })).kind,
    ).toBe('claude-desktop');
  });

  it('detects GitHub Copilot agent mode in VS Code', () => {
    expect(detectHarness(env({ GITHUB_COPILOT: '1' })).kind).toBe('copilot');
    expect(detectHarness(env({ TERM_PROGRAM: 'vscode', VSCODE_PID: '123' })).kind).toBe('copilot');
    // Merge resolution (#399 + #400): bare VS Code markers are sufficient —
    // VS Code-spawned MCP servers may carry no TERM_PROGRAM and vice versa.
    expect(detectHarness(env({ TERM_PROGRAM: 'vscode' })).kind).toBe('copilot');
    expect(detectHarness(env({ VSCODE_IPC_HOOK_CLI: '/tmp/x.sock' })).kind).toBe('copilot');
  });

  it('falls back to unknown when no signals match', () => {
    expect(detectHarness(env({})).kind).toBe('unknown');
  });

  it('detects Copilot via explicit markers and generic VS Code process env', () => {
    expect(detectHarness(env({ GITHUB_COPILOT: '1' })).kind).toBe('copilot');
    expect(detectHarness(env({ COPILOT_AGENT: '1' })).kind).toBe('copilot');
    expect(detectHarness(env({ VSCODE_PID: '1234' })).kind).toBe('copilot');
    expect(detectHarness(env({ TERM_PROGRAM: 'vscode' })).kind).toBe('copilot');
  });

  it('VS Code-hosted extensions win over the generic VS Code markers', () => {
    // Cline (and Cursor forks) inherit VSCODE_PID from the host process;
    // their specific env vars must take precedence over the copilot branch.
    expect(detectHarness(env({ CLINE_VERSION: '3.0', VSCODE_PID: '1234' })).kind).toBe('cline');
    expect(
      detectHarness(env({ CURSOR_TRACE_ID: 'abc', VSCODE_PID: '1234' })).kind,
    ).toBe('cursor');
  });

  it('Claude Code wins when both Claude and Codex env vars are present', () => {
    // CLAUDECODE=1 reliably set inside Claude Code. CODEX_HOME is just
    // ~/.codex and may exist on Claude Code users' machines from a prior
    // codex install — the Claude Code branch must win.
    expect(detectHarness(env({ CLAUDECODE: '1', CODEX_HOME: '/Users/x/.codex' })).kind).toBe(
      'claude-code',
    );
  });

  it('claude-code and codex are flagged as not needing setup', () => {
    expect(detectHarness(env({ CLAUDECODE: '1' })).needsPersistenceSetup).toBe(false);
    expect(detectHarness(env({ CODEX_RUN_ID: 'r1' })).needsPersistenceSetup).toBe(false);
  });

  it('cursor / unknown / antigravity need setup, Claude Desktop Code/Cowork is strong-loop', () => {
    expect(detectHarness(env({ CURSOR_TRACE_ID: 'x' })).needsPersistenceSetup).toBe(true);
    expect(detectHarness(env({})).needsPersistenceSetup).toBe(true);
    expect(
      detectHarness(env({ __CFBundleIdentifier: 'com.anthropic.claudefordesktop' }))
        .needsPersistenceSetup,
    ).toBe(false);
    expect(detectHarness(env({ ANTIGRAVITY_CLI: '1' })).needsPersistenceSetup).toBe(true);
    expect(detectHarness(env({ GITHUB_COPILOT: '1' })).needsPersistenceSetup).toBe(true);
  });
});

describe('persistenceSetupHint', () => {
  it('returns empty string for strong-loop harnesses', () => {
    expect(persistenceSetupHint(detectHarness(env({ CLAUDECODE: '1' })))).toBe('');
    expect(persistenceSetupHint(detectHarness(env({ CODEX_RUN_ID: 'r1' })))).toBe('');
    expect(
      persistenceSetupHint(
        detectHarness(env({ __CFBundleIdentifier: 'com.anthropic.claudefordesktop' })),
      ),
    ).toBe('');
  });

  it('returns a setup nudge mentioning init for weak-loop harnesses', () => {
    const hint = persistenceSetupHint(detectHarness(env({ CURSOR_TRACE_ID: 'x' })));
    expect(hint).toContain('Cursor');
    expect(hint).toContain('agent-room-mcp init');
  });

  it('uses generic label for unknown harnesses', () => {
    const hint = persistenceSetupHint(detectHarness(env({})));
    expect(hint).toContain('this client');
    expect(hint).toContain('agent-room-mcp init');
  });

  it('gives Copilot an autoWatch/maxRequests nudge instead of a hook nudge', () => {
    const hint = persistenceSetupHint(detectHarness(env({ GITHUB_COPILOT: '1' })));
    expect(hint).toContain('GitHub Copilot');
    expect(hint).toContain('no stop hooks');
    expect(hint).toContain('chat.agent.maxRequests');
    expect(hint).not.toContain('agent-room-mcp init');
  });

  it('gives Antigravity a memory-rule nudge instead of a hook nudge', () => {
    const hint = persistenceSetupHint(detectHarness(env({ ANTIGRAVITY_CLI: '1' })));
    expect(hint).toContain('Antigravity');
    expect(hint).toContain('agent-room-mcp init antigravity');
    expect(hint).toContain('GEMINI.md join rule');
    expect(hint).toContain('does not currently support stop hooks');
  });

  it('names the Copilot client in persistence and timeout hints', () => {
    const copilot = detectHarness(env({ GITHUB_COPILOT: '1' }));
    expect(persistenceSetupHint(copilot)).toContain('GitHub Copilot (VS Code)');
    expect(mcpTimeoutHint(copilot)).toContain('GitHub Copilot (VS Code)');
  });
});

describe('weak-loop listen defaults', () => {
  it('skips bundled listen on join for weak-loop harnesses unless explicit', () => {
    const antigravity = detectHarness(env({ ANTIGRAVITY_CLI: '1' }));
    const cursor = detectHarness(env({ CURSOR_TRACE_ID: 'x' }));
    expect(defaultListenAfterJoin(antigravity, undefined)).toBe(false);
    expect(defaultListenAfterJoin(cursor, undefined)).toBe(false);
    expect(defaultListenAfterJoin(antigravity, true)).toBe(true);
    expect(defaultListenAfterJoin(antigravity, false)).toBe(false);
    // Strong-loop harnesses bundle the listen by default.
    expect(defaultListenAfterJoin(detectHarness(env({ CLAUDECODE: '1' })), undefined)).toBe(true);
  });

  it('caps listen window for weak-loop harnesses and stays silent for strong ones', () => {
    const cursor = detectHarness(env({ CURSOR_TRACE_ID: 'x' }));
    const antigravity = detectHarness(env({ ANTIGRAVITY_CLI: '1' }));
    expect(cursor.maxListenMs).toBeLessThan(60_000);
    expect(antigravity.maxListenMs).toBeLessThan(60_000);
    expect(detectHarness(env({ CLAUDECODE: '1' })).maxListenMs).toBeGreaterThanOrEqual(240_000);
    // The MCP-timeout hint fires for weak-loop clients, empty for strong.
    expect(mcpTimeoutHint(cursor)).toContain('MCP CALL TIMEOUT');
    expect(mcpTimeoutHint(antigravity)).toContain(String(antigravity.maxListenMs));
    expect(mcpTimeoutHint(detectHarness(env({ CLAUDECODE: '1' })))).toBe('');
  });
});
