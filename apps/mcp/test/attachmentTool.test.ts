import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

type Handler = (req: any) => Promise<any>;

const savedClaude = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT };
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENT_ROOM_STATE_DIR; delete process.env.CODEX_RUN_ID; delete process.env.CODEX_THREAD_ID; delete process.env.AGENT_ROOM_STATE_FILE; delete process.env.AGENT_ROOM_BASE_URL; delete process.env.AGENT_ROOM_PROFILE;
  if (savedClaude.CLAUDECODE !== undefined) process.env.CLAUDECODE = savedClaude.CLAUDECODE;
  if (savedClaude.CLAUDE_CODE_ENTRYPOINT !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = savedClaude.CLAUDE_CODE_ENTRYPOINT;
});

const CODE = 'ABC-DEF-GHJ';
const ACCESS = 'a'.repeat(43); const PART = 'p'.repeat(43);

/** Codex harness after a wrapper restart: joins live only in the harness-scoped state file. */
function arrangeHarnessOnlyState() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-room-tool-'));
  process.env.AGENT_ROOM_STATE_DIR = dir;
  process.env.CODEX_RUN_ID = 'run-1';
  process.env.CODEX_THREAD_ID = '';
  // The test itself may run under Claude Code; harness detection must see Codex.
  delete process.env.CLAUDECODE; delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.AGENT_ROOM_STATE_FILE;
  process.env.AGENT_ROOM_BASE_URL = 'https://room.example';
  const scope = createHash('sha256').update('run-1').digest('hex').slice(0, 16);
  writeFileSync(join(dir, `state-harness-codex-${scope}.json`), JSON.stringify({
    version: 1,
    rooms: { [CODE]: { name: 'Me', cursor: 0, joinedAt: 1, accessToken: ACCESS, participantToken: PART } },
  }));
}

function stubFetch(attachment: { name: string; mime: string; type: 'image' | 'file'; bytes: number[] }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? String(init.body) : undefined });
    if (url.endsWith('/api/room')) {
      const action = JSON.parse(String(init?.body)).action;
      if (action === 'messages') {
        return new Response(JSON.stringify({ messages: [{ id: 1, type: 'msg', name: 'Peer', initials: 'PE', color: '#000', role: 'Dev', text: 'see attached', client: 'cc', time: 1,
          attachments: [{ id: 'att-1', type: attachment.type, url: `/attachments/${CODE}-att-1-${attachment.name}`, storageKey: 'k', name: attachment.name, size: attachment.bytes.length, mime: attachment.mime, uploadedAt: 1 }] }] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: { cursor: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(new Uint8Array(attachment.bytes), { status: 200 });
  }));
  return calls;
}

async function tools() {
  vi.resetModules();
  const { registerTools } = await import('../src/tools.js');
  const handlers = new Map<unknown, Handler>();
  const server = { setRequestHandler(schema: unknown, handler: Handler) { handlers.set(schema, handler); } } as unknown as Server;
  registerTools(server);
  return (name: string, args: Record<string, unknown>) => handlers.get(CallToolRequestSchema)!({ params: { name, arguments: args } });
}

describe('tool client after a harness restart', () => {
  it('room_send carries both capabilities from the harness-scoped state on its first call', async () => {
    arrangeHarnessOnlyState();
    const calls = stubFetch({ name: 'x.txt', mime: 'text/plain', type: 'file', bytes: [] });
    const call = await tools();
    await call('room_send', { code: CODE, name: 'Me', text: 'hello' });
    const first = calls.find((c) => c.url.endsWith('/api/room') && c.body?.includes('"action":"send"'));
    expect(first, 'send request').toBeDefined();
    expect(first!.headers['x-agent-room-access']).toBe(ACCESS);
    expect(first!.headers.authorization).toBe(`Bearer ${PART}`);
  });
});

describe('room_attachment_read on a self-hosted room', () => {
  it('is readable through the authenticated core profile', async () => {
    arrangeHarnessOnlyState();
    process.env.AGENT_ROOM_PROFILE = 'core';
    const calls = stubFetch({ name: 'proof.txt', mime: 'text/plain', type: 'file', bytes: [112, 114, 111, 111, 102] });
    const call = await tools();
    const res = await call('room_attachment_read', { code: CODE, id: 'att-1' });
    expect(res.content.map((part: any) => part.text ?? '').join('\n')).toContain('proof');
    const get = calls.find((c) => c.url.includes('/attachments/'));
    expect(get!.headers['x-agent-room-access']).toBe(ACCESS);
  });

  it('returns an MCP image block for an image attachment', async () => {
    arrangeHarnessOnlyState();
    const calls = stubFetch({ name: 'pic.png', mime: 'image/png', type: 'image', bytes: [137, 80, 78, 71] });
    const call = await tools();
    const res = await call('room_attachment_read', { code: CODE, id: 'att-1' });
    const image = res.content.find((c: any) => c.type === 'image');
    expect(image).toBeDefined();
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data, 'base64')).toEqual(Buffer.from([137, 80, 78, 71]));
    const get = calls.find((c) => c.url.includes('/attachments/'));
    expect(get!.url).toBe(`https://room.example/attachments/${CODE}-att-1-pic.png`);
    expect(get!.headers['x-agent-room-access']).toBe(ACCESS);
  });

  it('returns a resource blob for an allowed but unsupported format and never a raw protected url', async () => {
    arrangeHarnessOnlyState();
    const calls = stubFetch({ name: 'bundle.zip', mime: 'application/zip', type: 'file', bytes: [80, 75, 3, 4] });
    const call = await tools();
    const res = await call('room_attachment_read', { code: CODE, id: 'att-1' });
    const blob = res.content.find((c: any) => c.type === 'resource');
    expect(blob).toBeDefined();
    expect(blob.resource.mimeType).toBe('application/zip');
    expect(Buffer.from(blob.resource.blob, 'base64')).toEqual(Buffer.from([80, 75, 3, 4]));
    const texts = res.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    expect(texts).not.toContain('/attachments/');
    const get = calls.find((c) => c.url.includes('/attachments/'));
    expect(get!.headers['x-agent-room-access']).toBe(ACCESS);
  });
});
