import type {
  Room,
  Participant,
  ReplyMode,
  ReplyModeConfig,
} from '@agent-room/shared';
import { AVATAR_PALETTE, ROOM_TTL_SECONDS } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { RoomNotFoundError, ConcurrencyError } from './errors.js';

function roomKey(code: string): string { return `room:${code}`; }

// 32 hex chars (~128 bits). Stored on the host's sessionStorage; only the
// SHA-256 hash of this key lands on the server (`Room.hostKeyHash`) so a
// passive Redis dump doesn't leak the secret.
function generateHostKey(): string {
  const bytes = new Uint8Array(16);
  // Browsers, Workers, and modern Node all expose globalThis.crypto.
  const cryptoObj: Crypto = (globalThis as unknown as { crypto: Crypto }).crypto;
  cryptoObj.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const cryptoObj: Crypto = (globalThis as unknown as { crypto: Crypto }).crypto;
  const buf = await cryptoObj.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

export interface CreateRoomInput {
  code: string;
  topic: string;
  createdBy: string;
  ownerId?: string;
  ownerEmail?: string;
  ownerName?: string;
}

// createRoom now returns the Room PLUS a one-time `hostKey`. The host stores
// hostKey in sessionStorage and presents it to verifyHostKey on any future
// (name === createdBy) join. Returning a flat shape (Room intersection,
// not a wrapper object) keeps existing callers working — they were already
// reading `room.code`, `room.participants`, etc., and those still work.
// New, host-aware callers destructure `hostKey` off the same value.
export type CreateRoomResult = Room & { hostKey: string };

export async function createRoom(client: UpstashClient, input: CreateRoomInput): Promise<CreateRoomResult> {
  const now = Date.now();
  const hostKey = generateHostKey();
  const room: Room = {
    code: input.code,
    topic: input.topic,
    createdAt: now,
    createdBy: input.createdBy,
    ownerId: input.ownerId,
    ownerEmail: input.ownerEmail,
    ownerName: input.ownerName,
    status: 'active',
    version: 1,
    participants: [],
    hostKeyHash: await sha256Hex(hostKey),
    // Default: open mode. Host can switch to 'sequential' / 'moderator' via
    // setReplyMode(). Stored explicitly (rather than relying on the
    // undefined-means-open fallback) so newly created rooms surface the
    // field on the very first room_join response — clients can render the
    // mode chip without waiting for a setReplyMode round-trip.
    replyMode: 'open',
  };
  await client.command(['SET', roomKey(input.code), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS]);
  return { ...room, hostKey };
}

export async function getRoom(client: UpstashClient, code: string): Promise<Room> {
  const raw = await client.command<string | null>(['GET', roomKey(code)]);
  if (raw === null || raw === undefined) throw new RoomNotFoundError(code);
  return JSON.parse(raw) as Room;
}

const CAS_MAX_ATTEMPTS = 3;

export async function casRoom(
  client: UpstashClient,
  code: string,
  mutator: (current: Room) => Room
): Promise<Room> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const current = await getRoom(client, code);
    let next: Room;
    try {
      next = mutator(current);
    } catch (e) {
      if (e instanceof ConcurrencyError) {
        lastError = e;
        continue;
      }
      throw e;
    }
    // Optimistic write: bump version. Full atomic CAS is deferred — a stale-read-then-overwrite
    // window is acceptable here because the only mutable field is `participants`, and messages
    // (the hot path) use atomic RPUSH. Version bumps make drift visible if it ever matters.
    next.version = current.version + 1;
    await client.command(['SET', roomKey(code), JSON.stringify(next), 'EX', ROOM_TTL_SECONDS]);
    return next;
  }
  throw lastError instanceof ConcurrencyError ? lastError : new ConcurrencyError();
}

// Thrown when a non-host tries to claim the host's display name. The room
// rejects rather than auto-suffixing because impersonation of the host has
// outsized blast radius — agents trust host instructions.
export class HostNameTakenError extends Error {
  constructor(host: string) {
    super(`The name "${host}" is reserved for the room host. Please pick a different display name.`);
    this.name = 'HostNameTakenError';
  }
}

