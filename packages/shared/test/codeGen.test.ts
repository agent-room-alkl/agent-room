import { describe, it, expect } from 'vitest';
import { generateCode, isValidCode, parseRoomCode, CODE_CHARS } from '../src/index.js';

describe('generateCode', () => {
  it('returns a string in XXX-XXX-XXX format', () => {
    const code = generateCode();
    expect(code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  });

  it('uses only characters from CODE_CHARS', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateCode().replace(/-/g, '');
      for (const ch of code) {
        expect(CODE_CHARS).toContain(ch);
      }
    }
  });

  it('never contains the excluded characters 0 O I L 1', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateCode();
      expect(code).not.toMatch(/[0OIL1]/);
    }
  });

  it('generates different codes on successive calls (probabilistic)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateCode()));
    expect(codes.size).toBeGreaterThan(40);
  });
});

describe('isValidCode', () => {
  it('accepts a well-formed code', () => {
    expect(isValidCode('ABC-DEF-GHJ')).toBe(true);
  });

  it('rejects codes with excluded characters', () => {
    expect(isValidCode('ABC-DEF-GH0')).toBe(false);
    expect(isValidCode('ABC-DEF-GHI')).toBe(false);
  });

  it('rejects wrong length', () => {
    expect(isValidCode('ABC-DEF')).toBe(false);
    expect(isValidCode('ABC-DEF-GHJ-KLM')).toBe(false);
  });

  it('rejects missing dashes', () => {
    expect(isValidCode('ABCDEFGHJ')).toBe(false);
  });

  it('is case sensitive (uppercase only)', () => {
    expect(isValidCode('abc-def-ghj')).toBe(false);
  });
});

describe('parseRoomCode', () => {
  it('passes a canonical code straight through', () => {
    const code = generateCode();
    expect(parseRoomCode(code)).toBe(code);
  });

  it('accepts the join URLs an agent is actually handed', () => {
    for (const input of [
      'https://www.agent-room.com/j/ABC-DEF-GHJ',
      'https://www.agent-room.com/r/ABC-DEF-GHJ',
      'www.agent-room.com/j/ABC-DEF-GHJ',
      'agent-room.com/j/abc-def-ghj',
      'https://www.agent-room.com/j/ABC-DEF-GHJ?utm=x#top',
      'https://www.agent-room.com/j/ABC-DEF-GHJ/',
    ]) {
      expect(parseRoomCode(input), input).toBe('ABC-DEF-GHJ');
    }
  });

  it('accepts a lowercase, undashed, or padded code', () => {
    expect(parseRoomCode('abc-def-ghj')).toBe('ABC-DEF-GHJ');
    expect(parseRoomCode('ABCDEFGHJ')).toBe('ABC-DEF-GHJ');
    expect(parseRoomCode('  abc def ghj  ')).toBe('ABC-DEF-GHJ');
  });

  it('returns null rather than inventing a code', () => {
    for (const input of ['', 'hello', 'https://www.agent-room.com/', 'ABC-DEF', 'ABC-DEF-GHJK', 'AB1-DEF-GHJ']) {
      expect(parseRoomCode(input), input).toBeNull();
    }
  });

  it('never produces a code isValidCode rejects', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(isValidCode(parseRoomCode(`https://www.agent-room.com/j/${code.toLowerCase()}`)!)).toBe(true);
    }
  });
});
