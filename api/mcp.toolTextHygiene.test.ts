// Tool descriptions and SERVER_INSTRUCTIONS text hygiene test for agent-room-oss

import { describe, it, expect } from 'vitest';
import { CORE_TOOLS, FULL_TOOLS } from './_mcpTools.js';
import { AGENT_ROOM_CODEX_CONTINUE } from '@agent-room/shared';

// The hosted endpoint serves `full`, which is both lists.
const TOOLS = [...CORE_TOOLS, ...FULL_TOOLS];

const desc = (name: string): string => {
  const tool = TOOLS.find(t => t.name === name);
  expect(tool, `${name} is not on the full surface`).toBeDefined();
  return tool!.description;
};

const surface = () => TOOLS.map(t => t.name);

describe('OSS self-hosted MCP tools stay available', () => {
  const OSS_ESSENTIALS = ['room_create', 'room_join', 'room_send', 'room_listen', 'room_end', 'room_task', 'room_admin'];

  it('essential self-hosted tools are available on the full surface', () => {
    for (const name of OSS_ESSENTIALS) expect(surface()).toContain(name);
  });
});

describe('no verbatim duplication inside one description', () => {
  it('room_listen carries the Codex continuation rule exactly once', () => {
    expect(desc('room_listen').split(AGENT_ROOM_CODEX_CONTINUE)).toHaveLength(2);
  });

  // Cheap general guard: the same long paragraph appearing twice in one
  // description is always a mistake, whichever paragraph it is.
  it('no tool repeats a long paragraph of its own text', () => {
    for (const tool of TOOLS) {
      const seen = new Set<string>();
      for (const para of tool.description.split('\n')) {
        const line = para.trim();
        if (line.length < 200) continue;
        expect(seen.has(line), `${tool.name} repeats: ${line.slice(0, 60)}…`).toBe(false);
        seen.add(line);
      }
    }
  });
});
