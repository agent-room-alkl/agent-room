// Project memory: durable, cross-room knowledge accumulated from per-room
// memory extractions (room_summaries.memory). The core constraint is that
// memory must be MERGED, not appended — append-only project memory grows
// unboundedly, keeps overturned decisions alive, and poisons future rooms.
//
// This module is pure logic (no I/O) so the API layer, MCP server, and tests
// can all share the exact same merge semantics. It is deliberately shaped
// like mem0's update/dedupe model so a real mem0 (or LLM-assisted) merger can
// replace `mergeProjectMemory` later without touching callers.

/** Per-room extraction, as produced by the room-summary haiku call. */
export interface RoomMemory {
  facts: string[];
  decisions: string[];
  deliverables: string[];
  preferences: string[];
  open_questions: string[];
  /** Approaches that failed, pitfalls hit, alternatives rejected and why. */
  lessons: string[];
}

export const MEMORY_CATEGORIES = [
  'facts',
  'decisions',
  'deliverables',
  'preferences',
  'open_questions',
  'lessons',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** One remembered item, with provenance so newer knowledge can win. */
export interface MemoryEntry {
  text: string;
  /** Room the item was learned in. */
  sourceRoom: string;
  /** ISO timestamp of when the item was learned (room end). */
  at: string;
}

/** Accumulated project-level memory (stored as jsonb on the project). */
export interface ProjectMemory {
  version: 1;
  facts: MemoryEntry[];
  decisions: MemoryEntry[];
  deliverables: MemoryEntry[];
  preferences: MemoryEntry[];
  open_questions: MemoryEntry[];
  lessons: MemoryEntry[];
}

/** Hard cap per category in storage; lists are kept newest-first. */
export const MAX_ENTRIES_PER_CATEGORY = 40;

/** Rooms in these categories are platform noise, not project knowledge. */
const EXCLUDED_CATEGORIES = new Set(['product_test', 'demo', 'abandoned']);

/**
 * Should this room's memory be persisted into its project?
 * Noise categories are excluded, EXCEPT when the room actually delivered —
 * a miscategorized room that produced real output keeps its memory.
 *
 * NOTE: no longer applied to project-ATTACHED rooms — attaching a room to a
 * project is an explicit user signal, so their memory always sinks (founder
 * decision 2026-07-08). Kept for advisory use (e.g. surfacing which archives
 * are worth importing).
 */
export function shouldPersistMemory(input: {
  category: string | null;
  delivered: boolean | null;
}): boolean {
  if (!input.category) return true;
  if (!EXCLUDED_CATEGORIES.has(input.category)) return true;
  return input.delivered === true;
}

/** Clamp an untrusted jsonb value into a well-formed RoomMemory (or null). */
export function normalizeRoomMemory(raw: unknown): RoomMemory | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [];
  const memory: RoomMemory = {
    facts: list(obj.facts),
    decisions: list(obj.decisions),
    deliverables: list(obj.deliverables),
    preferences: list(obj.preferences),
    open_questions: list(obj.open_questions),
    lessons: list(obj.lessons),
  };
  const empty = MEMORY_CATEGORIES.every(c => memory[c].length === 0);
  return empty ? null : memory;
}

export function emptyProjectMemory(): ProjectMemory {
  return { version: 1, facts: [], decisions: [], deliverables: [], preferences: [], open_questions: [], lessons: [] };
}

/** Parse an untrusted jsonb value into a ProjectMemory, dropping junk. */
export function normalizeProjectMemory(raw: unknown): ProjectMemory {
  const memory = emptyProjectMemory();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return memory;
  const obj = raw as Record<string, unknown>;
  for (const category of MEMORY_CATEGORIES) {
    const list = obj[category];
    if (!Array.isArray(list)) continue;
    memory[category] = list
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
      .map(e => ({
        text: typeof e.text === 'string' ? e.text : '',
        sourceRoom: typeof e.sourceRoom === 'string' ? e.sourceRoom : '',
        at: typeof e.at === 'string' ? e.at : '',
      }))
      .filter(e => e.text.trim().length > 0);
  }
  return memory;
}

