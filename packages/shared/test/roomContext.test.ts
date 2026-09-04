import { describe, expect, it } from 'vitest';
import type { Message } from '../src/types.js';
import {
  ROOM_RECENT_LIMIT,
  buildRoomContextView,
  extractiveDigest,
  slimMessage,
  splitRoomTranscript,
} from '../src/roomContext.js';

function msg(over: Partial<Message> & Pick<Message, 'text' | 'time'>): Message {
  return {
    id: over.id ?? over.time,
    type: over.type ?? 'msg',
    name: over.name ?? 'Robin',
    initials: 'RO',
    color: '#F59E0B',
    role: over.role ?? '',
    client: over.client ?? 'web',
    ...over,
  };
}

describe('splitRoomTranscript', () => {
  it('pins the first host message and keeps the last N as recent', () => {
    const messages = [
      msg({ time: 1, name: 'Robin', client: 'web', text: 'Build the digest window' }),
      ...Array.from({ length: 20 }, (_, i) =>
        msg({ time: i + 2, name: 'Agent', client: 'cc', text: `turn ${i + 2}` }),
      ),
    ];
    const { seed, older, recent } = splitRoomTranscript(messages, 16);
    expect(seed?.text).toBe('Build the digest window');
    expect(recent).toHaveLength(16);
    expect(recent[0]!.text).toBe('turn 6');
    expect(older.every(m => m.text !== 'Build the digest window')).toBe(true);
    expect(older).toHaveLength(4);
  });
});

describe('extractiveDigest', () => {
  it('prefers marked artifact lines and host speech', () => {
    const digest = extractiveDigest([
      msg({ time: 1, text: '[DECISION] Use a 16-message recent window' }),
      msg({ time: 2, name: 'Grok', client: 'cc', text: 'ok I will implement that' }),
      msg({ time: 3, text: 'Also keep the seed pinned' }),
    ]);
    expect(digest).toContain('[DECISION] Use a 16-message recent window');
    expect(digest).toContain('Also keep the seed pinned');
    expect(digest).not.toContain('ok I will implement that');
  });

  it('falls back to the last older lines when nothing is marked', () => {
    const digest = extractiveDigest([
      msg({ time: 1, name: 'Grok', client: 'cc', text: 'first pass on the board' }),
    ]);
    expect(digest).toContain('first pass on the board');
  });
});

describe('buildRoomContextView', () => {
  it('omits digest when everything still fits in recent', () => {
    const view = buildRoomContextView([
      msg({ time: 1, text: 'short room' }),
      msg({ time: 2, name: 'Grok', client: 'cc', text: 'ack' }),
    ]);
    expect(view.digest).toBeNull();
    expect(view.olderCount).toBe(0);
    expect(view.recent).toHaveLength(2);
    expect(view.seed?.text).toBe('short room');
  });

  it('adds digest once history exceeds the recent window', () => {
    const messages = [
      msg({ time: 1, text: 'pinned seed stays' }),
      msg({ time: 2, name: 'Grok', client: 'cc', text: '[DECISION] Use digest for older turns' }),
      ...Array.from({ length: ROOM_RECENT_LIMIT + 2 }, (_, i) =>
        msg({ time: i + 3, name: 'Grok', client: 'cc', text: `noise ${i}` }),
      ),
    ];
    const view = buildRoomContextView(messages);
    expect(view.olderCount).toBeGreaterThan(0);
    expect(view.seed?.text).toBe('pinned seed stays');
    expect(view.digest).toContain('[DECISION] Use digest for older turns');
    expect(view.recent).toHaveLength(ROOM_RECENT_LIMIT);
    expect(slimMessage(messages[0]!).name).toBe('Robin');
  });
});

describe('slimMessage attachments', () => {
  it('keeps public attachment fields and drops storageKey', () => {
    const slim = slimMessage(msg({
      time: 1,
      text: '',
      attachments: [{
        id: 'att-1',
        type: 'image',
        url: 'https://pub.example/shot.png',
        storageKey: 'rooms/ABC/images/att-1/shot.png',
        name: 'shot.png',
        size: 1200,
        mime: 'image/png',
        uploadedAt: 1,
        width: 800,
        height: 600,
      }],
    }));
    expect(slim.attachments).toEqual([{
      id: 'att-1',
      type: 'image',
      url: 'https://pub.example/shot.png',
      name: 'shot.png',
      size: 1200,
      mime: 'image/png',
      width: 800,
      height: 600,
    }]);
    expect(JSON.stringify(slim)).not.toContain('storageKey');
  });

  it('keeps safe document text and strips unsafe extractedText', () => {
    const notes = slimMessage(msg({
      time: 1,
      text: 'see file',
      attachments: [{
        id: 'n1',
        type: 'file',
        url: 'https://pub.example/notes.md',
        name: 'notes.md',
        size: 12,
        mime: 'text/markdown',
        uploadedAt: 1,
        extractedText: 'hello world',
      }],
    }));
    expect(notes.attachments?.[0]?.extractedText).toBe('hello world');

    const script = slimMessage(msg({
      time: 2,
      text: '',
      attachments: [{
        id: 's1',
        type: 'file',
        url: 'https://pub.example/index.js.txt',
        name: 'index.js.txt',
        size: 20,
        mime: 'text/plain',
        uploadedAt: 2,
        extractedText: 'spawn("node")',
      }],
    }));
    expect(script.attachments?.[0]?.extractedText).toBeUndefined();
  });
});

describe('extractiveDigest attachments', () => {
  it('keeps an image-only host drop in the digest', () => {
    const digest = extractiveDigest([
      msg({
        time: 1,
        text: '',
        attachments: [{
          id: 'img-1',
          type: 'image',
          url: 'https://pub.example/foundry.png',
          name: 'foundry.png',
          size: 10,
          mime: 'image/png',
          uploadedAt: 1,
        }],
      }),
    ]);
    expect(digest).toContain('[IMAGE: foundry.png]');
  });
});
