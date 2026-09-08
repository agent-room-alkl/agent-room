// SERVER_INSTRUCTIONS and the tool descriptions are the most-read text this
// server produces and the least-reviewed: nobody diffs a 5k string.
//
// They are also not free. Codex code mode does not put a server's `instructions`
// in the model's context — its host prepends the whole string to EVERY entry of
// the sandbox's ALL_TOOLS array. With ten tools, a 5,947-character
// SERVER_INSTRUCTIONS made the catalogue 63k, which is where a plain
// `ALL_TOOLS.filter(x => /agent_room/.test(x.name))` starts getting truncated —
// and a truncated catalogue sends the model back to exact-name lookups that
// return a name and no schema, so it never reads any tool's arguments.
//
// Moving the per-tool paragraphs onto their tools took it to 24k. These tests
// keep it there, and keep the two failure modes that are invisible in review:
// text that repeats itself, and text that outlives what it describes.

import { describe, it, expect } from 'vitest';
import { listTools, SERVER_INSTRUCTIONS } from './_mcpTools.js';

const TOOLS = listTools('full');
const desc = (name: string): string => {
  const tool = TOOLS.find(t => t.name === name);
  expect(tool, `${name} is not on the full surface`).toBeDefined();
  return tool!.description;
};

describe('SERVER_INSTRUCTIONS carries only what is unknowable without a tool', () => {
  it('stays small enough to survive the ALL_TOOLS multiplier', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2_500);
    const catalogue = SERVER_INSTRUCTIONS.length * TOOLS.length
      + TOOLS.reduce((a, t) => a + t.description.length, 0);
    expect(catalogue).toBeLessThan(30_000);
  });

  // The one decision made before any tool description is in hand: a client that
  // lazy-loads MCP tools sees an always-present browser tool and nothing named
  // agent_room, so it opens the join page instead of calling room_join.
  it('keeps the entry decision, which no tool description can reach in time', () => {
    expect(SERVER_INSTRUCTIONS).toContain('call MCP room_join');
    expect(SERVER_INSTRUCTIONS).toContain('not a browser');
    expect(SERVER_INSTRUCTIONS).toContain('deferred in your catalog');
  });

  // Each of these is about exactly one tool, so it belongs on that tool, where
  // it is read once by the agent about to use it instead of ten times by
  // everyone. Asserting the new home is the point: asserting the old one is how
  // a trimmed string grows back.
  it('leaves per-tool mechanics on their tools', () => {
    for (const moved of ['functions.wait', 'garbled_text', '[DECISION]', 'stuck tool loop']) {
      expect(SERVER_INSTRUCTIONS, `${moved} belongs on a tool`).not.toContain(moved);
    }
    expect(desc('room_listen')).toContain('functions.wait');
    expect(desc('room_listen')).toContain('stuck tool loop');
    expect(desc('room_send')).toContain('garbled_text');
    expect(desc('room_send')).toContain('[DECISION]');
  });

  it('still says the things no tool owns', () => {
    // Sender names are not authenticated, and the transcript gets exported.
    expect(SERVER_INSTRUCTIONS).toContain('not authenticated');
    expect(SERVER_INSTRUCTIONS).toContain('SECRETS:');
    expect(SERVER_INSTRUCTIONS).toContain('seatKey/hostKey');
  });

  it('names only tools that exist', () => {
    const surface = TOOLS.map(t => t.name);
    for (const m of SERVER_INSTRUCTIONS.matchAll(/\broom_[a-z_]+\b/g)) {
      expect(surface, `SERVER_INSTRUCTIONS names ${m[0]}`).toContain(m[0]);
    }
  });
});

describe('no description repeats itself', () => {
  // room_listen composes AGENT_ROOM_ASYNC_LISTEN, which opens with the Codex
  // continuation rule; naming that rule separately as well would put 800
  // characters into one description twice.
  it('room_listen carries the Codex continuation rule exactly once', () => {
    expect(desc('room_listen').split('CODEX NEXT ACTION')).toHaveLength(2);
  });

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
