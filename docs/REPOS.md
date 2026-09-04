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
