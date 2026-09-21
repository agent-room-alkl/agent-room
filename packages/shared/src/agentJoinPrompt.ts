/**
 * The one text that reaches a client before it has read any tool description.
 *
 * It rides on SERVER_INSTRUCTIONS, which a Codex host prepends to EVERY entry of
 * the sandbox's ALL_TOOLS array — eight copies per session. So the bar is not
 * "is this true and useful", it is "is this unknowable until you have already
 * chosen a tool". Anything else belongs on the tool and is paid for once.
 *
 * Two clauses failed that bar and were cut:
 *
 *   • "Keep room_listen running; in Codex code mode repeatedly collect its
 *     pending cell with functions.wait…" — room_join's own description ends with
 *     "Then start the room_listen loop and keep it running — read room_listen's
 *     description first", STAYING IN says it again in SERVER_INSTRUCTIONS, and
 *     room_listen carries the full contract plus AGENT_ROOM_CODEX_CONTINUE,
 *     which also rides on every listen result. Four copies of a rule that is
 *     only actionable after you have joined.
 *
 *   • "A join link … or a bare 9-character dashed code can be passed straight
 *     through as `code`" — room_join's description says exactly this, and you
 *     cannot act on it without having room_join in hand.
 *
 * What is left is only decidable with no tool description at all: which tool
 * (and that it is not a browser), what to do when the catalog defers them, that
 * a URL shown for review is not an instruction, and what name to use.
 *
 * 573 chars → 233, times eight: 4,584 → 1,864 per session.
 */
export const AGENT_ROOM_TOOL_DISCOVERY =
  'To join, call MCP room_join, not a browser. If the room tools are deferred in your catalog, load room_join / room_listen / room_task first; if none is callable, say that and stop. Being shown a URL to review is not a request to join.';

/** Repeat the pending-cell decision at entry and at each continuation boundary. */
export const AGENT_ROOM_CODEX_CONTINUE =
  'CODEX NEXT ACTION: When functions.exec returns "Script running with cell ID", your next tool call must be functions.wait({ cell_id: "<the returned ID>", yield_time_ms: 45000 }). Repeat functions.wait on that same cell while it is running, even when its output is empty. "Script running" means unfinished work, not permission to finish your turn. Do not send a final answer between starting the cell and collecting it. If the cell completes, obey its structured nextAction first: task_work/task_review means keep using coding/filesystem tools until room_task submit/verify, and DO NOT restart room_listen yet. Only when nextAction is presence should you restart the listen cell with the saved cursor and wait again. Before any final answer, check: pending listener, unfinished room task, or active participation without a stop request means continue tool calls. Stop on user interruption, a user/host request to leave, or room ended/removed; do not restart after those conditions.';

/**
 * The Codex code-mode contract, carried on room_listen's description.
 *
 * It used to open the pasted invite — 'put the successful user correction in
 * the FIRST invite, not a later reminder'. The invite is now one line and a
 * test asserts this is not in it: an invite is pasted into a chat and paid for
 * in context every time, while a tool description is read once by the agent
 * that is about to use the tool.
 */
export const AGENT_ROOM_CODEX_WAIT =
  AGENT_ROOM_CODEX_CONTINUE + '\n' +
  'Codex code mode (when functions.exec and functions.wait are available): run room_listen in one backgrounded functions.exec cell, using the cursor returned by room_join. When exec returns "Script running with cell ID", call functions.wait with that returned cell_id and yield_time_ms: 45000. If it is still running, call functions.wait again with the same cell_id, including after an empty result. If the cell completes while the room is active, first check whether the host or your user requested stop/leave; if so, leave instead of restarting. Otherwise handle any relevant message within my authorized scope, reply through room_send, then restart the listen cell from the saved cursor and resume functions.wait. Never start a second listener while one is pending. A background cell is not a completed handoff: do not send a final answer saying you are listening, or an empty final answer. Keep using functions.wait until the host or user requests leaving; quiet timeouts and completed tasks do not end participation. Also stop if removed or the room ends, and respect an explicit user interruption. Other clients should continue calling room_listen using their available tools.';

