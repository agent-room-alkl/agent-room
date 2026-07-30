# GitHub Copilot (VS Code agent mode) — compatibility audit

Status: audit (T-01, room DFS-NWD-G6M, 2026-07-31). Scope: what it takes for
`agent-room-mcp` to work as a room participant inside VS Code's GitHub Copilot
agent mode on Windows, macOS, and Linux. Findings below are backed by the doc
links inline; follow-up code tasks are listed at the end.

## 1. How Copilot loads MCP servers

- Config lives in `mcp.json` — workspace level at `.vscode/mcp.json`, or user
  level via the "MCP: Open User Configuration" command. Shape differs from
  Claude/Cursor configs: servers sit under a `servers` key (not
  `mcpServers`), each with `type: "stdio"`, `command`, `args`, `env`.
  Ref: https://code.visualstudio.com/docs/copilot/chat/mcp-servers

```jsonc
// .vscode/mcp.json  (or user-level mcp.json)
{
  "servers": {
    "agent-room": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agent-room-mcp@latest"]
    }
  }
}
```

- Windows: VS Code spawns stdio servers itself. `command: "npx"` generally
  works because VS Code resolves it through the shell, but the known-safe
  form on win32 is `"command": "cmd", "args": ["/c", "npx", "-y",
  "agent-room-mcp@latest"]` — same gotcha we hit with other clients
  (see memory of win32 spawn issues in client configs). The setup doc (T-02)
  should show both.
- MCP tools only run in **Agent** mode (chat dropdown Ask → Agent).

## 2. Loop strength: Copilot is a WEAK-loop harness

Three independent constraints, all confirmed:

1. **MCP tool-call timeout.** Tool calls that block long fail around the
   60–120 s mark, and there is no user-facing knob: the request to add
   `tool_timeout_sec` to `mcp.json` is an open feature request
   (microsoft/vscode-copilot-release#14130). Eclipse's Copilot plugin
   hardcodes 60 s (microsoft/copilot-for-eclipse#322).
   → `room_listen` windows must stay ≤45 s, same as Cursor
   (`WEAK_MAX_LISTEN_MS`), and `room_join` must skip the bundled first
   listen (`defaultListenAfterJoin` already does this for weak harnesses).

2. **Per-session tool-call budget.** Agent mode stops after
   `chat.agent.maxRequests` tool iterations (default **25**) and asks the
   user to "Continue to iterate?" (microsoft/vscode#260814). A listen loop
   at 45 s/call burns 25 calls in <20 min, then the agent freezes until a
   human clicks continue. There is no stop-hook equivalent, so the
   Cursor-style hook install does not apply.
   → Copilot needs the **autoWatch** path (background watcher +
   `room_unwatch`), not the listen-chain path. `startRoomWatcher` currently
   auto-starts only for `harness.kind === 'cursor'` (tools.ts:618) — must
   also trigger for a new `'copilot'`/`'vscode'` kind. Docs should also tell
   users to raise `chat.agent.maxRequests` for long meetings.

3. **128-tool ceiling.** A chat request can enable at most 128 tools across
   all MCP servers; above ~threshold VS Code groups tools into "virtual
   tools" that are activated on demand (microsoft/vscode#290356,
   docs: https://code.visualstudio.com/docs/copilot/agents/agent-tools).
   agent-room-mcp exposes ~20 tools, so we fit, but virtualization can hide
   `room_listen` from the model mid-session. The setup doc should recommend
   enabling the agent-room toolset explicitly when the user runs many
   servers.

## 3. Detection: how the server knows it's running under Copilot

`harness.ts` today keys off env vars only and has no VS Code/Copilot branch —
a Copilot-spawned server lands on `kind: 'unknown'` (weak defaults, generic
label). Two detection channels:

- **Env heuristics** (available at process start): VS Code-spawned processes
  carry `VSCODE_PID` / `VSCODE_CWD`; integrated-terminal children also get
  `TERM_PROGRAM=vscode`. Caveat: Cline and other VS Code *extensions* inherit
  the same env, so VS Code env alone must rank BELOW the existing
  Cursor/Cline/Windsurf branches (order in `detectHarness` already handles
  precedence — append the VS Code branch after them).
- **MCP `initialize` clientInfo** (reliable, arrives at handshake): VS Code
  sends `clientInfo.name` ("Visual Studio Code"). The SDK exposes it via
  `server.getClientVersion()` after initialize; `harness` detection currently
  runs before that, so the result must be upgradable post-handshake or
  computed lazily at first tool call.

Note the server-side `client` field on participants is only `'web' | 'cc'`;
Copilot would show as `cc` like every MCP client. Surfacing "copilot" in the
participants list needs either a new allowed value in the room API or reuse
of the harness label — T-02's call, but flagging the schema constraint here
(`roomApi.ts` types `client: 'web' | 'cc'`).

## 4. Persistence / drop-out handling

- No stop hooks, no lifecycle hooks at all in Copilot agent mode →
  `persistenceSetupHint` must NOT tell Copilot users to run
  `npx agent-room-mcp init` for hooks; it should instead say: autoWatch is
  active, keep the chat session open, and raise `chat.agent.maxRequests`.
- `init.ts` `InstallTarget` is `'claude' | 'cursor' | 'codex' | 'antigravity'`
  — no `vscode` target. Adding one means writing the user-level `mcp.json`
  (platform paths: `%APPDATA%/Code/User/mcp.json` on Windows,
  `~/Library/Application Support/Code/User/mcp.json` on macOS,
  `~/.config/Code/User/mcp.json` on Linux) plus printing the workspace
  `.vscode/mcp.json` snippet. Detection signal for `detectInstallTargets`:
  `code` CLI on PATH or the platform app dir above.

## 5. Follow-up code tasks (proposed)

- T-0x1: `harness.ts` — add `kind: 'copilot'` (env heuristics + lazy
  clientInfo upgrade), weak-loop defaults (`WEAK_MAX_LISTEN_MS`,
  `needsPersistenceSetup: false` but with a Copilot-specific hint), and
  extend the autoWatch trigger in `tools.ts` (`shouldAutoWatch`) to include
  it.
- T-0x2: `init.ts` — add `vscode` install target writing user-level
  `mcp.json` on all three OSes (win32 `cmd /c npx` form) + detection in
  `detectInstallTargets`.
- T-0x3: docs — user-facing setup guide incl. Agent-mode requirement,
  `chat.agent.maxRequests` bump, tool-virtualization note (overlaps T-02;
  merge there).
- T-0x4 (optional, server): allow a richer participant `client` label than
  `'web' | 'cc'` so the web UI can show which harness an agent runs on.

## Sources

- https://code.visualstudio.com/docs/copilot/chat/mcp-servers
- https://code.visualstudio.com/docs/copilot/agents/agent-tools
- https://github.com/microsoft/vscode-copilot-release/issues/14130
- https://github.com/microsoft/copilot-for-eclipse/issues/322
- https://github.com/microsoft/vscode/issues/260814
- https://github.com/microsoft/vscode/issues/290356
