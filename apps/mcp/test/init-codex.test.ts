import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCodex } from '../src/init.js';

// installCodex writes ~/.codex/config.toml, resolved from CODEX_HOME. Point it
// at a temp dir so the test never touches the real user config.
let codexHome: string;
const prevCodexHome = process.env.CODEX_HOME;

beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), 'agent-room-codex-'));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
});

const configPath = () => join(codexHome, 'config.toml');

describe('installCodex — hooks', () => {
  it('enables the codex_hooks feature flag alongside the hook blocks', async () => {
    await installCodex({ hooks: true });
    const toml = await readFile(configPath(), 'utf8');

    // Codex ignores [[hooks.*]] unless the feature is enabled.
    expect(toml).toContain('[features]');
    expect(toml).toMatch(/^codex_hooks = true$/m);

    // All three autonomous-chat hooks are present.
    expect(toml).toContain('[[hooks.Stop]]');
    expect(toml).toContain('[[hooks.UserPromptSubmit]]');
    expect(toml).toContain('[[hooks.SessionStart]]');
    expect(toml).toContain('command = "npx -y agent-room-mcp hook"');
  });

  it('is idempotent — re-running does not duplicate the feature flag or hooks', async () => {
    await installCodex({ hooks: true });
    const first = await readFile(configPath(), 'utf8');
    const second = await installCodex({ hooks: true });
    const after = await readFile(configPath(), 'utf8');

    expect(after).toBe(first);
    expect(second.changes).toHaveLength(0);
    expect((after.match(/codex_hooks = true/g) ?? []).length).toBe(1);
    expect((after.match(/\[\[hooks\.Stop\]\]/g) ?? []).length).toBe(1);
  });

  it('inserts codex_hooks into a pre-existing [features] table instead of duplicating it', async () => {
    await writeFile(configPath(), '[features]\nweb_search = true\n', 'utf8');
    await installCodex({ hooks: true });
    const toml = await readFile(configPath(), 'utf8');

    expect((toml.match(/\[features\]/g) ?? []).length).toBe(1);
    expect(toml).toContain('web_search = true');
    expect(toml).toMatch(/^codex_hooks = true$/m);
  });

  it('does not write hooks or the feature flag when hooks are disabled', async () => {
    await installCodex({ hooks: false });
    const toml = await readFile(configPath(), 'utf8');

    expect(toml).toContain('[mcp_servers.agent-room]');
    expect(toml).not.toContain('codex_hooks');
    expect(toml).not.toContain('[[hooks.Stop]]');
  });
});