// Dedupe key: case-insensitive, whitespace-collapsed, trailing punctuation
// stripped. Catches "restated the same fact slightly differently" across
// rooms without needing embeddings.
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[。．.!！?？;；,，]+$/g, '')
    .trim();
}

function entryTime(entry: MemoryEntry): number {
  const t = Date.parse(entry.at);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Merge one room's extraction into the accumulated project memory.
 * Semantics (mem0-style update, not append):
 *  - normalized-duplicate items collapse to one entry; the newer occurrence
 *    wins provenance, the longer text survives (restatements usually add detail)
 *  - one entry containing another (normalized) also collapses to the longer one
 *  - lists are newest-first and capped at MAX_ENTRIES_PER_CATEGORY (oldest drop)
 *  - an open question is CLOSED when a new fact/decision/deliverable contains
 *    its normalized text (the answer subsumes the question)
 * Pure function: never mutates its inputs.
 */
export function mergeProjectMemory(
  existing: ProjectMemory,
  incoming: RoomMemory,
  source: { roomCode: string; at: string }
): ProjectMemory {
  const merged = emptyProjectMemory();

  for (const category of MEMORY_CATEGORIES) {
    const fresh: MemoryEntry[] = (incoming[category] ?? [])
      .filter(text => text.trim().length > 0)
      .map(text => ({ text: text.trim(), sourceRoom: source.roomCode, at: source.at }));
    merged[category] = dedupeEntries([...fresh, ...existing[category]]);
  }

  // Close open questions that new knowledge subsumes.
  const answers = [...merged.facts, ...merged.decisions, ...merged.deliverables]
    .map(e => normalizeText(e.text));
  merged.open_questions = merged.open_questions.filter(q => {
    const qNorm = normalizeText(q.text);
    return !answers.some(a => a.includes(qNorm));
  });

  for (const category of MEMORY_CATEGORIES) {
    merged[category] = merged[category]
      .sort((a, b) => entryTime(b) - entryTime(a))
      .slice(0, MAX_ENTRIES_PER_CATEGORY);
  }
  return merged;
}

function dedupeEntries(entries: MemoryEntry[]): MemoryEntry[] {
  const kept: MemoryEntry[] = [];
  for (const entry of entries) {
    const norm = normalizeText(entry.text);
    if (!norm) continue;
    const clashIdx = kept.findIndex(k => {
      const kNorm = normalizeText(k.text);
      return kNorm === norm || kNorm.includes(norm) || norm.includes(kNorm);
    });
    if (clashIdx === -1) {
      kept.push(entry);
      continue;
    }
    const clash = kept[clashIdx]!;
    // Longer text survives; newer provenance wins.
    const text = entry.text.length >= clash.text.length ? entry.text : clash.text;
    const newer = entryTime(entry) >= entryTime(clash) ? entry : clash;
    kept[clashIdx] = { text, sourceRoom: newer.sourceRoom, at: newer.at };
  }
  return kept;
}

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  facts: 'Facts',
  decisions: 'Decisions',
  deliverables: 'Deliverables',
  preferences: 'User preferences & constraints',
  open_questions: 'Open questions / TODO',
  lessons: 'Lessons & pitfalls',
};

/**
 * Render project memory as prompt-injectable markdown, newest-first, top-K
 * per category, hard-capped at maxChars. Used identically by the hosted-agent
 * prompt assembly and the MCP context payload so both agent kinds see the
 * same knowledge.
 */
export function renderProjectMemory(
  memory: ProjectMemory,
  opts: { maxChars?: number; perCategory?: number } = {}
): string {
  const maxChars = opts.maxChars ?? 4000;
  const perCategory = opts.perCategory ?? 8;
  const sections: string[] = [];
  for (const category of MEMORY_CATEGORIES) {
    const entries = memory[category].slice(0, perCategory);
    if (!entries.length) continue;
    const lines = entries.map(e => `- ${e.text}`);
    sections.push(`### ${CATEGORY_LABELS[category]}\n${lines.join('\n')}`);
  }
  if (!sections.length) return '';
  let out = sections.join('\n\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
}
