// Guards the surfaces an agent reaches when it opened a room page instead of
// calling room_join. There is no DOM test setup here, so these are source-level
// invariants — worth pinning because each regression they catch is invisible in
// review and only shows up as an agent silently joining as a web participant.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

describe('AgentJoinNotice', () => {
  const file = read('../components/AgentJoinNotice.tsx');
  // The doc comment above the component names the very escapes this asserts
  // against, so scan the component itself, not the file.
  const src = file.slice(file.indexOf('export function AgentJoinNotice'));

  // A browser-driving agent reads the accessibility tree, so anything that
  // takes the notice out of that tree makes it useless — while still looking
  // perfectly reasonable in the diff.
  it('stays in the accessibility tree', () => {
    expect(src).not.toBe('');
    for (const escape of ['aria-hidden', 'sr-only', 'hidden', 'display:none', 'display: none', '<details']) {
      expect(src).not.toContain(escape);
    }
  });
});

describe('/j/:code', () => {
  const src = read('Join.tsx');

  it('shows the notice above the human form', () => {
    expect(src).toContain('<AgentJoinNotice');
    expect(src.indexOf('<AgentJoinNotice')).toBeLessThan(src.indexOf('<CodeInput'));
  });

  it('passes the room code through once the URL supplies one', () => {
    expect(src).toContain('raw.length === CODE_LEN ? withDashes(raw) : undefined');
  });
});

describe('/r/:code', () => {
  const src = read('Room.tsx');

  // Visiting /r/CODE without a stored identity bounces to /j/CODE. That bounce
  // is client-side, so the interstitial has to carry the notice too — an agent
  // may snapshot the page before the redirect settles.
  it('carries the notice through the redirect interstitial', () => {
    const start = src.indexOf('if (!self) {');
    expect(start).toBeGreaterThan(-1);
    // The comment above the branch quotes the same string, so search forward.
    const branch = src.slice(start, src.indexOf('Redirecting to join', start) + 20);
    expect(branch).toContain('<AgentJoinNotice code={code} />');
  });
});

describe('vercel rewrites', () => {
  const config = JSON.parse(read('../../../../vercel.json')) as {
    rewrites: { source: string; destination: string }[];
  };
  const at = (source: string) => config.rewrites.findIndex(r => r.source === source);

  // Order is the whole point: the SPA catch-all matches /j/:code too, so a room
  // route placed after it would never reach its own shell.
  it('routes room URLs to their own shell before the SPA catch-all', () => {
    const catchAll = at('/((?!api/).*)');
    expect(catchAll).toBeGreaterThan(-1);
    for (const [source, destination] of [['/j/:code', '/j/index.html'], ['/r/:code', '/r/index.html']]) {
      const i = at(source!);
      expect(i).toBeGreaterThan(-1);
      expect(config.rewrites[i]!.destination).toBe(destination);
      expect(i).toBeLessThan(catchAll);
    }
  });

  it('keeps the report bot rewrite ahead of /r/:code', () => {
    expect(at('/r/:code/report')).toBeLessThan(at('/r/:code'));
  });
});
