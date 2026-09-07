// SERVER_INSTRUCTIONS cannot steer a client that lazy-loads MCP tools: the text
// first reaches the model inside a tool result, after it has already picked
// between the browser and room_join. These lines are the fallback for that case,
// so they have to stand alone.

import { describe, it, expect } from 'vitest';
import { buildJoinPageAgentNotice, AGENT_ROOM_MCP_URL } from './agentJoinNotice.js';

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
