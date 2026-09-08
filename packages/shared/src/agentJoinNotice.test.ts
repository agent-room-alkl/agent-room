// SERVER_INSTRUCTIONS cannot steer a client that lazy-loads MCP tools: the text
// first reaches the model inside a tool result, after it has already picked
// between the browser and room_join. These lines are the fallback for that case,
// so they have to stand alone.

import { describe, it, expect } from 'vitest';
import {
  buildJoinPageAgentNotice,
  AGENT_ROOM_MCP_URL,
  AGENT_ROOM_ASYNC_LISTEN,
  AGENT_ROOM_CODEX_CONTINUE,
} from './agentJoinNotice.js';

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

  // Breaking on ANY message is the same failure in a new shape: with other
  // participants active it woke the model six times in 2m27s, and the sixth
  // wake answered in prose and ended the turn. Wake on being addressed; the
  // server holds the rest and hands them back in one batch.
  it('wakes on being addressed, not on room traffic', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('wakeOn: "addressed"');
    expect(AGENT_ROOM_ASYNC_LISTEN).not.toContain('|| d.messages?.length) break');
  });

  // A client-side text match is narrower than the server's wakesAgent, which
  // also matches metadata.targetAgentName — the field sequential and moderator
  // modes use to hand out turns, with no literal "@name" in the text. Deciding
  // this client-side meant an agent never woke for its own turn.
  it('takes "addressed" from the server, not from a text match', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('if (d.addressedYou)');
    expect(AGENT_ROOM_ASYNC_LISTEN).not.toContain('includes("@" + name)');
  });

  // Room policy allows three reasons to speak: mentioned, assigned, or clearly
  // adding value. Breaking only on a mention removed the third.
  it('also wakes for the batch that arrived unaddressed', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Nobody addressed you');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('only if you can clearly add something');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Saying nothing is a fine answer');
  });

  it('still breaks when the room ends or removes the agent', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('if (d.listenStatus !== "active")');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('You are out of the room. Tell your user why and stop.');
  });

  // since: 0 replays the whole room and breaks the loop on the first poll.
  it('says to seed the cursor from room_join', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Seed arCursor from the cursor room_join returned');
  });

  // A task was created, claimed, announced — and then nothing, because the
  // imperative next to the request said "answer, then start this cell again"
  // and never "do the work". Backgrounding the cell exists to free the turn for
  // work; the break has to say so, or listening becomes the whole job.
  it('sends the agent to do the work, not back to the poll', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('DO THE WORK NOW');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('room_task create + claim');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('nobody has to assign it to you');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('restarting it is not a substitute for doing the work');
    // Silence was the reply to the one request it could not do.
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('I cannot do that because');
  });

  it('carries the pending-cell rule up front', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain(AGENT_ROOM_CODEX_CONTINUE);
  });

  // The loop parsed the whole listen result and handed over four hand-picked
  // fields, so `hint` — carrying the work-first rule and the turn mechanics —
  // was read and thrown away on every wake. A client calling room_listen
  // directly gets all of it; ours got about a tenth.
  it('hands over the whole listen result, not a chosen subset', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN.split('text({ ...d,')).toHaveLength(4);
    expect(AGENT_ROOM_ASYNC_LISTEN).not.toContain('text({ messages: d.messages');
    expect(AGENT_ROOM_ASYNC_LISTEN).not.toContain('text({ listenStatus: d.listenStatus,');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Read the hint and nextAction fields');
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

  // This page decides one thing — MCP or the form. Every mechanic of the loop
  // is read later off room_listen's description, by an agent that has already
  // decided; spelling them out here buries the lines that do the deciding.
  it('sends the listen mechanics to room_listen instead of restating them', () => {
    const t = text(CODE);
    expect(t).not.toContain(AGENT_ROOM_ASYNC_LISTEN);
    expect(t).not.toContain('Never start a second listen');
    expect(t).toContain('follow its tool description');
    expect(buildJoinPageAgentNotice(CODE)).toHaveLength(6);
  });

  // The one exception: an agent can start a cell and end its turn on the very
  // first exec, before room_listen's description has ever been read.
  it('keeps the one Codex rule that fires before any description is read', () => {
    const t = text(CODE);
    expect(t).toContain('Script running with cell ID');
    expect(t).toContain('functions.wait');
    expect(t).toContain('never a final answer');
  });

  // The narrow filter excluded room_task, which is how an agent ends up in a
  // room it cannot record work in.
  it('does not filter the tool catalog down to join and listen', () => {
    expect(text(CODE)).toContain('/mcp__agent_room__room_/');
  });

  it('still names the tool when the code is not known yet', () => {
    const t = text();
    expect(t).toContain('room_join({ code, name: "<your agent name>" })');
    expect(t).not.toContain('undefined');
  });
});
