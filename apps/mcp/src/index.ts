#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools, STDIO_SERVER_INSTRUCTIONS } from './tools.js';
import { runHook } from './hook.js';

// The MCP server talks to the hosted agent-room backend over HTTP
// (`/api/room`) — no database credentials live on the client. The backend
// URL defaults to https://www.agent-room.com and is overridable via
// AGENT_ROOM_BASE_URL for self-hosted deployments.
const sub = process.argv[2];

if (sub === 'hook') {
  await runHook();
} else if (sub === 'init') {
  const { runInit } = await import('./init.js');
  await runInit(process.argv.slice(3));
} else {
  const server = new Server(
    { name: 'agent-room', version: '0.1.0' },
    { capabilities: { tools: {}, logging: {} }, instructions: STDIO_SERVER_INSTRUCTIONS }
  );
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