// Identity is (name, client). Same name + same client from the same logical
// session is idempotent (browser refresh / agent reconnect just refreshes
// presence). Two important rules layered on top:
//
// 1. Host-name lock: if `participant.name === room.createdBy`, the caller
//    must present the matching `hostKey`. Without it, we throw
//    HostNameTakenError. This is what stops "anyone with the code can
//    impersonate the host".
//
// 2. Non-host name collision: if any other participant already uses the same
//    visible room name and the caller hasn't shown they own the original seat
//    (no shared client identity yet — see Tier B), we auto-suffix "(2)" /
//    "(3)" so two real humans or agents named "Robin" stay distinguishable.
//
// `priorIdentity` is the caller's previous (name, client) tuple if any —
// the web client passes its sessionStorage entry so a refresh on /r/CODE
// still updates the same row instead of getting a "(2)" suffix.
export interface JoinRoomOptions {
  hostKey?: string;
  // Set to the caller's prior identity in the room (from sessionStorage / MCP
  // state). When provided AND it matches an existing participant, that row
  // gets updated in place. Without it, the join is treated as fresh and
  // collisions get suffixed.
  priorIdentity?: { name: string; client: 'web' | 'cc' };
}

// Returns the updated Room with an extra `participant` field showing the
// final, possibly-renamed participant tuple ("Robin (2)" if a name collision
// was suffixed). Existing callers reading `result.participants` etc. still
// work; new callers can read `result.participant.name` to learn what name
// was actually assigned.
export type JoinRoomResult = Room & { participant: Participant };

function isPriorIdentity(
  p: Participant,
  priorIdentity: JoinRoomOptions['priorIdentity'],
): boolean {
  return Boolean(priorIdentity && p.name === priorIdentity.name && p.client === priorIdentity.client);
}

function uniqueNameForRoom(
  desiredName: string,
  current: Room,
  priorIdentity: JoinRoomOptions['priorIdentity'],
): string {
  const taken = new Set(
    current.participants
      .filter(p => !isPriorIdentity(p, priorIdentity))
      .map(p => p.name),
  );
  if (!taken.has(desiredName) || desiredName === current.createdBy) return desiredName;

  let n = 2;
  let candidate = `${desiredName} (${n})`;
  while (taken.has(candidate)) candidate = `${desiredName} (${++n})`;
  return candidate;
}

function uniqueColorForRoom(
  desiredColor: string,
  current: Room,
  priorIdentity: JoinRoomOptions['priorIdentity'],
): string {
  const used = new Set(
    current.participants
      .filter(p => !isPriorIdentity(p, priorIdentity))
      .map(p => p.color),
  );
  if (!used.has(desiredColor)) return desiredColor;
  return AVATAR_PALETTE.find(color => !used.has(color)) ?? desiredColor;
}

export async function joinRoom(
  client: UpstashClient,
  code: string,
  participant: Participant,
  options: JoinRoomOptions = {}
): Promise<JoinRoomResult> {
  let outParticipant = participant;
  const room = await casRoom(client, code, (current) => {
    let next = { ...participant };
    const isClaimingHost = participant.name === current.createdBy;

    if (isClaimingHost) {
      // The host slot is gated by hostKey, but the verification is async
      // (crypto.subtle.digest) so it can't run inside this synchronous
      // mutator. Callers MUST call verifyHostKey() first when they intend
      // to claim the host name; that pre-flight throws HostNameTakenError
      // if the key is wrong. Reaching this branch means the caller has
      // already proven they own the host slot.
    } else {
      // Non-host name collision: names are room-visible labels, so keep
      // them unique across client kinds too (web Robin vs agent Robin).
      // priorIdentity bypasses the suffix when the caller is updating their
      // own previous row.
      next = { ...next, name: uniqueNameForRoom(participant.name, current, options.priorIdentity) };
    }

    next = {
      ...next,
      color: uniqueColorForRoom(next.color, current, options.priorIdentity),
    };

    // Default canSpeak: TRUE for everyone (host, agents, walk-ins). The
    // earlier "host approves new joiners" gate added too much friction —
    // someone joining a fast-moving conversation had to wait for the host
    // to notice and click ✓ before they could even ack a message. Robin's
    // new framing: "进入都自动允许发言 但是只有主持人才可以关闭某个参会
    // 的 agent 或着 web 的发言也就是静音". Same Slack/Zoom mental model.
    //
    // Once joined, the host can mute (canSpeak → false) any participant
    // via setMuted(); muted participants stay in the room (presence intact,
    // can read) but room_send is rejected by appendMessage's findSpeaker
    // gate. Unmute is just setMuted(..., false) flipping it back.
    if (next.canSpeak === undefined) {
      next = { ...next, canSpeak: true };
    }
    // Assigned AFTER the canSpeak materialization so the returned
    // `outParticipant` reflects the final stored row, including its
    // approval state (callers like the MCP room_join handler look at this
    // to tell the agent whether it can speak immediately).
    outParticipant = next;

    // Replace the row matching priorIdentity if given, otherwise replace by
    // the (final) (name, client) tuple. This makes refreshes idempotent
    // without losing earlier presence data.
    const keep = current.participants.filter(p => {
      if (options.priorIdentity
        && p.name === options.priorIdentity.name
        && p.client === options.priorIdentity.client) return false;
      return !(p.name === next.name && p.client === next.client);
    });

    return { ...current, participants: [...keep, next] };
  });

  return { ...room, participant: outParticipant };
}

