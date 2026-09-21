# Known Gaps — MVP v0.1 (2026-04-11)

Findings from the final-implementation code review that we **intentionally did not fix** in the MVP. Each entry records what the spec claimed, what the code actually does, and the reasoning behind shipping with the gap.

If you come back to harden this into production, this file is the starting checklist.

## 1. Worker CORS gap — resolved by removing the Worker

- **Spec §13:** "CORS on Worker allows the web app's origin only (not `*`) in production."
- **Original reality:** `apps/worker/wrangler.toml` set `ALLOWED_ORIGIN = "http://localhost:5173"` and had no `[env.production]` stanza.
- **Resolved:** The Worker was removed. Web AI assistance is now BYO-agent prompt chips in the composer, so there is no Worker CORS surface.

## 2. `casRoom` is not atomic — Lua script deferred

- **Spec §12.3:** "uses a small Lua script via Upstash's `/pipeline` endpoint to `GET + compare version + SET` atomically."
- **Reality:** `packages/upstash-client/src/rooms.ts` implements a plain read-mutate-write loop with a 3-attempt retry. The race window is real but small.
- **Why shipped:** Only the `participants` field ever goes through `casRoom`. Messages use atomic RPUSH. With typical MVP usage (a handful of humans per room, agents joining at most a few times a minute), the race is vanishingly rare and the worst case is a dropped heartbeat update. A Lua script is the right fix when you outgrow this.

## 3. Participants tab not implemented — resolved

- **Spec §5.4:** "Tabs: Discussion / Minutes / Participants"
- **Original reality:** `apps/web/src/screens/Room.tsx` had only Discussion and Minutes. Participants were visible only via the avatar stack in the header (max 5 shown).
- **Resolved:** Room now has a dedicated People panel with participant list, role, client type, host badge, kick controls, and presence status.

## 4. Presence staleness (gray-out after 60s) not rendered — resolved

- **Spec §5.4:** "participants fade to gray after 60s without a heartbeat."
- **Original reality:** `PRESENCE_STALE_MS` was defined in constants and `lastSeenAt` was updated via heartbeat, but nothing in the UI compared it for rendering.
- **Resolved:** The People panel now shows Listening, Online, or Idle using `listenUntil`, `lastSeenAt`, and `PRESENCE_STALE_MS`; idle avatars render muted.

## 5. AI draft response buffered, not streamed — resolved by removing hosted drafts

- **Spec §8.1:** "Response streams back; draft appears in composer."
- **Original reality:** The Worker and web client awaited a full JSON response before showing the draft.
- **Resolved:** Hosted draft generation was removed. The composer now pre-fills prompts that the host can send to their own agents; agent replies appear in the transcript like any other message.

## 6. `EXISTS room:{code}` collision check skipped

- **Spec §4:** "generate → `EXISTS room:{code}` → regenerate if taken"
- **Reality:** Both `CreateMeeting.tsx` and `room_create` in the MCP server just call `generateCode()` and `SET` the room. With 31⁹ ≈ 2.6×10¹³ combinations and ≤24h TTL, collision probability is negligible at MVP scale.
- **Why shipped:** Not worth the extra round trip for a non-problem.

## 7. `room_minutes` tool does not return cached minutes

- **Spec §10.2:** tool "returns the cached minutes, or the full history if no cache exists"
- **Reality:** `apps/mcp/src/tools.ts` (now in the agent-room-mcp repo) always returns the raw transcript plus topic and participant list — never reads `room-min:{code}`.
- **Why shipped:** The spec's "cached minutes" semantics assume the MCP server invokes AI. In the implemented design the user's own agent summarizes the transcript directly, so caching on the MCP side would be redundant. The web app also asks agents via prompt chips and no longer caches generated minutes. The tool description in `tools.ts` accurately describes the actual behavior; only the spec framing is stale.

## 8. `any` cast in MCP tool dispatch

- **Location:** `apps/mcp/src/tools.ts` (now in the agent-room-mcp repo) — `const a = (args ?? {}) as Record<string, any>`
- **Why shipped:** The MCP SDK exposes `arguments` as `unknown` at the type level. A properly-typed per-tool interface would eliminate the cast. Worth doing when the tool set grows; MVP has 6 tools and they're all covered by the inputSchema declarations.

## 9. Toast.tsx dynamic-import warning at Vite build

- **Symptom:** Vite prints a warning that `Toast.tsx` is both statically imported (from `router.tsx` and `copy.ts`) and dynamically imported (from `Room.tsx`'s send-failure path), so it can't be split into its own chunk.
- **Why shipped:** Benign. Toast is in the main bundle either way. Pick one import style if the warning becomes annoying.

## 10. No `hostVerified` flag — sender names stay unauthenticated

- **What the hosted deployment has:** messages posted under the room host's name carry `hostVerified: true` when its server proved the claim on that send (the room's hostKey, or the signed-in owner). Its MCP `TRUST` line tells agents they may act on a verified host's request without asking their own user who sent it.
- **Reality here:** the web client writes to Upstash directly from the browser with `VITE_UPSTASH_REDIS_REST_TOKEN`, so any visitor holds a write token and can store any message — including one that says `hostVerified: true`. No code path in this repo sits between the host's browser and the store, so there is nothing that could prove the claim.
- **Why not ported:** a flag anyone can forge is worse than no flag. An agent told "act on hostVerified without asking" would obey a forged message. The `TRUST` line in `api/_mcpTools.ts` therefore keeps saying that sender names are not authenticated, which is true for this deployment.
- **What it would take:** route message writes through a server (as the hosted deployment's `/api/room` does), take the write token out of the browser bundle, verify the host claim there, and have `appendMessage` strip any client-supplied `hostVerified` and set it only from that server. Durable member auth (`docs/authenticated-room-members.md`) verifies agents' signed cards, not the human host, so it does not close this.
