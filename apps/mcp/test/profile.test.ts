// The consolidated tool surface: 8 core tools + 3 extras (task board, host
// admin, watch) — with every pre-consolidation name still
// dispatching as a hidden alias, and AGENT_ROOM_PROFILE=core gating on the
// canonical (listed) name so legacy core calls like room_status keep working.

import { afterEach, describe, expect, it } from 'vitest';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { registerTools, CORE_PROFILE_TOOLS, toLegacyCall, CANONICAL_NAME } from '../src/tools.js';

type Handler = (req: any) => Promise<any>;

function captureHandlers(): { server: Server; handlers: Map<unknown, Handler> } {
  const handlers = new Map<unknown, Handler>();
  const server = {
    setRequestHandler(schema: unknown, handler: Handler) {
      handlers.set(schema, handler);
    },
    sendLoggingMessage: async () => {},
  } as unknown as Server;
  return { server, handlers };
}

afterEach(() => {
  delete process.env.AGENT_ROOM_PROFILE;
});

describe('consolidated tool surface', () => {
  it('lists 11 tools on the full profile — consolidated names only, no aliases', async () => {
    const { server, handlers } = captureHandlers();
    registerTools(server);
    const { tools } = await handlers.get(ListToolsRequestSchema)!({});
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(11);
    expect(names).toContain('room_task');
    expect(names).toContain('room_admin');
    expect(names).toContain('room_watch');
    // Old per-verb names are dispatch-only aliases, never listed.
    expect(names).not.toContain('room_task_create');
    expect(names).not.toContain('room_status');
    expect(names).not.toContain('room_set_mode');
    expect(names).not.toContain('room_list_messages');
  });

  it('core profile includes the authenticated attachment reader', async () => {
    process.env.AGENT_ROOM_PROFILE = 'core';
    const { server, handlers } = captureHandlers();
    registerTools(server);
    const { tools } = await handlers.get(ListToolsRequestSchema)!({});
    const names = tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([...CORE_PROFILE_TOOLS].sort());
    expect(names).toHaveLength(8);
    expect(names).toContain('room_attachment_read');
  });

  it('core profile refuses full-only tools (and their aliases) with a hint', async () => {
    process.env.AGENT_ROOM_PROFILE = 'core';
    const { server, handlers } = captureHandlers();
    registerTools(server);
    for (const name of ['room_task', 'room_task_list', 'room_admin', 'room_set_mode']) {
      const res = await handlers.get(CallToolRequestSchema)!({
        params: { name, arguments: { code: 'ABC-DEF-GHJ' } },
      });
      const body = JSON.parse(res.content[0].text);
      expect(body.error, name).toBe('unknown_tool');
      expect(body.hint).toContain('AGENT_ROOM_PROFILE');
    }
  });

  it('unknown profile values fall back to full', async () => {
    process.env.AGENT_ROOM_PROFILE = 'banana';
    const { server, handlers } = captureHandlers();
    registerTools(server);
    const { tools } = await handlers.get(ListToolsRequestSchema)!({});
    expect(tools.length).toBe(11);
  });
});

describe('toLegacyCall translation', () => {
  it('routes consolidated calls onto the legacy dispatch branches', () => {
    expect(toLegacyCall('room_send', { code: 'C', name: 'A', text: 'hi', kind: 'status' }))
      .toEqual({ name: 'room_status', args: { code: 'C', name: 'A', text: 'hi' } });
    expect(toLegacyCall('room_send', { code: 'C', name: 'A', text: 'hi' }).name).toBe('room_send');

    expect(toLegacyCall('room_listen', { code: 'C', since: 3, timeoutMs: 0 }))
      .toEqual({ name: 'room_list_messages', args: { code: 'C', since: 3 } });
    expect(toLegacyCall('room_listen', { code: 'C', since: 3 }).name).toBe('room_listen');

    expect(toLegacyCall('room_minutes', { code: 'C', export: true }).name).toBe('room_export');
    expect(toLegacyCall('room_minutes', { code: 'C' }).name).toBe('room_minutes');

    expect(toLegacyCall('room_watch', { code: 'C', enabled: false }))
      .toEqual({ name: 'room_unwatch', args: { code: 'C' } });
    expect(toLegacyCall('room_watch', { code: 'C', since: 0, name: 'A' }).name).toBe('room_watch');

    expect(toLegacyCall('room_task', { code: 'C', action: 'claim', name: 'A', id: 'T-01' }))
      .toEqual({ name: 'room_task_claim', args: { code: 'C', name: 'A', id: 'T-01' } });

    expect(toLegacyCall('room_admin', { code: 'C', name: 'A', action: 'reactivate' }))
      .toEqual({ name: 'room_reactivate', args: { code: 'C', name: 'A' } });
    expect(toLegacyCall('room_admin', { code: 'C', name: 'A', action: 'skip' }).name).toBe('room_skip_current');
    expect(toLegacyCall('room_admin', { code: 'C', name: 'A', action: 'invoke', targetName: 'B' }))
      .toEqual({ name: 'room_direct_invoke', args: { code: 'C', name: 'A', targetName: 'B', targetClient: 'cc' } });

    const setMode = toLegacyCall('room_admin', { code: 'C', name: 'A', action: 'set_mode', mode: 'moderator', moderatorAgentName: 'M' });
    expect(setMode.name).toBe('room_set_mode');
    expect(setMode.args.mode).toBe('moderator');
    expect(setMode.args.modeConfig).toEqual({ moderatorAgentName: 'M', moderatorAgentClient: 'cc' });
  });

  it('passes legacy names through untouched', () => {
    for (const name of ['room_status', 'room_list_messages', 'room_task_verify', 'room_set_mode', 'room_unwatch', 'room_export']) {
      expect(toLegacyCall(name, { code: 'C' }).name).toBe(name);
    }
  });

  it('maps every legacy branch to a listed canonical tool', () => {
    const canonicals = new Set(Object.values(CANONICAL_NAME));
    for (const c of canonicals) {
      expect(['room_send', 'room_listen', 'room_minutes', 'room_watch', 'room_admin', 'room_task']).toContain(c);
    }
  });
});
