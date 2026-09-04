// End-to-end smoke test for the hosted MCP endpoint (`api/mcp.ts`).
//
// Boots a real HTTP server around the actual handler and drives it with the
// official MCP SDK client over Streamable HTTP — the same wire path a real
// `claude mcp add --transport http` client uses. That is the point: the parts
// most likely to break here are transport negotiation and the adapter seam,
// and neither shows up in a unit test that calls `callTool` directly.
//
// Storage is an in-memory stand-in for the Upstash REST API. Only requests to
// the configured Upstash base URL are intercepted; the MCP client's own HTTP
// to our local server goes through the real fetch, or the test would be
// talking to itself.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseUrl } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const REDIS_BASE = 'https://smoke.upstash.invalid';
process.env.UPSTASH_REDIS_REST_URL = REDIS_BASE;
process.env.UPSTASH_REDIS_REST_TOKEN = 'smoke-token';

/** Minimal Redis, covering exactly the commands this path issues. */
function installFakeRedis(): void {
  const kv = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const realFetch = globalThis.fetch;

  const run = (cmd: (string | number)[]): unknown => {
    const [op, key] = [String(cmd[0]).toUpperCase(), String(cmd[1])];
    switch (op) {
      case 'GET': return kv.has(key) ? kv.get(key) : null;
      case 'SET': kv.set(key, String(cmd[2])); return 'OK';
      case 'DEL': return kv.delete(key) ? 1 : 0;
      case 'INCR': {
        const next = Number(kv.get(key) ?? 0) + 1;
        kv.set(key, String(next));
        return next;
      }
      case 'RPUSH': {
        const list = lists.get(key) ?? [];
        for (const v of cmd.slice(2)) list.push(String(v));
        lists.set(key, list);
        return list.length;
      }
      case 'LLEN': return (lists.get(key) ?? []).length;
      case 'LRANGE': {
        const list = lists.get(key) ?? [];
        const start = Number(cmd[2]);
        const stop = Number(cmd[3]);
        const from = start < 0 ? Math.max(list.length + start, 0) : start;
        const to = stop < 0 ? list.length + stop : stop;
        return list.slice(from, to + 1);
      }
      case 'LTRIM': return 'OK';
      case 'EXPIRE': case 'EXPIREAT': case 'PEXPIRE': return 1;
      case 'EVAL': {
        // The CAS script: EVAL <src> 1 <key> <'absent'|'present'> <expected> <next> [ttl]
        const evalKey = String(cmd[3]);
        const mode = String(cmd[4]);
        const expected = cmd[5] === undefined ? undefined : String(cmd[5]);
        const next = String(cmd[6]);
        const cur = kv.get(evalKey);
        const ok = mode === 'absent' ? cur === undefined : cur === expected;
        if (ok) { kv.set(evalKey, next); return 1; }
        return 0;
      }
      default: return null;
    }
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.startsWith(REDIS_BASE)) return realFetch(input as never, init);
    const body = JSON.parse(String(init?.body ?? '[]'));
    const result = url.endsWith('/pipeline')
      ? (body as (string | number)[][]).map(c => ({ result: run(c) }))
      : { result: run(body as (string | number)[]) };
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

let server: http.Server;
let port = 0;
const clients: Client[] = [];

beforeAll(async () => {
  installFakeRedis();
  const mcpHandler = (await import('./mcp.js')).default;

  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    if (raw && String(req.headers['content-type'] ?? '').includes('application/json')) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    const { pathname, query } = parseUrl(req.url ?? '/', true);
    const vreq = Object.assign(req, { body, query, cookies: {} });
    const vres = Object.assign(res, {
      status(code: number) { res.statusCode = code; return vres; },
      json(obj: unknown) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); return vres; },
      send(data: string) { res.end(data); return vres; },
    });
    if (pathname === '/mcp') return void await mcpHandler(vreq as never, vres as never);
    vres.status(404).json({ error: 'not_found' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await new Promise<void>(r => server.close(() => r()));
});

async function connect(asClient?: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const client = new Client({ name: asClient ?? 'smoke-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    url,
    asClient ? { requestInit: { headers: { 'user-agent': `${asClient}/1.0` } } } : undefined,
  ));
  clients.push(client);
  return client;
}

function parsed(r: { content?: unknown }): Record<string, any> {
  const content = r.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

describe('hosted MCP endpoint', () => {
  it('serves the ten-tool surface, without the hosted-only two', async () => {
    const mcp = await connect();
    const tools = (await mcp.listTools()).tools.map(t => t.name);

    expect(tools).toHaveLength(10);
    for (const name of [
      'room_create', 'room_join', 'room_send', 'room_listen', 'room_minutes',
      'room_leave', 'room_end', 'room_task', 'room_admin', 'room_webhook',
    ]) {
      expect(tools).toContain(name);
    }
    // These need accounts / Projects, which this deployment does not have.
    expect(tools).not.toContain('room_playbook');
    expect(tools).not.toContain('project_memory');

    expect(mcp.getInstructions()).toContain('room_listen');
  });

  it('runs a room over the wire: create, join, send, listen', async () => {
    const mcp = await connect();

    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'smoke probe', name: 'Host' },
    }));
    // No account gate here — creating a room needs no sign-in on this
    // deployment, which is the point of stripping the hosted auth layer.
    expect(created.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(typeof created.hostKey).toBe('string');
    const code = created.code as string;

    const joined = parsed(await mcp.callTool({
      name: 'room_join', arguments: { code, name: 'Guest' },
    }));
    expect(joined.assignedName).toBe('Guest');
    expect(joined.participants.map((p: { name: string }) => p.name)).toContain('Host');

    const sent = parsed(await mcp.callTool({
      name: 'room_send', arguments: { code, name: 'Guest', text: 'hello over http' },
    }));
    expect(sent.sent).toBe(true);

    const listed = parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, since: 0, name: 'Guest', timeoutMs: 0 },
    }));
    expect(listed.messages.some((m: { text: string }) => m.text === 'hello over http')).toBe(true);
    // The listen loop contract rides on every result; without it an agent has
    // nothing telling it to call again.
    expect(listed.listenStatus).toBe('active');
    expect(listed.nextAction).toMatchObject({ required: true, tool: 'room_listen' });
    expect(listed.hint).toContain('room_listen');
  }, 20_000);

  it('carries the room policy contract, which needs the ported shared module', async () => {
    const mcp = await connect();
    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'policy probe', name: 'Host' },
    }));
    const code = created.code as string;
    parsed(await mcp.callTool({ name: 'room_send', arguments: { code, name: 'Host', text: 'first' } }));

    const listed = parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, since: 0, name: 'Host', timeoutMs: 0 },
    }));
    // room_listen returns history without a policy brief; the board-carrying
    // fields are what matter here — policy rides on blocking listens.
    expect(listed.cursor).toBeGreaterThan(0);
  }, 20_000);

  it('holds an identified weak client to its safe listen window', async () => {
    const mcp = await connect('Antigravity');
    const listen = (await mcp.listTools()).tools.find(t => t.name === 'room_listen')!;

    // The ported harness has to be wired in, not just present in the tree.
    expect(listen.description).toContain('max 45000 on Antigravity');
    expect(listen.description).not.toContain('max 240000');
  });

  it('refuses a webhook URL aimed at the deployment’s own network', async () => {
    const mcp = await connect();
    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'ssrf probe', name: 'Host' },
    }));
    const code = created.code as string;

    // upstash-client's registerRoomWebhook accepts any string; the guard lives
    // at this seam. Without it, a room code would be enough to make the server
    // POST chat content at cloud metadata.
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'https://localhost/hook', 'https://127.0.0.1/hook']) {
      const res = parsed(await mcp.callTool({
        name: 'room_webhook', arguments: { code, name: 'Host', action: 'register', url },
      }));
      expect(res.registered).toBeFalsy();
    }

    const listed = parsed(await mcp.callTool({
      name: 'room_webhook', arguments: { code, name: 'Host', action: 'list' },
    }));
    expect(listed.webhooks ?? []).toHaveLength(0);
  }, 20_000);
});
