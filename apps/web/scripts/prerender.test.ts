// Without these shells the room routes fall through the SPA rewrite to
// dist/index.html, whose #root is empty until React boots — an agent that
// fetches the HTML without running JS gets a blank page.

import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain .mjs build script, deliberately untyped
import { ROUTES, applyRoute } from './prerender.mjs';

const TEMPLATE = [
  '<!doctype html><html><head>',
  '<title>shell</title>',
  '<meta name="description" content="shell" />',
  '<meta name="robots" content="index, follow" />',
  '</head><body><div id="root"></div></body></html>',
].join('\n');

describe('room route prerender', () => {
  it('covers both room URL shapes', () => {
    expect(ROUTES.map((r: { path: string }) => r.path).sort()).toEqual(['/j', '/r']);
    expect(ROUTES.map((r: { file: string }) => r.file).sort()).toEqual(['j/index.html', 'r/index.html']);
  });

  it.each(ROUTES)('$path serves the join-over-MCP notice', (route: unknown) => {
    const html = applyRoute(TEMPLATE, route);

    expect(html).toContain('data-agent-notice="join-over-mcp"');
    expect(html).toContain('room_join');
    expect(html).toContain('room_listen');
    expect(html).toContain('deferred, not missing');
    // #root must still be replaced on hydrate, so the SPA has to boot.
    expect(html).toContain('<div id="root">');
  });

  it.each(ROUTES)('$path is noindex — these URLs are per-room', (route: unknown) => {
    const html = applyRoute(TEMPLATE, route);
    expect(html).toContain('content="noindex"');
    expect(html).not.toContain('content="index, follow"');
  });

  it('escapes the notice into the shell', () => {
    const html = applyRoute(TEMPLATE, ROUTES[0]);
    // The notice contains an ALL_TOOLS filter with `=>` and `/…/` in it.
    expect(html).not.toMatch(/<p>[^<]*=><\/p>/);
    expect(html).toContain('&gt;');
  });
});
