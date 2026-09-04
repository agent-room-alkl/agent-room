CREATE TABLE IF NOT EXISTS agent_room_schema_migrations (
  version integer PRIMARY KEY,
  applied_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_room_rooms (
  code text PRIMARY KEY,
  topic text NOT NULL,
  created_at bigint NOT NULL,
  created_by text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'ended')),
  version integer NOT NULL CHECK (version >= 1),
  room_json jsonb NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_room_messages (
  room_code text NOT NULL REFERENCES agent_room_rooms(code) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  message_id bigint NOT NULL,
  message_json jsonb NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (room_code, sequence),
  UNIQUE (room_code, message_id)
);

CREATE TABLE IF NOT EXISTS agent_room_task_boards (
  room_code text PRIMARY KEY REFERENCES agent_room_rooms(code) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  board_json jsonb NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_room_minutes (
  room_code text NOT NULL REFERENCES agent_room_rooms(code) ON DELETE CASCADE,
  report_id text NOT NULL,
  report_json jsonb NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (room_code, report_id)
);

CREATE TABLE IF NOT EXISTS agent_room_receipts (
  room_code text NOT NULL REFERENCES agent_room_rooms(code) ON DELETE CASCADE,
  receipt_id text NOT NULL,
  receipt_kind text NOT NULL CHECK (receipt_kind IN ('receipt', 'lease_event')),
  lease_event text CHECK (lease_event IS NULL OR lease_event IN
    ('granted', 'renewed', 'released', 'expired', 'handoff_requested')),
  receipt_json jsonb NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (room_code, receipt_id)
);

CREATE INDEX IF NOT EXISTS agent_room_messages_room_created_idx
  ON agent_room_messages(room_code, created_at);
CREATE INDEX IF NOT EXISTS agent_room_receipts_room_created_idx
  ON agent_room_receipts(room_code, created_at);

INSERT INTO agent_room_schema_migrations (version, applied_at)
VALUES (1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
ON CONFLICT (version) DO NOTHING;
