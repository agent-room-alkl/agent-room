// In-room context window: pinned seed + extractive digest of older turns +
// a short recent tail. Shared by hosted prompts and MCP join/listen/minutes
// so both carriers see the same shape. This is NOT project memory (the six
// categories) — those are cross-room and written at room end.

import type { ClientKind, Message, MessageAttachment, MessageKind } from './types.js';
import { safeAttachmentPromptText } from './security.js';

export const ROOM_RECENT_LIMIT = 16;
export const ROOM_DIGEST_MAX_CHARS = 1200;

/** Public attachment fields for MCP / digest. Never includes storageKey. */
export interface SlimAttachment {
  id: string;
  type: MessageAttachment['type'];
  url: string;
  name: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
  previewUrl?: string;
  extractedText?: string;
}

export interface SlimRoomMessage {
  name: string;
  text: string;
  time: number;
  client: ClientKind;
  type: MessageKind;
  role?: string;
  attachments?: SlimAttachment[];
}

export interface RoomContextView {
  seed: SlimRoomMessage | null;
  digest: string | null;
  recent: SlimRoomMessage[];
  olderCount: number;
}

const MARKER_RE = /\[(DECISION|TODO|RESULT|STATUS|BLOCKED|DONE)\]/i;
const MARKER_SPLIT_RE = /(?=\[(?:DECISION|TODO|RESULT|STATUS|BLOCKED|DONE)\])/i;

export function slimAttachment(a: MessageAttachment): SlimAttachment {
  const extractedText = safeAttachmentPromptText(a.name, a.mime, a.extractedText);
  return {
    id: a.id,
    type: a.type,
    url: a.url,
    name: a.name,
    size: a.size,
    mime: a.mime,
    ...(typeof a.width === 'number' ? { width: a.width } : {}),
    ...(typeof a.height === 'number' ? { height: a.height } : {}),
    ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}),
    ...(extractedText ? { extractedText } : {}),
  };
}

export function slimMessage(m: Pick<Message, 'name' | 'text' | 'time' | 'client' | 'type' | 'role' | 'attachments'>): SlimRoomMessage {
  const attachments = m.attachments?.length ? m.attachments.map(slimAttachment) : undefined;
  return {
    name: m.name,
    text: m.text,
    time: m.time,
    client: m.client,
    type: m.type,
    ...(m.role ? { role: m.role } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

export function splitRoomTranscript(
  messages: readonly Message[],
  recentLimit = ROOM_RECENT_LIMIT,
): { seed: Message | null; older: Message[]; recent: Message[] } {
  const chat = messages.filter(m => m.type === 'msg');
  const seedIdx = chat.findIndex(m => m.client === 'web');
  const seed = seedIdx >= 0 ? chat[seedIdx]! : null;
  const recent = chat.slice(-Math.max(1, recentLimit));
  const recentIds = new Set(recent.map(m => m.id));
  const older = chat.filter(m => !recentIds.has(m.id) && m !== seed);
  return { seed, older, recent };
}

function attachmentDigestNote(m: Pick<Message, 'attachments'>): string {
  return (m.attachments ?? [])
    .map(a => `[${a.type === 'image' ? 'IMAGE' : 'FILE'}: ${a.name}]`)
    .join(' ');
}

export function extractiveDigest(
  messages: readonly Message[],
  maxChars = ROOM_DIGEST_MAX_CHARS,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text = (m.text ?? '').replace(/\s+/g, ' ').trim();
    const attachNote = attachmentDigestNote(m);
    if (!text && !attachNote) continue;
    if (m.metadata?.roleAtSend === 'status') continue;
    const marked = text ? text.split(MARKER_SPLIT_RE).map(s => s.trim()).filter(s => MARKER_RE.test(s)) : [];
    if (marked.length) {
      for (const part of marked) lines.push(`${m.name}: ${part.slice(0, 180)}`);
      if (attachNote) lines.push(`${m.name}: ${attachNote}`);
    } else if (m.client === 'web' || attachNote) {
      const body = [text.slice(0, 140), attachNote].filter(Boolean).join(' ');
      lines.push(`${m.name}: ${body}`);
    }
  }
  if (!lines.length) {
    for (const m of messages.slice(-6)) {
      const text = (m.text ?? '').replace(/\s+/g, ' ').trim();
      const attachNote = attachmentDigestNote(m);
      const body = [text.slice(0, 120), attachNote].filter(Boolean).join(' ');
      if (body) lines.push(`${m.name}: ${body}`);
    }
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
}

export function buildRoomContextView(
  messages: readonly Message[],
  recentLimit = ROOM_RECENT_LIMIT,
): RoomContextView {
  const { seed, older, recent } = splitRoomTranscript(messages, recentLimit);
  const digest = older.length ? extractiveDigest(older) : '';
  return {
    seed: seed ? slimMessage(seed) : null,
    digest: digest || null,
    recent: recent.map(slimMessage),
    olderCount: older.length,
  };
}
