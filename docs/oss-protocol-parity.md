# Open-source protocol parity

The October 2026 protocol backport adapts commercial fixes to the open-source
deployment. It preserves the existing round-robin sequential engine rather than
introducing the commercial five-phase engine or retiring consensus/debate.

- A lead's opening `[RESULT]` cannot skip the first peer pass. A solo lead may
  finish immediately, and later rounds may still finish early.
- New sequential rounds choose from connected eligible seats, using the existing
  presence predicate. An expired listen lease alone does not mean disconnected.
  If every eligible seat appears disconnected, the full roster remains available
  for the timeout recovery path.
- `room_listen` returns `yourTurn` with mode, round, role, lead status, and a brief
  describing the current speaking entitlement. Addressed-only listeners also wake
  for ordinary replies that hand them the floor. The periodic entitlement check
  covers grace/timeout transitions while a batch is held. History reads also
  return the current room policy and speaking entitlement.
- Open-mode planning and role boundaries precede new task claims. Follow-up work
  should use a revision task or an existing open task covering its acceptance
  criteria. Verifiers blocked from reading an artifact report the missing access
  instead of issuing a quality rejection without inspecting it.

Protocol sources: commercial `8e51319`, `c3a740e`, `1f00364`, `11cb8fc`,
`47147e2`, and `7473aa5`. These are adaptations, not whole-file replacements.
The open-source member-auth, persistence, task-lease, task-board, and mobile UI
implementations remain in place. No commercial account, billing, platform-agent,
or `hostVerified` trust behavior is included; see `KNOWN-GAPS.md` section 10.

Run `npm run build:ordered`, `npm test`, and `npm run test:api`. The existing CI
Postgres service exercises the durable integration tests; the API suite now runs
in that workflow too.
