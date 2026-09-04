import { CHAT_SILENCE_END_MS } from './constants.js';

export interface SpeechStamp {
  type?: string;
  time?: number;
}

/**
 * Last type=msg timestamp.
 *
 * Callers read a bounded tail of the transcript, so "no chat in what I read"
 * is NOT the same claim as "this room has never spoken" — a busy task board
 * can bury the last human turn under a screenful of sys lines. Conflating the
 * two let the silence sweep fall back to `createdAt` and close rooms that had
 * spoken minutes earlier, so the two answers are now distinct:
 *
 *   - a number  — the real last-chat time, or `createdAt` when the caller saw
 *                 the WHOLE transcript and it genuinely holds no chat
 *   - null      — unknown: the window was incomplete and held no chat, so the
 *                 last chat may be just outside it
 *
 * Pass `incomplete: true` whenever what you read might not be the whole list —
 * the window came back full, an entry failed to parse, anything that could
 * have hidden a chat line. Unknown must never be treated as silence.
 */
export function lastSpeechAt(
  messages: readonly SpeechStamp[],
  createdAt: number,
  options: { incomplete?: boolean } = {},
): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.type === 'sys') continue;
    if (typeof m.time === 'number' && Number.isFinite(m.time)) return m.time;
  }
  // No chat in what we read. Only a complete transcript proves there is none.
  return options.incomplete ? null : createdAt;
}

/**
 * True when a live room has had no chat reply for CHAT_SILENCE_END_MS.
 *
 * `null` means the last chat time is unknown (see lastSpeechAt) and always
 * answers false: ending a live room is destructive and irreversible for the
 * agents inside it, so an unreadable window must fail towards keeping the
 * room open. The next sweep re-checks.
 */
export function shouldEndForChatSilence(
  lastSpeech: number | null,
  now: number,
  endedAt?: number | null,
): boolean {
  if (endedAt) return false;
  if (lastSpeech === null) return false;
  return now - lastSpeech >= CHAT_SILENCE_END_MS;
}
