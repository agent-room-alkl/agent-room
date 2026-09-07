// SERVER_INSTRUCTIONS cannot steer a client that lazy-loads MCP tools: the text
// first reaches the model inside a tool result, after it has already picked
// between the browser and room_join. These lines are the fallback for that case,
// so they have to stand alone.

import { describe, it, expect } from 'vitest';
import { buildJoinPageAgentNotice, AGENT_ROOM_MCP_URL, AGENT_ROOM_ASYNC_LISTEN } from './agentJoinNotice.js';

describe('AGENT_ROOM_ASYNC_LISTEN', () => {
  // One listen per exec is two tool calls per 45s and it ends the turn in
  // minutes. The loop has to arrive as runnable code, not as advice.
  it('hands Codex a runnable backgrounded listen loop', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('// @exec: {"yield_time_ms": 1000}');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('while (true) {');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('tools.mcp__agent_room__room_listen(');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('await yield_control();');
  });

  it('carries the cursor across cells so a restart resumes', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('store("arCursor", d.cursor)');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('load("arCursor")');
  });

  // Breaking on ANY message is the same failure in a new shape: in a room with
  // other active participants it woke the model six times in 2m27s, and the
  // sixth wake answered in prose and ended the turn. Wake on being addressed;
  // the server holds the rest and hands them over in one batch.
  it('wakes on being addressed, not on room traffic', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('wakeOn: "addressed"');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('d.messages?.some(m => (m.text ?? "").includes("@" + name))');
    expect(AGENT_ROOM_ASYNC_LISTEN).not.toContain('|| d.messages?.length) break');
  });

  it('still breaks when the room ends or removes the agent', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('if (d.listenStatus !== "active")');
  });

  // since: 0 replays the whole room and breaks the loop on the first poll.
  it('says to seed the cursor from room_join', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Seed arCursor from the cursor room_join returned');
  });

  // The prose is read once at session start; by the time the loop breaks it is
  // minutes and dozens of tool calls back. The break used to hand over a bare
  // { messages, cursor } — the request, with nothing saying what to do with it.
  it('carries the imperative in the break, next to the request that caused it', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('addressed: true');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Answer it IN THE ROOM with room_send');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Do not reply to your own user instead');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('You are out of the room. Tell your user why and stop.');
  });

  it('names the anti-pattern it is replacing', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('do NOT run one room_listen per exec');
  });
});

const CODE = 'ABC-DEF-GHJ';
const text = (code?: string) => buildJoinPageAgentNotice(code).join('\n');

describe('buildJoinPageAgentNotice', () => {
  it('tells the agent not to use the page it is looking at', () => {
    const t = text(CODE);
    // Shown on /r/CODE too, where there is no form — so it cannot presuppose one.
    expect(t).toContain('this page is for humans');
    expect(t).toContain('do not join as a web participant');
    expect(t).toContain('Do not fall back to this page');
  });

  it('carries a callable room_join, not a description of one', () => {
    const t = text(CODE);
    expect(t).toContain(AGENT_ROOM_MCP_URL);
    expect(t).toContain(`room_join({ code: "${CODE}", name: "<your agent name>" })`);
    // The observed failure was the agent stopping to ask for a display name.
    expect(t).toContain('do not ask the user for one');
  });

  it('explains that a missing tool is a deferred tool', () => {
    const t = text(CODE);
    expect(t).toContain('deferred, not missing');
    expect(t).toContain('agent_room');
    expect(t).toContain('ALL_TOOLS');
  });

  it('covers staying in the room, not just getting in', () => {
    const t = text(CODE);
    expect(t).toContain('room_listen');
    expect(t).toContain('quiet timeout is not a stop condition');
    expect(t).toContain('reply with no tool call ends your turn');
  });

  it('still names the tool when the code is not known yet', () => {
    const t = text();
    expect(t).toContain('room_join({ code, name: "<your agent name>" })');
    expect(t).not.toContain('undefined');
  });
});
