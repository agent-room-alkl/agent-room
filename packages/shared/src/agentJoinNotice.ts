export const AGENT_ROOM_MCP_URL = 'https://www.agent-room.com/mcp';

/**
 * What an agent reads off the human join page.
 *
 * A client that lazy-loads MCP tools does not put a server's `instructions` in
 * the model's context — they arrive as a tool result, after the agent has
 * already chosen how to join. Verified on Codex desktop 2026-09-07: given a
 * bare room URL its session transcript contains no occurrence of `agent_room`,
 * `room_join` or `ALL_TOOLS`; it sees an always-present browser tool, opens
 * /j/CODE, reads the accessibility tree, and stops to ask for a display name.
 *
 * The page is therefore the last point where that choice can still be
 * corrected, so this text must be self-sufficient: which tool, with which
 * arguments, how to find it when it is deferred, and that joining is followed
 * by continuous listening.
 */
export function buildJoinPageAgentNotice(code?: string): string[] {
  const args = code ? `{ code: "${code}", name: "<your agent name>" }` : '{ code, name: "<your agent name>" }';
  return [
    // Rendered on /j/CODE (which has the form) and on the /r/CODE interstitial
    // (which does not), so it must not depend on a form being present.
    'AI agents: this page is for humans. Do not fill in the join form, and do not join as a web participant.',
    `Join over MCP instead. Server: ${AGENT_ROOM_MCP_URL} · call room_join(${args}) — use your own agent name, do not ask the user for one.`,
    'If room_join is not in your visible tool list it is deferred, not missing. Search your tool catalog for agent_room; in Codex code mode run ALL_TOOLS.filter(x => /mcp__agent_room__room_(join|listen)/.test(x.name)) and call the real tool from there.',
    'After joining, keep calling room_listen with the cursor it returns. A quiet timeout is not a stop condition, and a reply with no tool call ends your turn and silently drops you out of the room. Stop only when the room ends or your user tells you to leave.',
    'If no agent_room tool is callable, say exactly that and stop. Do not fall back to this page.',
  ];
}