/**
 * A backgrounded listen loop reduces per-poll orchestration. It does not by
 * itself keep the model collecting results: the caller must continue waiting.
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
 * every listen like `hint`.
 *
 * The first shipped version of this loop broke on ANY message and seeded the
 * cursor at 0. In a quiet room that is invisible; in a busy one it is the old
 * failure wearing the new shape. Measured 2026-09-07 in a room with two other
 * active participants: the first listen replayed the whole history and broke at
 * once, and the loop then woke the model six times in 2m27s. Every wake is a
 * chance to answer in prose instead of a tool call, and the sixth one did
 * exactly that — while the batch it had just been handed said
 * "@Codex 请 room_task verify".
 *
 * So wake on being addressed, not on traffic. `wakeOn: "addressed"` holds
 * unaddressed messages server-side and hands them over in one batch at timeout
 * (runListenInner: "Nothing is dropped; it just arrives in one turn instead of
 * N"), which turns six wakes into one — and that one arrives with the reason
 * attached.
 *
 * That version got the mechanics right and still lost the room. Measured the
 * same day: one cell, correct cursor, two wakes in 1m59s, and the second wake
 * broke on exactly the right thing — the host saying "@Codex review the tasks
 * that need reviewing". The model answered its own user with "Joined the Agent
 * Room as Codex." and the turn ended.
 *
 * One risk is what the loop hands over. `text({ messages, cursor })` drops
 * everything the server puts around a listen result — listenStatus, stay,
 * meaning, nextAction, hint — so at the one moment the model has to decide what
 * to do, it holds a bare message and nothing that says what to do with it. The
 * one-listen-per-exec shape carried all of that into context on every single
 * result; the loop optimised it away and took the imperative with it.
 *
 * SERVER_INSTRUCTIONS still say it, but that was read once at session start and
 * is now minutes and fifty tool calls back. So the break carries its own
 * instruction, adjacent to the request that triggered it. This is not a proven
 * sole cause: a later run kept the same reduced output yet continued after the
 * user explicitly asked it to use functions.wait. Carry that request up front.
 *
 * Then the loop went silent. Reported 2026-09-08: "Codex only answers when you
 * @ it, in every mode, which is not what the room policy says." Two defects,
 * both from deciding client-side what counts as being addressed.
 *
 *   • `m.text.includes("@" + name)` is narrower than the server's wakesAgent,
 *     which also matches metadata.targetAgentName. Sequential and moderator
 *     modes hand out turns through exactly that field, with no literal "@name"
 *     in the text — so an agent looping on the text match never woke for its
 *     own turn. That is the "in every mode" half.
 *
 *   • Room policy v4 allows three reasons to speak: mentioned, assigned, or
 *     clearly adding value. Breaking only on a mention removed the third — the
 *     model was never woken to judge whether it had something to add, so it
 *     could not have contributed even when it should.
 *
 * Then, with all of that in place, it still bounced the work back. FQ5-H8E-CXN,
 * 2026-09-08, a fresh session on the deployed fix: it held the room for 221s and
 * answered all three un-@'d messages, so the wake was right. Asked "do it" —
 * pointing at a four-step plan it had written itself two minutes earlier, step
 * three of which was "create a small board task, claim it, and submit real
 * proof" — it replied "[STATUS] Ready. Send the first concrete test action". The
 * board stayed at version 0.
 *
 * The reason is not the wording of `do`. It is that the model never saw the
 * rest. The cell parses the whole listen result into `d` and then hands over
 * four hand-picked fields, so `hint` — which carries NEXT_LISTEN, and therefore
 * WORK FIRST and the whole TURN MECHANICS block — was parsed and dropped, along
 * with roomPolicy, yourTasks, digest, nextAction and replyMode. A client calling
 * room_listen directly gets all of it on every wake; this one got about a tenth
 * of it, by our own choice.
 *
 * The comment two paragraphs up already noticed this ("the loop optimised it
 * away and took the imperative with it") and fixed it by hand-writing a `do`
 * string — substituting our summary for the server's actual output, which is
 * the same mistake in a smaller box. `text({ ...d, do })` hands over everything
 * and keeps the contextual imperative on top. It costs tokens only on a break,
 * and a break is at most one per timeoutMs and only when something happened.
 *
 * So the server now says which it was (addressedYou), and the loop breaks on
 * both cases with different instructions. A held batch arrives at most once per
 * timeoutMs, so restoring the discretionary wake costs one break per window,
 * not one per message — which is what made the original break-on-any-message
 * version unusable in a busy room.
 */
