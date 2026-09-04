# Durable room storage

Status: design checkpoint for UC2 build 1. This change adds a storage seam and a
Postgres implementation without changing the running default. Deployment,
database provisioning, credentials, and backfill execution are separate hosting
decisions.

## Seam

The room server depends on a `RoomPersistence` interface rather than issuing
vendor commands. The interface owns the durable record families and their
ordering/concurrency contracts:

- rooms: create, read, compare-and-swap update, and explicit end;
- participants: the participant collection stored with the room version;
- messages: append in room order and list from an absolute cursor;
- task boards: read and compare-and-swap write by board version;
- minutes/reports: create and read the immutable room snapshot;
- receipts: append and deduplicate by a caller-supplied receipt id.

The live turn lease remains an ephemeral Redis coordination primitive, but each
lease transition is also appended through `appendLeaseEvent` as a receipt-class
durable record. The closed event vocabulary is `granted`, `renewed`, `released`,
`expired`, and `handoff_requested`. Build 3 and signed handoff receipts therefore
read the one-pen-at-a-time history after the live lease itself has expired.

The seam uses the shared domain types. It does not expose Redis commands, SQL,
connection objects, or credentials. `createRoomPersistence(config)` is the only
adapter-selection point. `AGENT_ROOM_PERSISTENCE=redis` is the default and uses
the existing Redis environment and 24-hour behavior. `postgres` requires a
server-side database URL and fails closed when it is absent. Browser code never
receives that URL.

This first slice preserves the current exported Redis operations through a
`RedisRoomPersistence` adapter and adds a `PostgresRoomPersistence` adapter. The
production entry chooses once at startup and passes the interface into room
handlers. Presence, listen cursors, turn leases, rate-limit counters, and other
ephemeral coordination remain in Redis; later UC2 builds may give turn leasing
its own seam.

## Durability contract

| Record | Redis default | Postgres durable mode |
| --- | --- | --- |
| Room | Hard expiry 24 hours after creation | Retained until an explicit retention/deletion action |
| Participants | Stored in the room JSON and expires with it | Versioned room state; survives restart and elapsed wall time |
| Messages/transcript | Ordered list, trimmed to the current Redis cap, expires with room | Append-only ordered rows; no TTL and no destructive trim |
| Tasks | Versioned board with room TTL | Versioned current board plus durable update timestamp |
| Minutes/report | Redis snapshot with 24-hour TTL | Immutable snapshot retained with its room |
| Receipts | Existing message/artifact representation and room TTL | Idempotent append keyed by `(room_id, receipt_id)` |

Immutable minutes and receipt replays use one recursive canonical JSON encoding
in both adapters, so top-level or nested object-key order cannot change whether
the same payload is accepted as an idempotent retry.

“Durable” means a committed record is visible after server-process restart and
after a clock advance beyond 25 hours. It does not mean undeletable: explicit
retention/deletion remains possible, auditable work outside this PR. Failed
transactions publish no partial room record. Per-room message sequence and
receipt uniqueness are database constraints rather than process memory.

## Postgres schema sketch

- `rooms(code primary key, topic, created_at, created_by, status, version,
  room_json, updated_at)`; compare-and-swap is `UPDATE ... WHERE version = ?`.
- `room_messages(room_code references rooms, sequence bigint, message_id,
  message_json, created_at, primary key(room_code, sequence), unique(room_code,
  message_id))`.
- `room_task_boards(room_code primary key references rooms, version,
  board_json, updated_at)`.
- `room_minutes(room_code, report_id, report_json, created_at,
  primary key(room_code, report_id))`.
- `room_receipts(room_code, receipt_id, receipt_json, created_at,
  primary key(room_code, receipt_id))`.

Participant state stays in the versioned room document in this slice so current
room compare-and-swap semantics remain one atomic write. JSON columns retain the
shared wire schema while relational keys enforce ownership, ordering, and
idempotency. Schema migrations are numbered SQL files and run explicitly; the
application does not auto-mutate production schema at request time.

## Migration and backfill

1. Deploy the seam with `redis` as the default; behavior and TTL stay unchanged.
2. Provision Postgres and explicitly run the reviewed schema migration with
   `npm run migrate:postgres -w packages/room-persistence`; application startup
   verifies the schema version and fails closed without mutating it.
3. Run a dry-run backfill that reads live Redis rooms and related keys, validates
   shared types, and reports counts/conflicts without writing.
4. Run an idempotent one-way backfill. Existing Postgres keys win only when the
   canonical payload matches; mismatches stop and surface a conflict.
5. Shadow-read and compare both adapters for a bounded window, without returning
   shadow data to callers.
6. Change the flag only after governance and hosting approval. Keep Redis for
   presence, rate limits, and turn coordination.

Rollback changes the selection flag back to Redis. It does not delete Postgres
records. There is no automatic dual-write in this slice because an uncoordinated
two-store write would create an ambiguous source of truth.

## Proof bar

- The existing Redis suite passes unchanged through the adapter and proves the
  24-hour expiry remains the default.
- A production-entry test selects Redis when the flag is absent.
- CI starts a local Postgres service, applies the numbered migration, creates a
  room through the production entry, restarts the server/store object, advances
  the clock 25 hours, and reads the same room, transcript, tasks, minutes, and
  receipt.
- Restored-defect kills cover adapter selection, restart persistence, 25-hour
  retention, message ordering, task CAS, and receipt idempotency.
- Tests use synthetic records. No hosted database, deployment, Railway setting,
  or secret is part of this PR.
