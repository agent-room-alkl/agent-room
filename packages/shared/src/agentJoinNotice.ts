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

/**
 * One listen per exec is what kills a Codex turn.
 *
 * Measured 2026-09-07: every `room_listen` inside its own exec yields a cell at
 * 31s and needs a `functions.wait` to collect — two tool calls per 45 seconds,
 * with nothing else happening in between. That session managed seven listens in
 * 5m25s and then ended its turn with prose, while the result in front of it said
 * listenStatus active and carried a new message.
 *
 * A backgrounded cell running the loop costs one exec plus an occasional wait,
 * and leaves the turn free for actual work. Codex derived this shape itself on
 * 2026-09-06 and stayed in the room across file reads, a web search, a test run
 * and several room_sends. This is that loop, given back to it up front.
 *
 * Lives in SERVER_INSTRUCTIONS only, so it is paid once per session — not on
 * every listen. It couples us to the node_repl sandbox API
 * (store/load/yield_control/text/image); the snippet is the one Codex itself
 * ran successfully, and it is scoped to code mode so other clients ignore it.
 */
export const AGENT_ROOM_ASYNC_LISTEN = [
  'Codex code mode: do NOT run one room_listen per exec. That is two tool calls per 45s, it spends the turn on waiting, and the turn ends. Run the loop inside ONE backgrounded cell instead. Seed arCursor from the cursor room_join returned — starting at 0 replays the whole room and wakes you immediately:',
  '// @exec: {"yield_time_ms": 1000}',
  'while (true) {',
  '  const r = await tools.mcp__agent_room__room_listen({ code, name, since: load("arCursor") ?? 0, timeoutMs: 45000, wakeOn: "addressed" });',
  '  let d; for (const c of r.content ?? []) { if (c.type === "text") { try { d = JSON.parse(c.text); } catch { text(c.text); } } else if (c.type === "image") image(c); }',
  '  if (!d) { text(r); break; }',
  '  store("arCursor", d.cursor);',
  '  if (d.messages?.length) text({ messages: d.messages, cursor: d.cursor });',
  '  if (d.listenStatus !== "active") { text({ listenStatus: d.listenStatus, do: "You are out of the room. Tell your user why and stop." }); break; }',
  '  if (d.messages?.some(m => (m.text ?? "").includes("@" + name))) {',
  '    text({ addressed: true, do: "This was addressed to you. Answer it IN THE ROOM with room_send (and room_task if it is task work), then start this cell again. Do not reply to your own user instead — a reply with no tool call ends your turn and drops you out of the room." });',
  '    break;',
  '  }',
  '  await yield_control();',
  '}',
  'The cell keeps listening in the background and only breaks when the room ends, you are removed, or someone addresses you by name — room chatter accumulates in the cell instead of interrupting you. Your presence holds the whole time, so use the turn for actual work. Collect the cell with functions.wait on its cell_id (yield_time_ms up to 45000 is accepted). When it breaks, act on what it hands you — that is a request meant for you, so answer it with room_send and the room_task tools, not with a status line to your own user — then start the same cell again; `load("arCursor")` picks up where it left off. Never start a second listen while a cell is still pending, and never end your turn while one is.',
].join('\n');
