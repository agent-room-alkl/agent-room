#!/usr/bin/env node
// Build the Claude Desktop one-click extension (.mcpb) for agent-room.
//
// MCPB bundles are zip files with a manifest.json and a self-contained
// server; Claude Desktop installs them with a double click — the path for
// users who will never open a terminal. This script stages:
//
//   dist-mcpb/staging/
//     manifest.json          (generated below, version synced to package.json)
//     server/index.js        (the tsup build output)
//     node_modules/          (production deps only)
//     package.json           (minimal, so `npm install` resolves deps)
//
// then runs `mcpb pack` to produce dist-mcpb/agent-room.mcpb.
//
// Usage: node scripts/build-mcpb.mjs   (from apps/mcp; runs the tsup build first)

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const out = join(pkgRoot, 'dist-mcpb');
const staging = join(out, 'staging');

const run = (cmd, cwd = pkgRoot) => execSync(cmd, { cwd, stdio: 'inherit' });

console.log('[mcpb] building server bundle (tsup)…');
run('npm run build');
if (!existsSync(join(pkgRoot, 'dist', 'index.js'))) {
  throw new Error('tsup build produced no dist/index.js');
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(staging, 'server'), { recursive: true });
cpSync(join(pkgRoot, 'dist'), join(staging, 'server'), { recursive: true });

// Minimal runtime package.json: production deps only, resolved into the
// bundle's own node_modules so the extension works on machines without npm.
writeFileSync(
  join(staging, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      type: 'module',
      private: true,
      dependencies: pkg.dependencies,
    },
    null,
    2,
  ),
);
console.log('[mcpb] installing production deps into staging…');
run('npm install --omit=dev --no-audit --no-fund --ignore-scripts', staging);

const manifest = {
  manifest_version: '0.2',
  name: 'agent-room',
  display_name: 'Agent Room',
  version: pkg.version,
  description: 'Multi-agent meeting rooms — put Claude, Cursor, Codex, and friends in one room and ship together.',
  long_description:
    'Create a meeting room, share the 9-character code, and any MCP-capable agent (or a human in the browser at agent-room.com) can join, chat, and coordinate work in real time.',
  author: { name: 'Agent Room', url: 'https://www.agent-room.com' },
  homepage: 'https://www.agent-room.com',
  documentation: 'https://github.com/noogalabs/agent-room/blob/main/INSTALL.md',
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.js'],
    },
  },
  user_config: {
    profile: {
      type: 'string',
      title: 'Tool profile',
      description: 'Set to "core" for the lean 9-tool surface; leave empty for all tools.',
      required: false,
    },
  },
  compatibility: {
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: { node: '>=18.0.0' },
  },
};
// Map the optional user_config entry onto the server env.
manifest.server.mcp_config.env = { AGENT_ROOM_PROFILE: '${user_config.profile}' };
writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('[mcpb] packing…');
run(`npx --yes @anthropic-ai/mcpb pack "${staging}" "${join(out, 'agent-room.mcpb')}"`);
console.log(`[mcpb] done → ${join(out, 'agent-room.mcpb')}`);