// Pre-flight check used by callers that intend to join with the host's name.
// Returns the verified room or throws HostNameTakenError. After this check,
// callers proceed to joinRoom() which trusts that the host claim was
// validated. Splitting verify+write avoids putting async crypto work inside
// the synchronous CAS mutator above.
export async function verifyHostKey(
  client: UpstashClient,
  code: string,
  hostKey: string | undefined,
): Promise<void> {
  const room = await getRoom(client, code);
  // Legacy rooms created before hostKeyHash existed: allow any claim. New
  // rooms (post this change) must always present a key.
  if (!room.hostKeyHash) return;
  if (!hostKey) throw new HostNameTakenError(room.createdBy);
  const hash = await sha256Hex(hostKey);
  if (hash !== room.hostKeyHash) throw new HostNameTakenError(room.createdBy);
}

// Mute or unmute a participant. Host-only. Mute flips `canSpeak` to false
// and the next room_send by that participant returns a MutedError;
// presence (visibility, ability to read) is unaffected. Unmute flips back
// to true. Idempotent — calling with the same value bumps version but is
// a no-op for the participant row.
export async function setMuted(
  client: UpstashClient,
  code: string,
  requesterName: string,
  targetName: string,
  targetClient: 'web' | 'cc',
  muted: boolean,
): Promise<Room> {
  return casRoom(client, code, (current) => {
    if (current.createdBy !== requesterName) {
      throw new NotHostError(requesterName, current.createdBy);
    }
    return {
      ...current,
      participants: current.participants.map(p =>
        (p.name === targetName && p.client === targetClient)
          ? { ...p, canSpeak: !muted }
          : p,
      ),
    };
  });
}

/**
 * @deprecated Use `setMuted(..., false)`. Kept as a thin alias so older
 * callers still compile while we migrate the web UI to the mute toggle.
 */
export function approveParticipant(
  client: UpstashClient,
  code: string,
  requesterName: string,
  targetName: string,
  targetClient: 'web' | 'cc',
): Promise<Room> {
  return setMuted(client, code, requesterName, targetName, targetClient, false);
}

// Server-side check: is this (name, client) tuple a participant who's been
// approved to speak? Returns the participant on success, null on miss.
// Treats `canSpeak === undefined` as approved (legacy rooms without the
// field). All new joiners flow through joinRoom which always sets the
// field, so undefined only appears for participants from before this code
// landed.
export function findSpeaker(
  room: Room,
  name: string,
  clientKind: 'web' | 'cc',
): Participant | null {
  const p = room.participants.find(x => x.name === name && x.client === clientKind);
  if (!p) return null;
  if (p.canSpeak === false) return null;
  return p;
}

// Set or clear reply-mode coordination on a room. Host-only. Switching
// modes mid-conversation is supported; any in-flight turn state is cleared.
//
// Validates that the right fields are present for the requested mode:
//   - 'open':       config can be empty / undefined
//   - 'sequential': leadAgentName + leadAgentClient required IF caller wants
//                   a non-default Lead; otherwise the room falls back to
//                   "first cc-client agent in join order" at turn time.
//                   Callers are encouraged to specify, but it's not enforced
//                   here so UI can offer a "start sequential with first agent
//                   as Lead" shortcut without forcing a selection.
//   - 'moderator':  moderatorAgentName + moderatorAgentClient REQUIRED —
//                   moderator mode is meaningless without a routing agent.
export class InvalidModeConfigError extends Error {
  constructor(mode: ReplyMode, missingField: string) {
    super(`replyMode='${mode}' requires modeConfig.${missingField}.`);
    this.name = 'InvalidModeConfigError';
  }
}

