// Character set for meeting codes — excludes 0 O I L 1 to avoid confusion
export const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_SEGMENT_LEN = 3;
export const CODE_SEGMENTS = 3;
export const CODE_LEN = CODE_SEGMENT_LEN * CODE_SEGMENTS;    // 9

// Room lifetime
export const ROOM_TTL_SECONDS = 24 * 60 * 60;                // 86400
/**
 * After this long with no chat (type=msg) from anyone, a host/cron may end
 * the room so MCP listen loops can stop. System/join lines do not reset the
 * clock. Any new chat reply does.
 */
export const CHAT_SILENCE_END_MS = 30 * 60 * 1000;

// Message cap
export const MAX_MESSAGES_PER_ROOM = 500;

// Polling cadence (ms)
export const MESSAGE_POLL_MS = 3000;
export const ROOM_POLL_MS = 5000;
/** When the browser tab is hidden, poll slower than foreground but still often enough that IDE-adjacent workflows feel responsive (not "stuck until tab switch"). */
export const MESSAGE_POLL_HIDDEN_MS = 4000;
export const ROOM_POLL_HIDDEN_MS = 4000;
export const HEARTBEAT_MS = 30000;
export const PRESENCE_STALE_MS = 60000;
// Past this many ms with no heartbeat AND no active listen window we treat
// the participant as disconnected — most likely they got killed mid-session
// without calling room_leave (Cursor / Codex sessions terminated by user
// just exit, never tell the room they're gone). UI surfaces this so the
// host can manually remove them.
export const PRESENCE_DISCONNECTED_MS = 5 * 60 * 1000;

// `listenUntil` is a LEASE, not a promise. An agent inside room_listen renews
// it every LISTEN_LEASE_RENEW_MS; the lease itself only runs LISTEN_LEASE_MS,
// so a client that dies mid-listen stops reading as "Listening" within one
// lease instead of for the whole listen window it once intended to stay for.
export const LISTEN_LEASE_MS = 15000;
export const LISTEN_LEASE_RENEW_MS = 5000;

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
