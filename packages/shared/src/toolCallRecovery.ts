// Recovering run_code calls that a model leaked into its TEXT channel.
//
// OpenAI-compatible providers are supposed to return tool calls in the
// structured `message.tool_calls` field. DeepSeek (deepseek-chat especially)
// intermittently serializes the call into `message.content` instead — its
// internal tool-call template tokens leak as plain text. When that happens
// `tool_calls` is empty, so the caller would (a) never run the code and (b)
// surface the raw markup as the agent's chat message. This module pulls the
// run_code invocation back out of the leaked text so the round can still run.
//
// Two leak shapes are handled:
//
//   1. Tag form (the one observed in the wild) — an invoke/parameter block
//      wrapped in special-token delimiters, e.g.
//        <｜｜DSML｜｜invoke name="run_code">
//          <｜｜DSML｜｜parameter name="code" string="true">print(1)</｜｜DSML｜｜parameter>
//          <｜｜DSML｜｜parameter name="language" string="true">python</｜｜DSML｜｜parameter>
//        </｜｜DSML｜｜invoke>
//      The delimiter junk varies, so the matchers key off the stable
//      `invoke name="..."` / `parameter name="..."` skeleton and ignore the
//      surrounding tokens.
//
//   2. JSON form — the function name followed by a fenced or bare JSON object
//      of arguments, e.g. DeepSeek's native
//        ...run_code\n```json\n{"language":"python","code":"print(1)"}\n```
//
// The parser is deliberately conservative: it only recognizes the `run_code`
// tool, returns nothing when it can't find a usable code body, and never
// throws.

export interface RecoveredRunCode {
  language: string;
  code: string;
  expose_port?: number;
  background?: boolean;
  deliver_path?: string;
}

export interface ToolCallRecovery {
  /** run_code invocations recovered from the leaked text, in document order. */
  calls: RecoveredRunCode[];
  /** The input with every recognized leaked-call block removed and trimmed.
   *  When the model emitted ONLY a leaked call this is '' — the caller should
   *  treat that like an empty reply (i.e. no chat message), not post markup. */
  cleaned: string;
}

// Markers that signal "this text contains a leaked tool call" — cheap pre-check
// so the regex work (and any cleanup) only runs on suspect content.
const LEAK_MARKERS = [
  'invoke name="run_code"',
  "invoke name='run_code'",
  'tool_calls',
  'tool▁call', // DeepSeek native token (▁ = U+2581)
  'tool_call',
  'DSML',
  'run_code',
];

export function looksLikeLeakedToolCall(content: string): boolean {
  if (!content) return false;
  // Require run_code to be present at all — without it there's nothing to run.
  if (!content.includes('run_code')) return false;
  return LEAK_MARKERS.some(m => content.includes(m));
}

// <…invoke name="run_code"…> … </…invoke> — tolerant of arbitrary delimiter
// junk both before `invoke` and between the `/` and `invoke` of the close tag
// (e.g. `</｜｜DSML｜｜invoke>`), and of either quote style.
const INVOKE_BLOCK = /<[^<>]*?invoke\s+name=["']run_code["'][^<>]*?>([\s\S]*?)<[^<>]*?\/[^<>]*?invoke[^<>]*?>/gi;
// <…parameter name="NAME"…>VALUE</…parameter> inside an invoke block.
const PARAM = /<[^<>]*?parameter\s+name=["']([^"']+)["'][^<>]*?>([\s\S]*?)<[^<>]*?\/[^<>]*?parameter[^<>]*?>/gi;

// `run_code` followed by a JSON object, optionally inside a ``` fence. The
// object must contain a "code" key for us to treat it as a real call.
const JSON_BLOCK = /run_code[\s\S]{0,40}?(\{[\s\S]*?"code"[\s\S]*?\})/gi;

function asFlags(raw: Record<string, unknown>): Omit<RecoveredRunCode, 'language' | 'code'> {
  const out: Omit<RecoveredRunCode, 'language' | 'code'> = {};
  const port = Number(raw.expose_port);
  if (Number.isFinite(port) && port > 0) out.expose_port = port;
  if (raw.background === true || raw.background === 'true') out.background = true;
  if (typeof raw.deliver_path === 'string' && raw.deliver_path.trim()) out.deliver_path = raw.deliver_path.trim();
  return out;
}

function fromTagForm(content: string): { calls: RecoveredRunCode[]; spans: Array<[number, number]> } {
  const calls: RecoveredRunCode[] = [];
  const spans: Array<[number, number]> = [];
  for (const m of content.matchAll(INVOKE_BLOCK)) {
    const inner = m[1] ?? '';
    const params: Record<string, unknown> = {};
    for (const p of inner.matchAll(PARAM)) {
      const key = p[1];
      if (key) params[key] = (p[2] ?? '').trim();
    }
    const code = typeof params.code === 'string' ? params.code : '';
    if (!code.trim()) continue; // nothing runnable — skip
    const language = typeof params.language === 'string' && params.language ? params.language : 'python';
    calls.push({ language, code, ...asFlags(params) });
    spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return { calls, spans };
}

function fromJsonForm(content: string): { calls: RecoveredRunCode[]; spans: Array<[number, number]> } {
  const calls: RecoveredRunCode[] = [];
  const spans: Array<[number, number]> = [];
  for (const m of content.matchAll(JSON_BLOCK)) {
    const json = m[1];
    if (!json) continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(json) as Record<string, unknown>; } catch { continue; }
    const code = typeof parsed.code === 'string' ? parsed.code : '';
    if (!code.trim()) continue;
    const language = typeof parsed.language === 'string' && parsed.language ? parsed.language : 'python';
    calls.push({ language, code, ...asFlags(parsed) });
    spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return { calls, spans };
}

// Strip residual special-token / wrapper junk left behind once the matched
// call blocks are cut out — stray `<｜…｜>` tokens, empty `<…tool_calls>`
// wrappers, etc. — so the surviving prose reads cleanly.
function scrubResidue(text: string): string {
  return text
    .replace(/<[^<>]*?\/?\s*tool_calls[^<>]*?>/gi, '')
    .replace(/<｜[^>]*?>/g, '')
    .replace(/<\/?｜?｜?\s*DSML[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function recoverLeakedRunCode(content: string): ToolCallRecovery {
  if (!looksLikeLeakedToolCall(content)) return { calls: [], cleaned: content };

  // Tag form is the higher-confidence shape; only fall back to the broad JSON
  // matcher when no invoke block was found, so a tag-form call with an inline
  // JSON-looking code body isn't double-counted.
  let { calls, spans } = fromTagForm(content);
  if (calls.length === 0) ({ calls, spans } = fromJsonForm(content));
  if (calls.length === 0) return { calls: [], cleaned: content };

  // Remove matched spans back-to-front so earlier indices stay valid.
  let cleaned = content;
  for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0])) {
    cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  }
  return { calls, cleaned: scrubResidue(cleaned) };
}