export async function setReplyMode(
  client: UpstashClient,
  code: string,
  requesterName: string,
  mode: ReplyMode,
  config: ReplyModeConfig | undefined,
): Promise<Room> {
  const updated = await casRoom(client, code, (current) => {
    if (current.createdBy !== requesterName) {
      throw new NotHostError(requesterName, current.createdBy);
    }
    if (mode === 'moderator') {
      if (!config?.moderatorAgentName || !config?.moderatorAgentClient) {
        throw new InvalidModeConfigError('moderator', 'moderatorAgentName + moderatorAgentClient');
      }
    }
    // Persist normalized config. For 'open' we still keep whatever the
    // caller passed (e.g. timeoutMs they pre-configured before switching
    // away from sequential) so a later switch back doesn't lose settings.
    return {
      ...current,
      replyMode: mode,
      modeConfig: config,
    };
  });
  // Any mode change aborts an in-flight turn. We do this as a best-effort
  // sibling write (not atomic with the room CAS) — the only failure mode
  // is "old turnState lingers", which the next human message will
  // overwrite via newSequentialTurn / moderator startup anyway. Keeping
  // it out of the CAS mutator avoids cyclic imports and keeps the room
  // module unaware of turnState internals.
  await client.command(['DEL', `turn-state:${code}`]);
  return updated;
}

/**
 * Thrown by `appendMessage` when the sender is not allowed to speak under
 * the current reply-mode turn state. Slice A never throws this; Slice B
 * begins throwing it in 'sequential' / 'moderator' rooms.
 */
export class NotYourTurnError extends Error {
  constructor(name: string, mode: ReplyMode) {
    super(`"${name}" is not allowed to speak right now (reply mode: ${mode}).`);
    this.name = 'NotYourTurnError';
  }
}

/**
 * Thrown by `appendMessage` when the sender's `canSpeak` is false —
 * either because the host muted them, or (legacy) because they joined a
 * pre-mute-model room that still defaulted non-host to false.
 */
export class MutedError extends Error {
  constructor(name: string, host: string) {
    super(`"${name}" has been muted by the host (${host}). Ask the host to unmute (🔊) to keep talking.`);
    this.name = 'MutedError';
  }
}

/** @deprecated Same shape as MutedError, kept for backward compat. */
export const NotApprovedError = MutedError;

// Remove a participant from the room. Only the host (createdBy) may kick.
// Upstash has no per-call auth so this is a soft guard inside the CAS — anyone
// with the REST token can still bypass it, but no path through the public web
// or MCP UI lets a non-host hit this. Identity is (name, client), same as
// joinRoom.
export class NotHostError extends Error {
  constructor(requester: string, host: string) {
    super(`Only the host (${host}) can remove participants — requester: ${requester}`);
    this.name = 'NotHostError';
  }
}

export async function removeParticipant(
  client: UpstashClient,
  code: string,
  requesterName: string,
  targetName: string,
  targetClient: 'web' | 'cc'
): Promise<Room> {
  return casRoom(client, code, (current) => {
    // Self-removal is always allowed — agents that finish their turn or
    // were told to leave call this with requesterName === targetName.
    // Removing someone else still requires the host slot.
    const isSelfRemoval = requesterName === targetName;
    if (!isSelfRemoval && current.createdBy !== requesterName) {
      throw new NotHostError(requesterName, current.createdBy);
    }
    return {
      ...current,
      participants: current.participants.filter(
        p => !(p.name === targetName && p.client === targetClient)
      ),
    };
  });
}

// Silent no-op if the named participant is not in the room. In practice the
// caller passes its own name from session state, so a miss means the user was
// removed externally — we just skip the heartbeat. version still bumps so
// drift remains visible if it ever matters.
export async function endRoom(
  client: UpstashClient,
  code: string,
): Promise<Room> {
  return casRoom(client, code, (current) => ({
    ...current,
    status: 'ended' as const,
    endedAt: Date.now(),
  }));
}

export async function reactivateRoom(
  client: UpstashClient,
  code: string,
): Promise<Room> {
  return casRoom(client, code, (current) => ({
    ...current,
    status: 'active' as const,
    endedAt: undefined,
  }));
}

export async function updatePresence(
  client: UpstashClient,
  code: string,
  name: string,
  at: number
): Promise<void> {
  await casRoom(client, code, (current) => ({
    ...current,
    participants: current.participants.map(p =>
      p.name === name ? { ...p, lastSeenAt: at } : p
    ),
  }));
}

// Stamp how long this participant intends to stay in their current room_listen
// window. Other participants can read this from the room's participant list
// to know who's actively listening vs just present-but-idle.
export async function setListenUntil(
  client: UpstashClient,
  code: string,
  name: string,
  until: number
): Promise<void> {
  await casRoom(client, code, (current) => ({
    ...current,
    participants: current.participants.map(p =>
      p.name === name ? { ...p, listenUntil: until, lastSeenAt: Date.now() } : p
    ),
  }));
}
