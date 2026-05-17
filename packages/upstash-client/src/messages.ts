import type { Message, MessageMetadata, RoleInTurn, InvocationType } from '@agent-room/shared';
import { MAX_MESSAGES_PER_ROOM, ROOM_TTL_SECONDS } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { findSpeaker, MutedError, NotYourTurnError, getRoom } from './rooms.js';
import {
  advanceOnTimeout,
  advanceTurn,
  casTurnState,
  consumeHostDirectedDetailed,
  isCurrentSpeaker,
  isHumanSender,
  moderatorReply,
  newModeratorTurn,
  newSequentialTurn,
  shouldStartNewTurn,
} from './turnState.js';

function msgsKey(code: string): string { return `room-msgs:${code}`; }
// Tracks the absolute count of messages ever appended to this room. Used by
// listMessages to translate an agent's logical cursor (= "I've consumed N
// messages so far") into the right LRANGE start position even after LTRIM has
// dropped the oldest entries. Without this, once the list crosses
// MAX_MESSAGES_PER_ROOM the index stored in the cursor stops mapping to the
// list slot the agent thinks it does, and agents silently MISS messages
// (witnessed: 499 in list, +2 RPUSH, LTRIM keeps last 500 → first new
// message is now at index 498, but cursor=499 LRANGEs from 499 and only
// returns the second new message). The counter key is INCRed in the same
// pipeline as RPUSH/LTRIM so it can never drift relative to the list.
function msgCountKey(code: string): string { return `room-msg-count:${code}`; }

/** Next poll cursor after a full `listMessages(..., 0)` when the room has a counter key; `null` = legacy room. */
export async function getMessageTotalCount(client: UpstashClient, code: string): Promise<number | null> {
  const countRaw = await client.command<unknown>(['GET', msgCountKey(code)]);
  if (countRaw === null || countRaw === undefined) return null;
  const totalCount = typeof countRaw === 'number' ? countRaw : parseInt(String(countRaw), 10);
  return Number.isFinite(totalCount) ? totalCount : null;
}

// Supplement-skip token. A supplement agent that has nothing to add MUST
// emit this exact string (after trim) — appendMessage detects it, advances
// the turn with status='no_addition', and does NOT append a message to the
// chat. Slice B does exact-match only; fuzzy matching ("无补充", "Nothing
// to add", etc.) is deferred to a later iteration once we have real prompt
// outputs to calibrate against.
export const NO_ADDITION_TOKEN = '__no_addition__';

// Result of a successful appendMessage call. `appended` is true for normal
// chat messages (the message ended up in the list); false for messages
// that were absorbed by the turn machinery (the supplement-skip token, or
// any future "swallowed" case). Callers like the MCP room_send handler use
// this to decide what hint to send back to the agent.
export interface AppendResult {
  appended: boolean;
  reason?: 'no_addition';
  // The metadata that ended up on the message (or, in the no_addition
  // case, the metadata that WOULD have been attached). Useful for
  // surfacing roleAtSend/turnId in the tool response.
  metadata: MessageMetadata;
}

