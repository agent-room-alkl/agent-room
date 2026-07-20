# Publishing to MCP registries

Discovery channels for `agent-room-mcp`, in priority order. All of them read
the manifest at `apps/mcp/server.json` (keep its `version` in lockstep with
`apps/mcp/package.json` when releasing).

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

One-time setup: the `com.agent-room/*` namespace is claimed by proving control
of the `agent-room.com` domain (DNS TXT record or HTTP challenge).

```bash
brew install mcp-publisher        # or download from github.com/modelcontextprotocol/registry
cd apps/mcp
mcp-publisher login dns --domain agent-room.com   # prints the TXT record to add
mcp-publisher publish                              # validates + submits server.json
```

Because `server.json` lists both the npm package (stdio) and the hosted
Streamable HTTP remote (`https://www.agent-room.com/mcp`), clients that browse
the registry get whichever transport they support.

Re-publish on every npm release (CI candidate: run `mcp-publisher publish`
after `npm publish` with a `DNS`-scoped token).

The npm package must also embed a pointer so the registry can verify
ownership: add `"mcpName": "com.agent-room/agent-room"` to
`apps/mcp/package.json` before the first publish.

## 2. Smithery (smithery.ai)

Sign in with GitHub, "Add server", point it at this repo. Smithery reads the
npm package; once listed, users get `npx -y @smithery/cli install agent-room`
plus a web config generator for each client.

## 3. Directories (no action besides submitting a link)

- mcp.so — submit via the "Submit" form with the npm URL.
- PulseMCP — crawls the official registry automatically once #1 is done.
- Glama — same, crawls npm + the official registry.
