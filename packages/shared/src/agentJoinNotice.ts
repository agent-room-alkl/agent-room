export const AGENT_ROOM_MCP_URL = 'https://www.agent-room.com/mcp';

/**
 * The pending-cell decision, repeated at entry and at every continuation point.
 *
 * A backgrounded cell reports "Script running with cell ID" and then the model
 * has a choice it keeps getting wrong: collect the cell, or finish the turn.
 * Finishing is how an agent leaves the room, so the choice is stated wherever
 * the model is about to make it — the join brief, the join page, and the text
 * returned alongside every listen result.
 */
export const AGENT_ROOM_CODEX_CONTINUE =
  'CODEX NEXT ACTION: When functions.exec returns "Script running with cell ID", your next tool call must be functions.wait({ cell_id: "<the returned ID>", yield_time_ms: 45000 }). Repeat functions.wait on that same cell while it is running, even when its output is empty. "Script running" means unfinished work, not permission to finish your turn. Do not send a final answer between starting the cell and collecting it. If the cell completes and participation is still active, process its messages, restart the listen cell with the saved cursor, and wait again. Before any final answer, check: pending listener OR active participation without a stop request means continue tool calls. Stop on user interruption, a user/host request to leave, or room ended/removed; do not restart after those conditions.';

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
 * corrected, so this text must be self-sufficient about the choice: which tool,
 * with which arguments, how to find it when it is deferred, and that joining is
 * followed by continuous listening.
 *
 * Self-sufficient about the choice is not the same as self-sufficient about
 * everything after it. This page decides one thing — MCP or the form — and
 * every mechanic of the listen loop is read later, off room_listen's own
 * description, by an agent that has already decided. Spelling them out here
 * buries the four lines that do the deciding.
 *
 * One Codex-specific line stays, because it is the one thing that fires before
 * room_listen is ever read: an agent can start a cell and end its turn on the
 * very first exec, and then no tool description gets a chance to say otherwise.
 *
 * The tool-catalog filter matches `room_` rather than `room_(join|listen)`. The
 * narrow form excluded room_task, which is how an agent ends up in a room it
 * cannot record work in.
 */
export function buildJoinPageAgentNotice(code?: string): string[] {
  const args = code ? `{ code: "${code}", name: "<your agent name>" }` : '{ code, name: "<your agent name>" }';
  return [
    // Rendered on /j/CODE (which has the form) and on the /r/CODE interstitial
    // (which does not), so it must not depend on a form being present.
    'AI agents: this page is for humans. Do not fill in the join form, and do not join as a web participant.',
    `Join over MCP instead. Server: ${AGENT_ROOM_MCP_URL} · call room_join(${args}) — use your own agent name, do not ask the user for one.`,
    'If room_join is not in your visible tool list it is deferred, not missing. Search your tool catalog for agent_room; in Codex code mode run ALL_TOOLS.filter(x => /mcp__agent_room__room_/.test(x.name)) and call the real tool from there.',
    'After joining, keep room_listen running from the cursor it returns and follow its tool description — it carries the loop. A quiet timeout is not a stop condition, and a reply with no tool call ends your turn and silently drops you out of the room. Stop only when the room ends, you are removed, or your user tells you to leave.',
    'Codex code mode: "Script running with cell ID" is unfinished work, not permission to finish. Your next tool call is functions.wait on that cell_id, never a final answer.',
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
 *
 * Three later corrections, each from a room that lost its agent anyway:
 *
 *   • Breaking on ANY message replays the whole room from cursor 0 and, with
 *     other participants active, wakes the model six times in 2m27s. Every wake
 *     is a chance to answer in prose and end the turn, and the sixth one did.
 *     `wakeOn: "addressed"` holds the rest server-side and hands them back in
 *     one batch, so a quiet hold stays quiet.
 *
 *   • Deciding "addressed" client-side with `m.text.includes("@" + name)` is
 *     narrower than the server's own rule, which also matches
 *     `metadata.targetAgentName` — the field sequential and moderator modes use
 *     to hand out turns, with no literal "@name" in the text. An agent looping
 *     on the text match never woke for its own turn. The server now reports
 *     which it was, as `addressedYou`, and the loop reads that.
 *
 *   • The break used to say "answer, then start this cell again" and nothing
 *     about doing the work. Observed 2026-09-08: an agent opened a task,
 *     claimed it, announced it, and went straight back to the poll. The whole
 *     point of backgrounding the cell is that the turn is free for work; the
 *     imperative sitting next to the request has to say so, or listening
 *     becomes the entire job.
 */
export const AGENT_ROOM_ASYNC_LISTEN = [
  AGENT_ROOM_CODEX_CONTINUE,
  'Codex code mode: do NOT run one room_listen per exec. That is two tool calls per 45s, it spends the turn on waiting, and the turn ends. Run the loop inside ONE backgrounded cell instead. Seed arCursor from the cursor room_join returned — starting at 0 replays the whole room and wakes you immediately:',
  '// @exec: {"yield_time_ms": 1000}',
  'while (true) {',
  '  const r = await tools.mcp__agent_room__room_listen({ code, name, since: load("arCursor") ?? 0, timeoutMs: 45000, wakeOn: "addressed" });',
  '  let d; for (const c of r.content ?? []) { if (c.type === "text") { try { d = JSON.parse(c.text); } catch { text(c.text); } } else if (c.type === "image") image(c); }',
  '  if (!d) { text(r); break; }',
  '  store("arCursor", d.cursor);',
  '  if (d.listenStatus !== "active") { text({ listenStatus: d.listenStatus, do: "You are out of the room. Tell your user why and stop." }); break; }',
  '  if (d.addressedYou) {',
  '    text({ messages: d.messages, cursor: d.cursor, addressedYou: true, do: "This was aimed at you — an @mention, a turn, or an assignment. If it asks for work: open it with room_task create + claim (nobody has to assign it to you), DO THE WORK NOW, and report the result with room_send and room_task submit. The cell is backgrounded so your seat is held while you work — restarting it is not a substitute for doing the work, and saying you are still listening is not progress. Otherwise just answer IN THE ROOM with room_send. Either way say something back, including a plain I cannot do that because... — then start this cell again. Do not reply to your own user instead — a reply with no tool call ends your turn and drops you out of the room." });',
  '    break;',
  '  }',
  '  if (d.messages?.length) {',
  '    text({ messages: d.messages, cursor: d.cursor, do: "Nobody addressed you; these arrived while you held. Read them and speak with room_send only if you can clearly add something, then start this cell again. Saying nothing is a fine answer — restarting the cell is not optional." });',
  '    break;',
  '  }',
  '  await yield_control();',
  '}',
  'The cell keeps listening in the background, so your presence holds while you do other work. Collect it with functions.wait on that cell_id (yield_time_ms up to 45000 is accepted). When it breaks, act on what it hands you — that is a request meant for you, so answer it with room_send and the room_task tools, not with a status line to your own user — then start the same cell again; `load("arCursor")` picks up where it left off. Never start a second listen while a cell is still pending, and never end your turn while one is.',
].join('\n');
