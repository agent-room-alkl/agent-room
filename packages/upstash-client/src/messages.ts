import type { Message } from '@agent-room/shared';
import { MAX_MESSAGES_PER_ROOM, ROOM_TTL_SECONDS } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { findSpeaker, MutedError, getRoom } from './rooms.js';

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

// Append a message. Server-side gate: the (name, client) in the message
// must correspond to a participant whose `canSpeak` is not false. New
// joiners default to canSpeak=true (Slack/Zoom-style: speak first, host
// mutes if needed); the gate exists so a host-issued mute (setMuted)
// takes effect server-side, not just in the UI. Throws MutedError when
// the sender has been muted (or — legacy — joined an old room without a
// canSpeak set, in which case findSpeaker treats undefined as approved).
export async function appendMessage(
  client: UpstashClient,
  code: string,
  message: Message
): Promise<void> {
  const room = await getRoom(client, code);
  if (!findSpeaker(room, message.name, message.client)) {
    throw new MutedError(message.name, room.createdBy);
  }
  // Refresh TTL on every append so the message list expires alongside the room key
  // (spec §3.2). Without EXPIRE, the list key would orphan after room:{code} TTLs out.
  // INCR on the count key MUST sit in the same pipeline as RPUSH so the count
  // stays in lock-step with the list — listMessages relies on the invariant
  // `totalCount - listLen = number of LTRIMmed entries` to compensate cursors.
  await client.pipeline([
    ['RPUSH', msgsKey(code), JSON.stringify(message)],
    ['INCR', msgCountKey(code)],
    ['LTRIM', msgsKey(code), -MAX_MESSAGES_PER_ROOM, -1],
    ['EXPIRE', msgsKey(code), ROOM_TTL_SECONDS],
    ['EXPIRE', msgCountKey(code), ROOM_TTL_SECONDS],
  ]);
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