// Append a message. Server-side gates, in order:
//   1. Mute gate: (name, client) must be a non-muted participant. Throws
//      MutedError otherwise.
//   2. Turn gate (sequential/moderator modes only): the sender must be the
//      current turn-holder, OR a human (web client / host), OR present in
//      the host-directed one-shot allowlist. Throws NotYourTurnError
//      otherwise.
//
// Side effects on success:
//   - Sequential mode: a human message kicks off a new turn if none is
//     active; an agent message advances the turn cursor. Lazy timeout
//     check runs first, silently skipping past expired speakers (callers
//     that want sys messages for those skips watch via the listen poll).
//   - Message metadata is enriched with modeAtSend / roleAtSend / turnId
//     / invocationType. Callers that pre-set message.metadata fields keep
//     them — server-side fields are merged in, server wins on conflict.
//   - Supplement-skip token (`__no_addition__`) advances the turn WITHOUT
//     appending a chat message; returns { appended: false, reason: 'no_addition' }.
export async function appendMessage(
  client: UpstashClient,
  code: string,
  message: Message
): Promise<AppendResult> {
  const room = await getRoom(client, code);
  if (!findSpeaker(room, message.name, message.client)) {
    throw new MutedError(message.name, room.createdBy);
  }
  const mode = room.replyMode ?? 'open';

  // Fast path: open mode. No turn machinery — preserves the legacy hot
  // path bit-for-bit so existing rooms see zero added latency.
  if (mode === 'open') {
    const metadata: MessageMetadata = {
      ...(message.metadata ?? {}),
      modeAtSend: 'open',
      roleAtSend: 'open',
      invocationType: message.metadata?.invocationType ?? 'normal_turn',
    };
    const enriched: Message = { ...message, metadata };
    await rpushMessage(client, code, enriched);
    return { appended: true, metadata };
  }

  // Non-open mode: validate and advance turn state atomically.
  // `casTurnState`'s mutator is synchronous and may throw NotYourTurnError
  // to reject — casTurnState re-throws non-Concurrency errors, which we
  // propagate up to the caller (MCP room_send turns this into
  // sent=false/not_your_turn).
  const text = message.text ?? '';
  const isSupplementSkipToken = text.trim() === NO_ADDITION_TOKEN;
  const decision: {
    roleAtSend: RoleInTurn;
    invocationType: InvocationType;
    turnId?: number;
    skipMessage: boolean;
  } = {
    roleAtSend: 'open',
    invocationType: 'normal_turn',
    skipMessage: false,
  };

  await casTurnState(client, code, (prev) => {
    // Lazy cleanup: skip any expired speakers before evaluating this
    // sender. Skipped sys messages are emitted by the listen poll, not
    // here — appendMessage is on the hot path and must not RPUSH a sys
    // event from inside a CAS mutator. We *do* update state.spoken so
    // the listen poll sees the skips and can emit the appropriate
    // events.
    const after = advanceOnTimeout(prev, room);
    let cur = after.state;

    if (isHumanSender(room, message.name, message.client)) {
      // Humans (web client or the host) are never turn-gated. If a new
      // turn should start, kick one off — sequential and moderator
      // modes each have their own initial-state shape.
      if (shouldStartNewTurn(cur, room)) {
        if (mode === 'sequential') {
          cur = newSequentialTurn(room, message.id);
        } else if (mode === 'moderator') {
          cur = newModeratorTurn(room, message.id);
          // Moderator mode requires a configured Moderator who is
          // currently present in the room. If we couldn't pick one,
          // newModeratorTurn returns null — the human message stands
          // alone and no agent is expected to reply. (The room remains
          // in moderator mode; sweepTimeouts will eventually auto-
          // fallback to open if this stays broken.)
        }
      }
      decision.roleAtSend = 'human';
      decision.invocationType = 'normal_turn';
      decision.turnId = cur?.turnId;
      return cur;
    }

    // cc agent (not the host) — must be the current speaker, or in the
    // host-directed allowlist.
    if (cur && isCurrentSpeaker(cur, message.name, message.client)) {
      const role = cur.currentRole!;
      const turnId = cur.turnId;
      decision.roleAtSend = role;
      decision.invocationType = 'normal_turn';
      decision.turnId = turnId;
      // Supplement-skip token: advance with status='no_addition', do NOT
      // append a chat message. Only meaningful for supplement-role
      // speakers; treat as a normal reply for the Lead (a Lead saying
      // `__no_addition__` would be confusing — we honor the token but
      // still advance with that explicit status so reports show it).
      if (isSupplementSkipToken) {
        decision.skipMessage = true;
        return advanceTurn(cur, 'no_addition', room);
      }
      // Moderator mode: Moderator-as-current keeps current after reply
      // (no queue pop). They route via room_direct_invoke; their
      // deadline resets each time they actually post a message.
      if (cur.mode === 'moderator' && role === 'moderator') {
        return moderatorReply(cur, room);
      }
      return advanceTurn(cur, 'replied', room);
    }
    if (cur) {
      const directed = consumeHostDirectedDetailed(cur, message.name, message.client);
      if (directed.consumed) {
        // Moderator dispatch ('assignee') vs host override
        // ('host_directed') are tracked separately for reporting.
        decision.roleAtSend = directed.source === 'moderator' ? 'assignee' : 'host_directed';
        decision.invocationType = directed.source === 'moderator' ? 'moderator_assigned' : 'host_directed';
        decision.turnId = cur.turnId;
        // Directed messages don't consume the main turn queue slot —
        // the named current speaker stays current. The mutated
        // hostDirected list (one entry popped) is what gets persisted.
        return cur;
      }
    }
    throw new NotYourTurnError(message.name, mode);
  });

  if (decision.skipMessage) {
    const metadata: MessageMetadata = {
      ...(message.metadata ?? {}),
      modeAtSend: mode,
      roleAtSend: decision.roleAtSend,
      invocationType: decision.invocationType,
      ...(decision.turnId !== undefined ? { turnId: decision.turnId } : {}),
    };
    return { appended: false, reason: 'no_addition', metadata };
  }

  const metadata: MessageMetadata = {
    ...(message.metadata ?? {}),
    modeAtSend: mode,
    roleAtSend: decision.roleAtSend,
    invocationType: decision.invocationType,
    ...(decision.turnId !== undefined ? { turnId: decision.turnId } : {}),
  };
  const enriched: Message = { ...message, metadata };
  await rpushMessage(client, code, enriched);
  return { appended: true, metadata };
}

