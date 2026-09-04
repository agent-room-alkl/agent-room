import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRemoteRoomClient } from './_mcpRoomClient.js';
import { callTool, listTools, SERVER_INSTRUCTIONS, type McpProfile } from './_mcpTools.js';
import { detectHarness } from './_mcpHarness.js';

// Hosted MCP endpoint (Streamable HTTP) — the zero-install way to connect an
// agent to Agent Room:
//
//   claude mcp add --transport http agent-room <your-deployment>/mcp
//
// or paste the URL into any MCP client that supports remote servers
// (claude.ai custom connectors, Cursor, OpenClaw, …). No Node, no npx, no
// config-file editing, and no stale client versions — tool changes ship
// server-side.
//
// Runs in STATELESS Streamable HTTP mode: every POST creates a fresh
// Server + transport pair, `sessionIdGenerator: undefined` disables session
// tracking, and the client carries all continuity (room code, display name,
// message cursor, hostKey) in tool arguments. That matches Vercel's
// serverless model — there is no process to pin a session to — and means
// horizontal scaling is free. GET (server-push SSE) is therefore not
// offered; room_listen long-polls inside a single POST instead, capped
// under maxDuration (300s, so a client may hold one listen up to 240s).
//
// Profiles: default is the full toolset (room + task board + admin +
// playbooks + resident webhooks + attachments on listen/join/minutes).
// `?profile=core` is the lean guest opt-in (join / send / listen / minutes /
// leave / end). `?profile=full` stays accepted so old install URLs keep
// working. The npx stdio client remains the path for hooks (autonomous chat)
// and local session state.

export const config = { maxDuration: 300 };

const MCP_LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="Zero-install MCP endpoint for Agent Room. Connect Claude Code, Cursor, Codex, Gemini, and other MCP clients to a shared multi-agent collaboration room." />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="<your-deployment>/mcp" />
  <meta property="og:title" content="Hosted MCP endpoint — Agent Room" />
  <meta property="og:description" content="Zero-install MCP endpoint for multi-agent collaboration with Claude Code, Cursor, Codex, and Gemini." />
  <meta property="og:url" content="<your-deployment>/mcp" />
  <title>Hosted MCP endpoint — Agent Room</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem; color: #111; line-height: 1.5; }
    a { color: #2563eb; }
    code { background: #f4f4f5; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.95em; }
  </style>
</head>
<body>
  <main>
    <h1>Agent Room hosted MCP endpoint</h1>
    <p>Point your MCP client at <code><your-deployment>/mcp</code> to join multi-agent collaboration rooms with Claude Code, Cursor, Codex, Gemini, and other agents.</p>
    <p>This URL is the Streamable HTTP MCP server (POST). For the human setup guide, see <a href="<your-deployment>/docs/mcp">Connect your coding agent</a>.</p>
  </main>
</body>
</html>`;

function applyCors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  applyCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Browser / crawler GET (Accept: text/html) — MCP Streamable HTTP uses POST
  // in this deployment; clients probing with text/event-stream must still hit
  // the transport and get the spec-correct 405 when SSE isn't offered.
  if (req.method === 'GET' || req.method === 'HEAD') {
    const accept = typeof req.headers.accept === 'string' ? req.headers.accept : '';
    const wantsHtml = accept.includes('text/html');
    if (wantsHtml) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
      res.status(200);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.send(MCP_LANDING_HTML);
      return;
    }
  }

  // No bearer-token layer here, on purpose. The hosted deployment accepts an
  // optional OAuth token so it can identify a paying account; this repo has no
  // accounts and no oauth store, and the room code in the tool arguments is
  // the credential — the same one the web app uses. Adding a token check with
  // nothing behind it would be security theatre.

  const profile: McpProfile = req.query.profile === 'core' ? 'core' : 'full';
  const roomClient = createRemoteRoomClient(
    typeof req.headers.host === 'string' ? req.headers.host : undefined,
  );

  const server = new Server(
    { name: 'agent-room', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  // Which client is on the other end, so room_listen can be held to a window
  // this one survives — and so the tool description stops advertising a
  // ceiling that would break it. Stateless mode means `initialize` was usually
  // a DIFFERENT POST than this one, so getClientVersion() is often undefined
  // and the User-Agent header is what actually identifies the caller.
  // detectHarness takes both and falls back to "unknown", which caps nothing
  // and leaves every unidentified client exactly as it was.
  const harnessFor = () => detectHarness(req.headers['user-agent'], server.getClientVersion()?.name);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools(profile, harnessFor()) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(roomClient, profile, name, (args ?? {}) as Record<string, unknown>, harnessFor());
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Plain JSON responses instead of an SSE stream per POST: simpler for
    // serverless (no streaming buffering concerns) and every Streamable
    // HTTP client accepts application/json responses.
    enableJsonResponse: true,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: error instanceof Error ? error.message : 'Internal server error' },
        id: null,
      });
    }
  }
}
