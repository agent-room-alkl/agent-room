import { describe, it, expect } from 'vitest';
import { normalizeEscapedWhitespace , isNearDuplicate, trigramSimilarity , isNearDuplicate, trigramSimilarity } from '../src/text.js';

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

describe('isNearDuplicate (anti-parrot guard)', () => {
  const leadEn =
    'The pricing strategy should anchor on the $4.50 quiche as a loss leader, raise the muffin line to $3.25, ' +
    'and introduce a $12 brunch bundle to lift average ticket size. The biggest risk is cannibalizing the croissant SKU.';
  const leadZh =
    '定价策略应该以4.50美元的乳蛋饼作为引流款，把松饼线提价到3.25美元，并推出12美元的早午餐套餐来提升客单价。' +
    '最大的风险是蚕食可颂这个单品的销量，需要在两周后复盘实际数据再做调整。';

  it('flags a near-verbatim restatement (English)', () => {
    const parrot =
      'The pricing strategy should anchor on the $4.50 quiche as a loss leader, raise the muffin line to $3.25, ' +
      'and introduce a $12 brunch bundle to lift the average ticket. The main risk is cannibalizing the croissant SKU.';
    expect(isNearDuplicate(parrot, leadEn)).toBe(true);
  });

  it('flags a near-verbatim restatement (Chinese, no word spaces)', () => {
    const parrot =
      '定价策略应该以4.50美元的乳蛋饼作为引流款，把松饼线提价到3.25美元，并推出12美元的早午餐套餐提升客单价。' +
      '最大的风险是蚕食可颂单品的销量，建议两周后复盘实际数据再调整。';
    expect(isNearDuplicate(parrot, leadZh)).toBe(true);
  });

  it('passes a genuine delta on the same topic', () => {
    const delta =
      'One gap: weekend traffic skews 70% takeaway, so the $12 bundle needs a to-go format or it underperforms. ' +
      'Also the quiche margin at $4.50 is negative once packaging is included — verify COGS before anchoring on it.';
    expect(isNearDuplicate(delta, leadEn)).toBe(false);
  });

  it('never flags short replies (brevity is not parroting)', () => {
    expect(isNearDuplicate('同意，按方案B执行。', '同意，按方案B执行。')).toBe(false);
  });

  it('trigramSimilarity is 1 for identical text and ~0 for unrelated text', () => {
    expect(trigramSimilarity(leadEn, leadEn)).toBe(1);
    expect(trigramSimilarity(leadEn, 'completely unrelated content about kubernetes ingress controllers')).toBeLessThan(0.1);
  });
});
