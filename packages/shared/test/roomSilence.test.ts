import { describe, expect, it } from 'vitest';
import { CHAT_SILENCE_END_MS } from '../src/constants.js';
import { lastSpeechAt, shouldEndForChatSilence } from '../src/roomSilence.js';

describe('lastSpeechAt', () => {
  it('uses createdAt when there is no chat', () => {
    expect(lastSpeechAt([], 1000)).toBe(1000);
    expect(lastSpeechAt([{ type: 'sys', time: 2000 }], 1000)).toBe(1000);
  });

  it('returns the last type=msg time, skipping trailing sys lines', () => {
    expect(lastSpeechAt([
      { type: 'msg', time: 10 },
      { type: 'sys', time: 20 },
      { type: 'msg', time: 30 },
      { type: 'sys', time: 40 },
    ], 1)).toBe(30);
  });

  it('says unknown, not createdAt, when an incomplete window holds no chat', () => {
    expect(lastSpeechAt([{ type: 'sys', time: 2000 }], 1000, { incomplete: true })).toBeNull();
  });

  it('still answers from an incomplete window that does contain chat', () => {
    expect(lastSpeechAt([
      { type: 'msg', time: 30 },
      { type: 'sys', time: 40 },
    ], 1, { incomplete: true })).toBe(30);
  });
});

// The bug this file exists to prevent: the sweep reads only the tail of the
// transcript, so a long run of board sys lines used to bury the last real
// turn and the room was closed as if it had been silent since it opened.
describe('silence sweep against an incomplete read', () => {
  const LOOKBACK = 200; // api/cron/task-board-sweep.ts SILENCE_LOOKBACK
  const now = 10_000_000;
  const createdAt = now - 3 * 60 * 60 * 1000;   // opened 3h ago
  const lastChat = now - 5 * 60 * 1000;          // someone spoke 5 min ago

  function windowOf(sysCount: number) {
    const transcript = [
      { type: 'msg', time: lastChat },
      ...Array.from({ length: sysCount }, (_, i) => ({ type: 'sys', time: lastChat + (i + 1) * 1000 })),
    ];
    const read = transcript.slice(-LOOKBACK);
    return { read, incomplete: read.length >= LOOKBACK };
  }

  it('keeps a room that chatted 5 minutes ago but is buried under sys lines', () => {
    const { read, incomplete } = windowOf(LOOKBACK);
    expect(read.every(m => m.type === 'sys')).toBe(true); // chat pushed out of the window
    expect(incomplete).toBe(true);
    expect(shouldEndForChatSilence(lastSpeechAt(read, createdAt, { incomplete }), now)).toBe(false);
  });

  it('keeps a room whose chat is still inside the window', () => {
    const { read, incomplete } = windowOf(10);
    expect(shouldEndForChatSilence(lastSpeechAt(read, createdAt, { incomplete }), now)).toBe(false);
  });

  it('still ends a room that has genuinely been silent for 30 minutes', () => {
    const silentSince = now - CHAT_SILENCE_END_MS;
    const read = [
      { type: 'msg', time: silentSince },
      { type: 'sys', time: silentSince + 1000 },
    ];
    expect(shouldEndForChatSilence(lastSpeechAt(read, createdAt, { incomplete: false }), now)).toBe(true);
  });

  it('still ends an old room that never chatted, when the whole transcript was read', () => {
    // Complete read (complete) with no chat: createdAt is a real answer.
    expect(shouldEndForChatSilence(lastSpeechAt([], createdAt, { incomplete: false }), now)).toBe(true);
    expect(shouldEndForChatSilence(
      lastSpeechAt([{ type: 'sys', time: now - 1000 }], createdAt, { incomplete: false }),
      now,
    )).toBe(true);
  });

  it('keeps a freshly opened room that has not chatted yet', () => {
    const justOpened = now - 60_000;
    expect(shouldEndForChatSilence(lastSpeechAt([], justOpened, { incomplete: false }), now)).toBe(false);
  });
});

describe('shouldEndForChatSilence', () => {
  const spoken = 1_000_000;

  it('does not end an already-ended room', () => {
    expect(shouldEndForChatSilence(spoken, spoken + CHAT_SILENCE_END_MS, spoken + 1)).toBe(false);
  });

  it('does not end before the silence window', () => {
    expect(shouldEndForChatSilence(spoken, spoken + CHAT_SILENCE_END_MS - 1)).toBe(false);
  });

  it('ends at exactly 30 minutes of silence', () => {
    expect(shouldEndForChatSilence(spoken, spoken + CHAT_SILENCE_END_MS)).toBe(true);
  });
});