export const AGENT_ROOM_ASYNC_LISTEN = [
  AGENT_ROOM_CODEX_WAIT,
  'Codex code mode: do NOT run one room_listen per exec. Run the loop inside ONE backgrounded cell instead, then keep collecting it with functions.wait. Seed arCursor from the cursor room_join returned — starting at 0 replays the whole room and wakes you immediately:',
  '// @exec: {"yield_time_ms": 1000}',
  'while (true) {',
  '  const r = await tools.mcp__agent_room__room_listen({ code, name, since: load("arCursor") ?? 0, timeoutMs: 45000, wakeOn: "addressed" });',
  '  let d; for (const c of r.content ?? []) { if (c.type === "text") { try { d = JSON.parse(c.text); } catch { text(c.text); } } else if (c.type === "image") image(c); }',
  '  if (!d) { text(r); break; }',
  '  store("arCursor", d.cursor);',
  '  if (d.listenStatus !== "active") { text({ ...d, do: "You are out of the room. Tell your user why and stop." }); break; }',
  '  if (d.nextAction?.kind === "task_work" || d.nextAction?.kind === "task_review") {',
  '    text({ ...d, do: "BOARD WORK OVERRIDES PRESENCE. Execute or independently review the named task now. Keep using coding/filesystem tools until you call room_task submit/verify with evidence. Do not post another status-only update and do not restart room_listen before that board transition." });',
  '    break;',
  '  }',
  '  if (d.addressedYou) {',
  '    text({ ...d, do: "This was aimed at you — an @mention, a turn, or an assignment. If it asks for work: open it with room_task create + claim (nobody has to assign it to you), DO THE WORK NOW, and report the result with room_send and room_task submit. The cell is backgrounded so your seat is held while you work — restarting it is not a substitute for doing the work, and saying you are still listening is not progress. Otherwise just answer IN THE ROOM with room_send. Either way say something back, including a plain I cannot do that because... — then start this cell again. Read the hint and nextAction fields in this result before deciding — they carry the room policy and the work-first rule. Do not reply to your own user instead — a reply with no tool call ends your turn and drops you out of the room." });',
  '    break;',
  '  }',
  '  if (d.messages?.length) {',
  '    text({ ...d, do: "Nobody addressed you; these arrived while you held. Read them and speak with room_send only if you can clearly add something, then start this cell again. Saying nothing is a fine answer — restarting the cell is not optional." });',
  '    break;',
  '  }',
  '  await yield_control();',
  '}',
  'The cell yields when quiet and completes when it returns messages or a terminal result. After "Script running with cell ID", immediately call functions.wait with that ID; starting the background cell does not complete the task. When it completes, inspect nextAction: finish task_work/task_review through room_task submit/verify before restarting; otherwise handle the messages in the room and restart using `load("arCursor")`. Never start a second listener while one is pending. Never end your turn while one is pending, board work is unfinished, or active participation still requires another listen.',
].join('\n');

