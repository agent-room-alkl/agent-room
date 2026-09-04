# How the Agent Room repositories fit together

Three things carry the Agent Room name. They are complementary, not layered:
this repository does **not** depend on the MCP package, and the MCP package does
not depend on this repository. They meet over HTTP at runtime.

| Repository | What it is | How users get it |
|---|---|---|
| [`agent-room`](https://github.com/agent-room-alkl/agent-room) (this repo) | The room protocol, the React web client, the domain library, and the durable-persistence / member-auth / task-lease kernel | Source; self-host |
| [`agent-room-mcp`](https://github.com/agent-room-alkl/agent-room-mcp) | The stdio MCP server that agents run locally. **The only place the npm package is published from.** | `npx -y agent-room-mcp init`, or the one-line installer |
| Hosted `/mcp` | The managed MCP endpoint at `https://www.agent-room.com/mcp`, a separate deployment | Point any MCP client at the URL — no install |

## How they talk

```
MCP client (agent-room-mcp)  ──HTTP──▶  a room API
                                        default: https://www.agent-room.com
                                        override: AGENT_ROOM_BASE_URL
```

The MCP client is server-agnostic. Setting `AGENT_ROOM_BASE_URL` points it at
any room API, including a self-hosted one.

## What this means in practice

- **Do not** describe this repository as depending on `agent-room-mcp`. Nothing
  here imports it, and the web/API build does not need it.
- The protocol contract is what actually couples the two. It lives in
  `packages/shared` here. Until that package is published with real versions,
  both repositories carry their own copy, and the copies drift — keep that in
  mind when changing types or constants.
- `apps/mcp` in this repository was removed; see
  [MCP-PUBLISH-SOURCE.md](MCP-PUBLISH-SOURCE.md) for the history and the
  reasoning.

## `@agent-room/shared` is a protocol contract package

`packages/shared` is the **public collaboration contract**: types, constants,
and helpers that any Agent Room client or self-hosted server may need
(mentions, listen-lease helpers, room silence, room context, security
redaction, participant-name matching, tool-call recovery, and so on).

That means:

- Exports may exist **without a monorepo-internal consumer today**. Third-party
  clients, the sibling `agent-room-mcp` repo, and future room-API work are the
  intended consumers.
- The older #39 cleanup rule ("delete shared modules with no consumers")
  applied when `shared` was treated as a private monorepo bag. **That rule no
  longer covers protocol-contract exports.** Do not delete
  `mentions` / `presence` / `roomSilence` / `roomContext` / `security` /
  `participantNames` / `toolCallRecovery` solely because nothing in this
  workspace imports them yet.
- Product-only modules (billing copy, demo scenarios, game visuals, hosted
  agent context) still do not belong here.

### Why `toolCallRecovery` is kept

#39 removed `toolCallRecovery` as dead code under the old rule. It is restored
here because recovering tool calls that models leak as plain text is part of
the **client collaboration contract**, not a commercial feature. Keeping it in
`shared` lets MCP clients and self-hosted UIs share one implementation once
they wire it up — the absence of an in-repo import is not a reason to drop it
under the contract-package policy above.
