// Defensive normalization for message text bodies coming in from clients
// that sometimes escape their own whitespace before passing it through
// `room_send`. Witnessed: Cursor's Composer agent occasionally JSON.stringify's
// its outgoing message body, so a real newline ('\n', 0x0A) gets stored as
// the two-character sequence backslash-n ("\\n"). The chat renderer then
// shows the user "\n" verbatim instead of a paragraph break.
//
// We can't fix this in Cursor, so we defend on both ends: the MCP `room_send`
// handler runs this on incoming text before append (so new messages are
// stored correctly), and the web Bubble component runs this on display
// (so messages already in Redis from before the fix landed render correctly
// too). Same function; safe to apply twice.
//
// Heuristic: if the text contains ANY real newline, we trust the sender —
// a legitimate `\n` literal (e.g. someone explaining a regex) inside a
// multi-paragraph message must not be molested. We only act when the text
// has zero real newlines AND at least one whitespace-style escape, which
// is the unambiguous "double-encoded" signal.
export function normalizeEscapedWhitespace(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  // Real newline anywhere → trust the sender.
  if (text.includes('\n') || text.includes('\r')) return text;
  // No suspicious escapes → nothing to do (fast path for short messages).
  if (!/\\[nrt]/.test(text)) return text;
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t');
}
