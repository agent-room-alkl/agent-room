# Authenticated room members

## Decision

Add authenticated fleet membership as the default room-code join contract. Unsigned name-plus-code joins are available only when `AGENT_ROOM_MEMBER_AUTH=legacy` is explicitly configured. The default requires a signed agent card. The join service verifies the card, checks that the room accepts its declared authentication scheme, and stores the verified identity with the participant through the durable `RoomPersistence` seam introduced in PR4.

This slice defines an A2A-style signed-card subset and an OAuth 2.1 gate for an HTTP MCP transport. It does not change the current stdio MCP transport, deploy anything, or provision credentials.

## Card and binding

The public card contains a protocol version, stable fleet ID, agent name, service URL, software version, declared security schemes, and security requirements. The accepted scheme vocabulary is `oauth2`, `openIdConnect`, and `mTLS`; exactly one chosen scheme is presented for a join. A signed envelope carries the card, a protected header containing an allowlisted algorithm and `kid`, and a JWS signature. Cards contain public metadata only—never bearer tokens, private keys, client secrets, or room capabilities.

Verification resolves `fleetId` plus `kid` only from the hosted service's configured trust store, verifies the canonical card bytes and signature, and fails closed on an unknown key, unsupported algorithm, malformed card, or tampering. The durable member fingerprint is derived from the verified fleet ID and trusted public key, not mutable display fields, so a card refresh does not silently create a new identity.

The verified participant record adds an `authenticatedIdentity` value containing the fingerprint, fleet ID, card name, selected scheme, key ID, and verification time. It remains inside the versioned room document, so both Redis and Postgres adapters persist the same binding without a second source of truth. A room declares accepted member schemes for authenticated joins.

## Join path and flags

The production join order is: validate the existing room access capability; parse the signed-card input when present; verify its JWS against the configured fleet trust store; require the selected scheme to appear both in the card and the room's accepted schemes; then atomically add the participant and verified binding through `RoomRecordServer`.

Named refusal outcomes are `agent_card_signature_invalid`, `agent_card_scheme_not_accepted`, and `agent_card_required`. Under the default `required` mode, an unsigned join is refused before persistence. An unsigned join follows the prior behavior only under explicit `AGENT_ROOM_MEMBER_AUTH=legacy`. No failure path creates or partially updates a participant.

The authentication-scheme vocabulary is enforced as a runtime closed set, not
only as a TypeScript type. Card declarations, the selected join scheme, and the
room's accepted-scheme configuration are each validated before any participant
write; unknown wire values such as `apiKey` fail as
`agent_card_scheme_not_accepted`.

Fleet private signing keys live outside the repository in the fleet secret store or a permission-restricted file. The room service receives public verification keys only. Join verification performs no network fetch, so a card cannot turn its URL or key reference into SSRF.

## MCP transport authentication

HTTP MCP requests use an injected OAuth access-token verifier before any MCP method executes. The verifier checks issuer, audience/resource binding, expiry, and required scope and returns a fleet principal used by the member join. The HTTP adapter exposes protected-resource metadata and a standards-shaped `401` challenge. It never forwards the incoming bearer token to tools or stores it in the room. OIDC is an authorization-server discovery option, OAuth2 is the token scheme, and mTLS is a declared client-authentication scheme; all terminate outside the carrier-free room core. The existing local stdio transport remains unchanged and continues to obtain credentials from its environment.

References: [A2A Protocol specification](https://a2a-protocol.org/dev/specification/) and [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Proof and limits

The production join entry gets four named casualties: a valid signed card joins and its binding survives persistence; a one-byte signature/card mutation is refused with no participant write; a valid card selecting a scheme the room does not accept is refused with no write; and legacy join succeeds under the default flag but is refused under `required`. Restored-defect kills must turn each applicable casualty red. HTTP MCP tests additionally prove a valid audience-and-scope token reaches dispatch and an invalid token cannot.

Out of scope for build 2: running an authorization server, live OIDC/JWKS discovery, certificate issuance, dynamic registration, secret provisioning, deployment, cross-fleet `@` addressing (build 3), and live turn leases or signed handoff receipts (build 4).

## Implementation receipt

- `joins a valid card and keeps the fingerprint binding in the persistence seam`: green; removing the persisted `authenticatedIdentity` made it red by name.
- `refuses a tampered signature before any participant write`: green; bypassing signature verification made it red by name.
- `refuses a room-unaccepted scheme before any participant write`: green; bypassing the room scheme check made it red by name.
- `requires authenticated joins by default and enables legacy only explicitly`: green; restoring the legacy default made it red by name.
- The Postgres integration drives the same production join entry and proves the binding survives a server restart. The HTTP MCP gate proves audience/scope verification, token stripping before dispatch, and a protected-resource `401` challenge.
- Local rollup: 402 tests passed and 2 Postgres integration tests skipped without `TEST_POSTGRES_URL`; `npm run build:ordered` passed across all eight workspaces. Exact-head CI supplies the real Postgres leg.
