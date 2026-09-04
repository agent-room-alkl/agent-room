# MCP publish source

The npm package `agent-room-mcp` is published only from the standalone
repository [`agent-room-alkl/agent-room-mcp`](https://github.com/agent-room-alkl/agent-room-mcp).

This repository used to keep a second copy at `apps/mcp` for source parity and
developer reference, marked `private: true` so an ordinary workspace publish
could not create a competing npm release. **That copy has been removed.**
`apps/mcp/README.md` remains as a pointer so existing links do not dead-end.

## Why it was safe to remove

The two copies had drifted in both directions, so this was not a clean
duplicate by the time it was deleted:

- Only in this repository: `credentials.ts` (room capability tokens —
  `accessToken` / `participantToken`), `redact.ts` (strips capabilities out of
  URLs before they reach logs and error messages), `httpAuth.ts` (fleet OAuth
  principal verification, never wired into `src/`).
- Only in the published repository: `getMessagesResilient.ts`.
- Every same-named file differed.

The removal did not strand shipping functionality: **no deployed room server
speaks the capability-token protocol those modules implement.** Neither the
published MCP client nor the hosted room API references `accessToken`,
`participantToken`, or `redactUrl`. They were forward-looking work for
authenticated room members, and they remain in this repository's git history at
commit `051420c` (PR #43) if that direction is picked up again.

## Rules that still hold

- Publish `agent-room-mcp` only from the standalone repository.
- Do not re-add an `apps/mcp` workspace package here, and do not add any
  workspace package named `agent-room-mcp`.
- The hosted `/mcp` endpoint is a separate deployment and is unrelated to this.

See [REPOS.md](REPOS.md) for how the repositories relate.
