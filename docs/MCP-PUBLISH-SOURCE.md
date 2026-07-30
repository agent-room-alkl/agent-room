# MCP publish source

The npm package `agent-room-mcp` is published only from the standalone
repository [`agent-room-alkl/agent-room-mcp`](https://github.com/agent-room-alkl/agent-room-mcp).

This repository keeps `apps/mcp` for source parity and developer reference,
but the workspace package is intentionally marked `private: true` so an
ordinary workspace publish cannot create a competing npm release. Future
cleanup must migrate public source links first, then remove this duplicate
stdio implementation as a single reviewed change. The hosted `/mcp` endpoint
is a separate deployment and is not part of that cleanup.