// Internal helper: write a message to the Redis list, refreshing TTL and
// keeping the absolute-count counter in lockstep.
// INCR on the count key MUST sit in the same pipeline as RPUSH so the count
// stays in lock-step with the list — listMessages relies on the invariant
// `totalCount - listLen = number of LTRIMmed entries` to compensate cursors.
async function rpushMessage(client: UpstashClient, code: string, message: Message): Promise<void> {
  await client.pipeline([
    ['RPUSH', msgsKey(code), JSON.stringify(message)],
    ['INCR', msgCountKey(code)],
    ['LTRIM', msgsKey(code), -MAX_MESSAGES_PER_ROOM, -1],
    ['EXPIRE', msgsKey(code), ROOM_TTL_SECONDS],
    ['EXPIRE', msgCountKey(code), ROOM_TTL_SECONDS],
  ]);
}

// Append a server-originated system message. Bypasses the speaker/mute/turn
// gates because system messages are not sent by a participant — they are
// emitted by the server itself in response to events like mode changes,
// turn timeouts, host-driven skips, or moderator fallbacks. Callers should
// set `message.type = 'sys'` and use a synthetic sender (typically
// `name: 'system'`, `client: 'cc'`). The room must still exist; we hit
// getRoom() to refresh TTL and keep the count key aligned with the list.
export async function appendSystemMessage(
  client: UpstashClient,
  code: string,
  message: Message
): Promise<void> {
  await getRoom(client, code); // throws RoomNotFoundError if the room is gone
  await rpushMessage(client, code, message);
}

// Cursor semantics: `fromIndex` is the absolute count of messages the caller
// has already consumed (0 on first call, advanced by `msgs.length` after
// each call). It is NOT a list-index — the on-disk list shifts whenever
// LTRIM trims the head, so a list-index cursor would skip messages past
// MAX_MESSAGES_PER_ROOM. The counter key + LLEN let us reconstruct where the
// caller's next unread message actually lives in the (possibly trimmed) list.
export async function listMessages(
  client: UpstashClient,
  code: string,
  fromIndex: number
): Promise<Message[]> {
  // One pipeline: ask for both the absolute count and the current list length.
  // count===null means this is a legacy room created before the counter was
  // introduced — fall back to treating fromIndex as a list-index (matches
  // pre-fix behavior; still buggy past 500 messages but no worse than before
  // and avoids breaking in-flight conversations during the rollout).
  const meta = await client.pipeline<unknown>([
    ['GET', msgCountKey(code)],
    ['LLEN', msgsKey(code)],
  ]);
  const countRaw = meta[0] as string | number | null;
  const listLen = Number(meta[1] ?? 0);
  if (listLen === 0) return [];

  let start: number;
  if (countRaw === null || countRaw === undefined) {
    start = fromIndex;
  } else {
    const totalCount = typeof countRaw === 'number' ? countRaw : parseInt(countRaw, 10);
    // `trimmed` is the number of head entries LTRIM has dropped over this
    // room's lifetime. Subtracting it from the agent's absolute cursor
    // gives the right list-index for the next unread message.
    const trimmed = totalCount - listLen;
    start = fromIndex - trimmed;
    // If the agent's cursor lags so far that messages it never saw have
    // already been LTRIMmed away, the best we can do is hand back the
    // surviving prefix from index 0 — those older messages are gone for
    // good (LTRIM is destructive; the report/minutes export is the only
    // way to recover full transcripts past the cap).
    if (start < 0) start = 0;
  }

  if (start >= listLen) return [];
  const raw = await client.command<string[]>(['LRANGE', msgsKey(code), start, -1]);
  return raw.map(line => JSON.parse(line) as Message);
}