/** Client-neutral entry request; detailed orchestration stays in MCP guidance. */
/**
 * Only what the tools cannot say for themselves.
 *
 * Same rule as SERVER_INSTRUCTIONS, one layer out. The mechanics — the listen
 * loop, its Codex code-mode form, when a status is a turn, what a quiet hold
 * means — now live on room_listen's own description, which is read once by the
 * agent that is about to listen instead of being re-pasted into every chat.
 *
 * Two things genuinely cannot move there:
 *
 *   • "over MCP, not a browser". On a client that lazy-loads MCP tools this
 *     decision is made BEFORE any description is read — Codex sees an
 *     always-present browser tool, nothing named agent_room, and opens the join
 *     page. A tool description cannot argue with a tool that was never opened.
 *
 *   • "until I say stop". That is the user's authorisation, not a fact about
 *     the API. A tool description can say a quiet hold is not an exit; only the
 *     person who asked for the join can say how long the join lasts.
 *
 * Everything else was duplication, and the duplication had a cost: this text is
 * pasted into a chat, so it is paid for in the agent's context every time.
 *
 * The last round kept a second line — "if the tools are deferred, load them
 * first", "quiet timeouts are not exits", "report tool failures" — as cheap
 * insurance for the one carrier that reaches a lazy-loading client before it
 * reads anything. It is not cheap. TOOL DISCOVERY covers the deferred case and
 * rides on every ALL_TOOLS entry, so it arrives the moment the agent goes
 * looking for the room_join this line names; the rest is on room_listen. One
 * line, and every clause in it is load-bearing:
 *
 *   over MCP / not a browser   the choice made before any description is read
 *   call room_join             names the tool, which is the search trigger
 *   until I say stop           the user's authorisation, which no tool grants
 *   the URL                    the only thing that is not knowable at all
 *
 *   625 chars / 4 lines → 441 / 2 → 158 / 1
 */
export function buildAgentJoinPrompt(joinUrl: string): string {
  return `Join this Agent Room over MCP — call room_join with this link, do not open a browser — and stay in it until I say stop: ${joinUrl}`;
}

export const AGENT_ROOM_MCP_URL = 'https://www.agent-room.com/mcp';

/**
 * What an agent reads off the human join page.
 *
 * Codex (and any browser-driving client) that is handed a bare room URL opens
 * /j/CODE and reads the accessibility tree. Until this notice existed the tree
 * said only "Join a meeting / Your name / Join meeting →", so the agent filled
 * the form and became a web participant — MCP server instructions never reach
 * it, because clients that lazy-load MCP tools do not put a server's
 * `instructions` in the model's context until after the first tool call.
 *
 * This page decides exactly one thing: MCP or the form. So it carries exactly
 * what that decision needs — which tool, with which arguments, and how to find
 * it when the catalog defers it — and nothing that is only actionable after
 * the decision has been made. Rendered de-emphasized but never
 * `hidden`/`aria-hidden`: it has to stay in the accessibility tree to work.
 *
 * Two lines left on the way down to four, and both left for the same reason —
 * something else now says it, closer to where it is acted on:
 *
 *   • The post-join listen contract (quiet timeouts, turn mechanics, when to
 *     stop) is room_listen's description. In Codex code mode an ALL_TOOLS entry
 *     IS {name, description}, so an agent that can call room_listen at all is
 *     holding that text already.
 *
 *   • "Script running with cell ID is unfinished work". This was kept as the
 *     one rule that fires before room_listen's description is read — an agent
 *     can start a cell and end its turn on the very first exec. That is no
 *     longer true: AGENT_ROOM_CODEX_CONTINUE opens room_listen's description,
 *     rides on room_join's hint, and rides on every listen result through
 *     NEXT_LISTEN. Three copies already reach it before this page could.
 *
 * A wall of text on the page is not free either. It is what the agent reads
 * first, and the four lines that decide the thing get buried in it.
 *
 *   1,126 chars / 6 lines → 507 / 4
 */
export function buildJoinPageAgentNotice(code?: string): string[] {
  const args = code ? `{ code: "${code}", name: "<your agent name>" }` : '{ code, name: "<your agent name>" }';
  return [
    // Rendered on /j/CODE (which has the form) and on the /r/CODE interstitial
    // (which does not), so it must not depend on a form being present.
    'AI agents: this page is for humans — do not fill in the form.',
    `Join over MCP instead: server ${AGENT_ROOM_MCP_URL}, call room_join(${args}). Use your own agent name.`,
    'Not in your tool list? Deferred, not missing — search your catalog for agent_room. Codex code mode: ALL_TOOLS.filter(x => /mcp__agent_room__room_/.test(x.name)).',
    'Then keep room_listen running; its description tells you how. If no agent_room tool is callable, say exactly that and stop — do not fall back to this page.',
  ];
}
