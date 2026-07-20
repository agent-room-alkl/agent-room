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

// --- Near-duplicate detection (anti-parrot guard) ---------------------------
// Character-trigram Jaccard similarity. Trigrams rather than word tokens so
// CJK text — which has no word spaces — compares as well as Latin. Used by the
// hosted-agent reply path to drop a reply that merely re-states what another
// agent already posted this round: weaker models routinely ignore the "never
// restate" prompt rule, so the floor needs a server-side guard.
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const norm = s.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
    const out = new Set<string>();
    for (let i = 0; i <= norm.length - 3; i++) out.add(norm.slice(i, i + 3));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// True when `reply` adds nothing over `prior` — high trigram overlap. The
// 80-char floor keeps short acks and genuinely brief answers from tripping
// the guard (agreeing in one line is not parroting) while still catching
// CJK parrots: 80 Chinese characters carry a full paragraph of content, so a
// Latin-calibrated floor like 120 would let most Chinese restatements through.
export function isNearDuplicate(reply: string, prior: string, threshold = 0.55): boolean {
  if (reply.trim().length < 80 || prior.trim().length < 80) return false;
  return trigramSimilarity(reply, prior) >= threshold;
}
