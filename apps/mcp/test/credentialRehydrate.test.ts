import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoomApiClient } from '../src/roomApi.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENT_ROOM_STATE_FILE;
  delete process.env.AGENT_ROOM_STATE_DIR;
  delete process.env.CODEX_RUN_ID;
});

function captureFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    return new Response(JSON.stringify({ result: { cursor: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

function harnessFile(dir: string, sessionId: string) {
  const scope = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return join(dir, `state-harness-codex-${scope}.json`);
}

describe('room credential rehydration after restart', () => {
  it('a fresh client sends the persisted capabilities on its first authenticated call', async () => {
    const calls = captureFetch();
    const client = createRoomApiClient({
      loadCredentials: async (code) => (code === 'ABC-DEF-GHJ' ? { accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) } : undefined),
    });
    await client.post({ action: 'send', code: 'ABC-DEF-GHJ', message: { text: 'hi' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-agent-room-access']).toBe('a'.repeat(43));
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${'p'.repeat(43)}`);
    client.setCredentials('ABC-DEF-GHJ', { accessToken: 'b'.repeat(43) });
    await client.post({ action: 'messages', code: 'ABC-DEF-GHJ', cursor: 0 });
    expect(calls[1]!.headers['x-agent-room-access']).toBe('b'.repeat(43));
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${'p'.repeat(43)}`);
  });

  it('the state-file loader returns the capabilities an earlier join persisted', async () => {
    // STATE_FILE is bound when the state module loads, so point the env at a
    // temp file and load the loader fresh.
    const dir = mkdtempSync(join(tmpdir(), 'agent-room-cred-'));
    process.env.AGENT_ROOM_STATE_FILE = join(dir, 'state.json');
    vi.resetModules();
    const { toolCredentialLoader: stateCredentialLoader } = await import('../src/credentials.js');
    await writeFile(process.env.AGENT_ROOM_STATE_FILE, JSON.stringify({
      version: 1,
      rooms: { 'ABC-DEF-GHJ': { code: 'ABC-DEF-GHJ', name: 'Me', role: 'Dev', cursor: 0, joinedAt: 1, accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) } },
    }));
    expect(await stateCredentialLoader('ABC-DEF-GHJ')).toEqual({ accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) });
    expect(await stateCredentialLoader('NOP-QRS-TUV')).toBeUndefined();
  });

  it('does not recover a room from a foreign scoped state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-room-cred-merged-'));
    delete process.env.AGENT_ROOM_STATE_FILE;
    process.env.AGENT_ROOM_STATE_DIR = dir;
    process.env.CODEX_RUN_ID = 'test-run';
    await writeFile(harnessFile(dir, 'test-run'), JSON.stringify({
      version: 1, rooms: { 'HAR-NES-SON': { name: 'Other', cursor: 0, joinedAt: 2, accessToken: 'h'.repeat(43) } },
    }));
    await writeFile(join(dir, 'state-111.json'), JSON.stringify({
      version: 1, rooms: { 'SCO-PED-ONE': { name: 'Me', cursor: 0, joinedAt: 3, accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) } },
    }));
    vi.resetModules();
    const { toolCredentialLoader } = await import('../src/credentials.js');
    expect(await toolCredentialLoader('SCO-PED-ONE')).toBeUndefined();
  });

  it('keeps the current participant token when a newer foreign participant shares the room', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-room-cred-identity-'));
    delete process.env.AGENT_ROOM_STATE_FILE;
    process.env.AGENT_ROOM_STATE_DIR = dir;
    process.env.CODEX_RUN_ID = 'test-run';
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    const code = 'SHR-RUM-ONE';
    await writeFile(join(dir, `state-${process.ppid}.json`), JSON.stringify({
      version: 1, rooms: { [code]: { name: 'Session A', client: 'cc', cursor: 0, joinedAt: 1, accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) } },
    }));
    await writeFile(join(dir, 'state-999999.json'), JSON.stringify({
      version: 1, rooms: { [code]: { name: 'Session B', client: 'cc', cursor: 0, joinedAt: 99, accessToken: 'b'.repeat(43), participantToken: 'q'.repeat(43) } },
    }));
    vi.resetModules();
    const calls = captureFetch();
    const { toolCredentialLoader } = await import('../src/credentials.js');
    const client = createRoomApiClient({ loadCredentials: toolCredentialLoader });
    await client.post({ action: 'send', code, message: { text: 'from A' } });
    expect(calls[0]!.headers['x-agent-room-access']).toBe('a'.repeat(43));
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${'p'.repeat(43)}`);
  });

  it('returns no credentials when only a foreign participant has capabilities', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-room-cred-foreign-'));
    delete process.env.AGENT_ROOM_STATE_FILE;
    process.env.AGENT_ROOM_STATE_DIR = dir;
    process.env.CODEX_RUN_ID = 'test-run';
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    const code = 'SHR-RUM-TWO';
    await writeFile(join(dir, `state-${process.ppid}.json`), JSON.stringify({
      version: 1, rooms: { [code]: { name: 'Session A', client: 'cc', cursor: 0, joinedAt: 1 } },
    }));
    await writeFile(join(dir, 'state-999998.json'), JSON.stringify({
      version: 1, rooms: { [code]: { name: 'Session B', client: 'cc', cursor: 0, joinedAt: 99, accessToken: 'b'.repeat(43), participantToken: 'q'.repeat(43) } },
    }));
    vi.resetModules();
    const { toolCredentialLoader } = await import('../src/credentials.js');
    expect(await toolCredentialLoader(code)).toBeUndefined();
  });
});
