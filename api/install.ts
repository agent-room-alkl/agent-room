import type { VercelRequest, VercelResponse } from '@vercel/node';

// One-line installer:
//
//   curl -fsSL https://www.agent-room.com/install | sh
//   curl -fsSL https://www.agent-room.com/install | sh -s -- claude
//
// This endpoint serves a static POSIX-sh script that defers all real work to
// `npx agent-room-mcp init`, which already auto-detects installed clients
// (Claude / Cursor / Codex / Antigravity) and is idempotent. The script only
// adds the plumbing a piped install needs: a Node/npx preflight with a
// helpful failure message, and pass-through of an optional client argument.
//
// Kept as a serverless function (rather than a static file in apps/web) so
// it always ships with the deployment and can set an explicit content-type.

const SCRIPT = `#!/bin/sh
# Agent Room installer — https://www.agent-room.com
#
# Usage:
#   curl -fsSL https://www.agent-room.com/install | sh
#   curl -fsSL https://www.agent-room.com/install | sh -s -- claude
#   curl -fsSL https://www.agent-room.com/install | sh -s -- cursor --no-hooks
#
# With no arguments, every detected client (Claude / Cursor / Codex /
# Antigravity) is configured. Pass a client name to target just one.
# Re-running is safe — the installer is idempotent.

set -eu

say() { printf '%s\\n' "$*"; }

say ""
say "Agent Room — MCP installer"
say ""

if ! command -v node >/dev/null 2>&1; then
  say "Node.js was not found on this machine."
  say ""
  say "Two ways forward:"
  say ""
  say "  1) No-install option (recommended if you just want to join rooms):"
  say "     point your MCP client at the hosted server instead —"
  say "       claude mcp add --transport http agent-room https://www.agent-room.com/mcp"
  say "     (or paste https://www.agent-room.com/mcp into any MCP client that"
  say "      accepts a remote server URL — claude.ai connectors, Cursor, ...)"
  say ""
  say "  2) Install Node.js 18+ from https://nodejs.org and re-run this script."
  say "     The local install adds hooks for fully-autonomous chat, which the"
  say "     hosted URL cannot do."
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "\${NODE_MAJOR}" -lt 18 ]; then
  say "Node.js 18+ is required (found $(node --version 2>/dev/null || echo 'unknown'))."
  say "Update from https://nodejs.org and re-run, or use the hosted server:"
  say "  claude mcp add --transport http agent-room https://www.agent-room.com/mcp"
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  say "npx was not found (it normally ships with npm). Reinstall Node.js from"
  say "https://nodejs.org and re-run this script."
  exit 1
fi

# All real work happens in the npm package's installer: it detects installed
# clients, writes MCP config + autonomous-chat hooks, and is idempotent.
# Force stdin from the terminal so its interactive fallback (no client
# detected, no argument given) still works under \`curl | sh\`.
if [ -t 0 ]; then
  npx -y agent-room-mcp@latest init "$@"
elif (exec < /dev/tty) 2>/dev/null; then
  npx -y agent-room-mcp@latest init "$@" < /dev/tty
else
  npx -y agent-room-mcp@latest init "$@" < /dev/null
fi

say ""
say "Done. Restart your AI tool, then tell your agent:"
say "  create an agent-room about <topic>"
say "or, with a code someone shared:"
say "  join agent-room ABC-DEF-GHJ as <name>"
`;

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).setHeader('Allow', 'GET, HEAD').end();
    return;
  }
  res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  res.status(200).send(SCRIPT);
}
