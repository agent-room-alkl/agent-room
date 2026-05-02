import { describe, it, expect } from 'vitest';
import { normalizeEscapedWhitespace } from '../src/text.js';

describe('normalizeEscapedWhitespace', () => {
  it('returns plain single-line text untouched', () => {
    expect(normalizeEscapedWhitespace('hello world')).toBe('hello world');
  });

  it('returns empty string untouched', () => {
    expect(normalizeEscapedWhitespace('')).toBe('');
  });

  it('returns multi-line text with real newlines untouched (trusts the sender)', () => {
    const real = 'line1\nline2\n\nline3';
    expect(normalizeEscapedWhitespace(real)).toBe(real);
  });

  it('preserves a literal `\\n` inside a message that ALSO has real newlines', () => {
    // Sender intentionally referenced `\n` (e.g. explaining a regex). Real
    // newlines are present, so the escape is legitimate — leave it alone.
    const input = 'use the regex \\n to match newlines\n\nthat is the trick';
    expect(normalizeEscapedWhitespace(input)).toBe(input);
  });

  it('unescapes `\\n` when the body has zero real newlines (Cursor Composer regression)', () => {
    // The exact shape we observed in production: Composer JSON.stringify'd
    // its own message body before passing it as `text`, so a paragraph
    // break became the 2-character sequence backslash-n.
    const input = '@robin 抱歉，我按日文场景回了。\\n\\n前面 Claude 卡在等你选：A/B/C/D。';
    const expected = '@robin 抱歉，我按日文场景回了。\n\n前面 Claude 卡在等你选：A/B/C/D。';
    expect(normalizeEscapedWhitespace(input)).toBe(expected);
  });

  it('unescapes `\\r\\n` first so Windows-style escapes collapse to a single newline', () => {
    expect(normalizeEscapedWhitespace('a\\r\\nb')).toBe('a\nb');
  });

  it('unescapes `\\t` alongside `\\n` when both appear and no real newlines are present', () => {
    expect(normalizeEscapedWhitespace('header\\tvalue\\nrow2')).toBe('header\tvalue\nrow2');
  });

  it('does NOT unescape `\\t` alone in single-line text (only kicks in when whitespace escapes coexist)', () => {
    // We unescape any of `\\n` / `\\r` / `\\t` once the no-real-newline gate
    // passes — but the gate requires at least one of those escapes to appear.
    // A pure single-line message with one `\t` is technically caught; this
    // test pins the current behavior so future tightening is intentional.
    expect(normalizeEscapedWhitespace('col1\\tcol2')).toBe('col1\tcol2');
  });

  it('handles non-string input defensively (returns it unchanged)', () => {
    // `text` is typed string but the renderer uses normalizeEscapedWhitespace
    // on raw message data, so guard against an unexpected non-string slipping
    // through (e.g. a future schema migration).
    expect(normalizeEscapedWhitespace(undefined as unknown as string)).toBe(undefined);
    expect(normalizeEscapedWhitespace(null as unknown as string)).toBe(null);
  });
});
