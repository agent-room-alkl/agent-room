import { describe, expect, it } from 'vitest';
import {
  MAX_ENTRIES_PER_CATEGORY,
  emptyProjectMemory,
  mergeProjectMemory,
  normalizeProjectMemory,
  renderProjectMemory,
  shouldPersistMemory,
  type RoomMemory,
} from '../src/projectMemory.js';

const roomMemory = (over: Partial<RoomMemory> = {}): RoomMemory => ({
  facts: [],
  decisions: [],
  deliverables: [],
  preferences: [],
  open_questions: [],
  lessons: [],
  ...over,
});

describe('shouldPersistMemory', () => {
  it('keeps real work categories', () => {
    expect(shouldPersistMemory({ category: 'coding', delivered: false })).toBe(true);
    expect(shouldPersistMemory({ category: null, delivered: null })).toBe(true);
  });

  it('drops platform-noise categories', () => {
    for (const category of ['product_test', 'demo', 'abandoned']) {
      expect(shouldPersistMemory({ category, delivered: false })).toBe(false);
      expect(shouldPersistMemory({ category, delivered: null })).toBe(false);
    }
  });

  it('keeps noise categories that actually delivered', () => {
    expect(shouldPersistMemory({ category: 'demo', delivered: true })).toBe(true);
  });
});

describe('mergeProjectMemory', () => {
  const src1 = { roomCode: 'AAA-AAA-AAA', at: '2026-07-01T00:00:00Z' };
  const src2 = { roomCode: 'BBB-BBB-BBB', at: '2026-07-08T00:00:00Z' };

  it('adds fresh entries with provenance', () => {
    const merged = mergeProjectMemory(emptyProjectMemory(), roomMemory({ facts: ['uses Postgres'] }), src1);
    expect(merged.facts).toEqual([{ text: 'uses Postgres', sourceRoom: src1.roomCode, at: src1.at }]);
  });

  it('dedupes restatements, keeping longer text and newer provenance', () => {
    const first = mergeProjectMemory(emptyProjectMemory(), roomMemory({ facts: ['Uses Postgres.'] }), src1);
    const merged = mergeProjectMemory(first, roomMemory({ facts: ['uses postgres with pgvector extension'] }), src2);
    expect(merged.facts).toHaveLength(1);
    expect(merged.facts[0]!.text).toBe('uses postgres with pgvector extension');
    expect(merged.facts[0]!.sourceRoom).toBe(src2.roomCode);
  });

  it('keeps newest-first ordering and caps list length', () => {
    let memory = emptyProjectMemory();
    for (let i = 0; i < MAX_ENTRIES_PER_CATEGORY + 10; i++) {
      memory = mergeProjectMemory(
        memory,
        roomMemory({ facts: [`distinct fact number ${i} about subsystem ${i}`] }),
        { roomCode: `R${i}`, at: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString() }
      );
    }
    expect(memory.facts).toHaveLength(MAX_ENTRIES_PER_CATEGORY);
    expect(memory.facts[0]!.sourceRoom).toBe(`R${MAX_ENTRIES_PER_CATEGORY + 9}`);
  });

  it('closes open questions answered by new knowledge', () => {
    const withQuestion = mergeProjectMemory(
      emptyProjectMemory(),
      roomMemory({ open_questions: ['还没写测试'] }),
      src1
    );
    expect(withQuestion.open_questions).toHaveLength(1);
    const merged = mergeProjectMemory(
      withQuestion,
      roomMemory({ deliverables: ['补齐了单元测试：还没写测试 的部分已完成'] }),
      src2
    );
    expect(merged.open_questions).toHaveLength(0);
  });

  it('does not mutate inputs', () => {
    const existing = mergeProjectMemory(emptyProjectMemory(), roomMemory({ facts: ['a stable fact'] }), src1);
    const snapshot = JSON.parse(JSON.stringify(existing));
    mergeProjectMemory(existing, roomMemory({ facts: ['another new fact'] }), src2);
    expect(existing).toEqual(snapshot);
  });
});

describe('normalizeProjectMemory', () => {
  it('parses valid jsonb and drops junk', () => {
    const parsed = normalizeProjectMemory({
      version: 1,
      facts: [{ text: 'x', sourceRoom: 'R', at: '2026-07-01T00:00:00Z' }, { text: '' }, 'junk', null],
      decisions: 'not-a-list',
    });
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.decisions).toEqual([]);
  });

  it('returns empty memory for null/garbage', () => {
    expect(normalizeProjectMemory(null)).toEqual(emptyProjectMemory());
    expect(normalizeProjectMemory([1, 2])).toEqual(emptyProjectMemory());
  });
});

describe('renderProjectMemory', () => {
  it('renders only non-empty sections and respects maxChars', () => {
    const memory = mergeProjectMemory(
      emptyProjectMemory(),
      roomMemory({ facts: ['uses Postgres'], preferences: ['answers in Chinese'] }),
      { roomCode: 'R', at: '2026-07-08T00:00:00Z' }
    );
    const text = renderProjectMemory(memory);
    expect(text).toContain('### Facts');
    expect(text).toContain('- uses Postgres');
    expect(text).toContain('### User preferences & constraints');
    expect(text).not.toContain('Decisions');

    const clipped = renderProjectMemory(memory, { maxChars: 30 });
    expect(clipped.length).toBeLessThanOrEqual(30);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('returns empty string for empty memory', () => {
    expect(renderProjectMemory(emptyProjectMemory())).toBe('');
  });
});
