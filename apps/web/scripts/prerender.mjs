// No shebang: this module is imported by prerender.test.ts, and vite-node
// evaluates module source through vm.Script, which does not strip one.
// It is only ever run as `node scripts/prerender.mjs` from the build script.
/**
 * Post-vite prerender for the room routes.
 *
 * /j/:code and /r/:code fall through the SPA rewrite to dist/index.html, whose
 * #root is empty until React boots. An agent that fetches the HTML without
 * running JS therefore gets a blank page and no way to know the room is
 * reachable over MCP. These shells carry the same join-over-MCP notice the
 * React component renders (components/AgentJoinNotice.tsx), so both readers get
 * the same text. They are per-room URLs, so they are noindex.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildJoinPageAgentNotice } from '@agent-room/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');

const ROUTES = [
  {
    path: '/j',
    file: 'j/index.html',
    title: 'Join a room — Agent Room',
    description: 'Join an Agent Room meeting. AI agents should join over MCP with room_join rather than this page.',
  },
  {
    path: '/r',
    file: 'r/index.html',
    title: 'Agent Room',
    description: 'An Agent Room meeting. AI agents should join over MCP with room_join rather than this page.',
  },
];

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setAttr(html, tagPattern, attr, value) {
  const re = new RegExp(`(<${tagPattern}[^>]*\\s${attr}=)("[^"]*"|'[^']*')`, 'i');
  if (re.test(html)) return html.replace(re, `$1"${escapeHtml(value)}"`);
  return html;
}

function setTitle(html, title) {
  return html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)}</title>`);
}

function setNoIndex(html) {
  if (/<meta[^>]*name=["']robots["']/i.test(html)) {
    return setAttr(html, 'meta[^>]*name=["\']robots["\']', 'content', 'noindex');
  }
  return html.replace(/<\/head>/i, '  <meta name="robots" content="noindex" />\n  </head>');
}

// The code is only in the URL, which this build step cannot see, so the notice
// is emitted in its no-code form — buildJoinPageAgentNotice still names the
// tool and its arguments, and the agent already has the code it navigated to.
function injectAgentRoot(html) {
  const lines = buildJoinPageAgentNotice()
    .map(line => `<p>${escapeHtml(line)}</p>`)
    .join('');
  const shell = `<main data-agent-notice="join-over-mcp"><h1>For AI agents</h1>${lines}</main>`;
  return html.replace(/<div id="root"><\/div>/i, `<div id="root">${shell}</div>`);
}

function applyRoute(template, route) {
  let html = template;
  html = setTitle(html, route.title);
  html = setAttr(html, 'meta[^>]*name=["\']description["\']', 'content', route.description);
  html = setNoIndex(html);
  html = injectAgentRoot(html);
  return html;
}

function main() {
  const templatePath = join(DIST, 'index.html');
  if (!existsSync(templatePath)) {
    console.error(`[prerender] missing ${templatePath} — run vite build first`);
    process.exit(1);
  }
  const template = readFileSync(templatePath, 'utf8');
  for (const route of ROUTES) {
    const out = join(DIST, route.file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, applyRoute(template, route));
    console.log(`[prerender] wrote ${route.file} → ${route.path}`);
  }
}

export { ROUTES, applyRoute };

// Importable from tests; still runs as the build step.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
