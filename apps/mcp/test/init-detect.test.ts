import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInstallTargets, readJson, vscodeMcpPathFor } from '../src/init.js';

function detector(paths: string[], bins: string[] = []) {
  const pathSet = new Set(paths);
  const binSet = new Set(bins);
  return detectInstallTargets({
    home: '/home/agent',
    platform: 'linux',
    env: {},
    whichCmd: async (cmd) => (binSet.has(cmd) ? `/usr/bin/${cmd}` : null),
    pathExistsFn: async (path) => pathSet.has(path),
  });
}

describe('detectInstallTargets', () => {
  it('detects all installed clients without requiring a manual target choice', async () => {
    await expect(detector([
      '/home/agent/.claude',
      '/home/agent/.codex',
      '/home/agent/.cursor',
      '/home/agent/.gemini/config',
    ])).resolves.toEqual(['claude', 'codex', 'cursor', 'antigravity']);
  });

  it('detects clients from binaries and harness environment signals', async () => {
    await expect(detectInstallTargets({
      home: '/home/agent',
      platform: 'linux',
      env: {
        CODEX_RUN_ID: 'run_123',
        CURSOR_TRACE_ID: 'trace_123',
      },
      whichCmd: async (cmd) => (cmd === 'claude' ? '/usr/bin/claude' : null),
      pathExistsFn: async () => false,
    })).resolves.toEqual(['claude', 'codex', 'cursor']);
  });

  it('returns an empty list when no supported client is detected', async () => {
    await expect(detector([])).resolves.toEqual([]);
  });

  it('detects VS Code from the code CLI or app directory', async () => {
    await expect(detectInstallTargets({
      home: '/home/agent',
      platform: 'linux',
      env: {},
      whichCmd: async (cmd) => (cmd === 'code' ? '/usr/bin/code' : null),
      pathExistsFn: async () => false,
    })).resolves.toEqual(['vscode']);

    await expect(detector(['/home/agent/.config/Code'])).resolves.toEqual(['vscode']);
  });
});

describe('vscodeMcpPathFor', () => {
  it('uses the user-level mcp.json path on each platform', () => {
    expect(vscodeMcpPathFor('/Users/agent', 'darwin')).toBe(
      '/Users/agent/Library/Application Support/Code/User/mcp.json',
    );
    expect(vscodeMcpPathFor('/home/agent', 'linux')).toBe('/home/agent/.config/Code/User/mcp.json');
    expect(vscodeMcpPathFor('/Users/agent', 'win32', 'C:\\Users\\agent\\AppData\\Roaming')).toBe(
      'C:\\Users\\agent\\AppData\\Roaming/Code/User/mcp.json',
    );
  });
});

describe('readJson', () => {
  it('treats empty files created by clients as missing config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-room-init-'));
    const path = join(dir, 'mcp_config.json');
    await writeFile(path, '', 'utf8');

    await expect(readJson(path)).resolves.toBeNull();
  });

  it('treats whitespace-only files as missing config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-room-init-'));
    const path = join(dir, 'mcp_config.json');
    await writeFile(path, '  \n\t', 'utf8');

    await expect(readJson(path)).resolves.toBeNull();
  });
});
