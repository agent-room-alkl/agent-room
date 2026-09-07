import { CODE_CHARS, CODE_SEGMENT_LEN, CODE_SEGMENTS } from './constants.js';

function randomChar(): string {
  const idx = Math.floor(Math.random() * CODE_CHARS.length);
  return CODE_CHARS[idx]!;
}

function segment(): string {
  let out = '';
  for (let i = 0; i < CODE_SEGMENT_LEN; i++) out += randomChar();
  return out;
}

export function generateCode(): string {
  const parts: string[] = [];
  for (let i = 0; i < CODE_SEGMENTS; i++) parts.push(segment());
  return parts.join('-');
}

const VALID_RE = new RegExp(
  `^[${CODE_CHARS}]{${CODE_SEGMENT_LEN}}(-[${CODE_CHARS}]{${CODE_SEGMENT_LEN}}){${CODE_SEGMENTS - 1}}$`
);

export function isValidCode(code: string): boolean {
  return VALID_RE.test(code);
}

const CODE_LEN = CODE_SEGMENT_LEN * CODE_SEGMENTS;

/**
 * Accept what an agent actually has in hand: a join URL, a lowercase code, a
 * code someone typed without dashes. Returns the canonical dashed code, or
 * null when the input holds no code at all.
 */
export function parseRoomCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  let candidate = input.trim();
  // A URL (with or without scheme): the code is the last path segment.
  const fromUrl = candidate.match(/(?:^|\/)(?:j|r)\/([^/?#\s]+)/i);
  if (fromUrl) candidate = fromUrl[1]!;
  else if (/[/?#]/.test(candidate)) candidate = candidate.split(/[?#]/)[0]!.split('/').filter(Boolean).pop() ?? '';
  const bare = candidate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (bare.length !== CODE_LEN) return null;
  const parts: string[] = [];
  for (let i = 0; i < CODE_SEGMENTS; i++) parts.push(bare.slice(i * CODE_SEGMENT_LEN, (i + 1) * CODE_SEGMENT_LEN));
  const code = parts.join('-');
  return isValidCode(code) ? code : null;
}
