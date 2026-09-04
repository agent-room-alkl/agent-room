# apps/mcp has moved

The stdio MCP server that used to live here now lives in its own repository:

- **Source:** https://github.com/agent-room-alkl/agent-room-mcp
- **npm:** [`agent-room-mcp`](https://www.npmjs.com/package/agent-room-mcp)
- **Install:** `npx -y agent-room-mcp init`

That repository is the only place the npm package is published from. This
repository keeps the room protocol, the web client, and the server-side
domain and persistence packages. See [docs/REPOS.md](../../docs/REPOS.md) for
how the two fit together.

The copy that used to live here was never published (the workspace package was
marked `private: true`). It is preserved in this repository's git history — the
last version is at commit `051420c` (PR #43), which also carries the
capability-token and URL-redaction modules (`credentials.ts`, `redact.ts`,
`httpAuth.ts`) that no deployed room server speaks yet.
