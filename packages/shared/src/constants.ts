// Character set for meeting codes — excludes 0 O I L 1 to avoid confusion
export const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_SEGMENT_LEN = 3;
export const CODE_SEGMENTS = 3;
export const CODE_LEN = CODE_SEGMENT_LEN * CODE_SEGMENTS;    // 9

// Room lifetime
export const ROOM_TTL_SECONDS = 24 * 60 * 60;                // 86400

// Message cap
export const MAX_MESSAGES_PER_ROOM = 500;

// Polling cadence (ms)
export const MESSAGE_POLL_MS = 3000;
export const ROOM_POLL_MS = 5000;
export const HEARTBEAT_MS = 30000;
export const PRESENCE_STALE_MS = 60000;
// Past this many ms with no heartbeat AND no active listen window we treat
// the participant as disconnected — most likely they got killed mid-session
// without calling room_leave (Cursor / Codex sessions terminated by user
// just exit, never tell the room they're gone). UI surfaces this so the
// host can manually remove them.
export const PRESENCE_DISCONNECTED_MS = 5 * 60 * 1000;

// Avatar palette — indigo/pink/amber/violet/emerald/rose/sky/fuchsia
export const AVATAR_PALETTE: readonly string[] = [
  '#5B6AFF',
  '#EC4899',
  '#F59E0B',
  '#8B5CF6',
  '#10B981',
  '#F43F5E',
  '#0EA5E9',
  '#D946EF',
];
