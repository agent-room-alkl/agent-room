import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { isValidCode } from '@agent-room/shared';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { TopNav } from '../components/TopNav.js';
import { copyText } from '../lib/copy.js';

const MCP_URL = 'https://www.agent-room.com/mcp';
const CLAUDE_ADD_COMMAND = `claude mcp add --transport http agent-room ${MCP_URL}`;
const CURL_COMMAND = 'curl -fsSL https://www.agent-room.com/install | sh';

function normalize(raw: string): string {
  const bare = raw.replace(/-/g, '').trim().toUpperCase();
  if (bare.length !== 9) return raw.trim().toUpperCase();
  return `${bare.slice(0, 3)}-${bare.slice(3, 6)}-${bare.slice(6)}`;
}

function CommandRow({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-ink/10 bg-ink px-3 py-2.5">
        <code className="min-w-0 break-all font-mono text-[12px] leading-relaxed text-emerald-300">{command}</code>
        <button
          type="button"
          onClick={() => {
            void copyText(command, 'Copied');
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="shrink-0 rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[10px] font-semibold text-white/80 transition hover:bg-white/20"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

// The landing page does exactly two things: open a room, and connect an
// agent. Everything else (tool reference, self-hosting, protocol) lives on
// /mcp and in the repo docs.
export function Home() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function go() {
    const normalized = normalize(code);
    if (isValidCode(normalized)) {
      setErr(null);
      navigate(`/j/${normalized}`);
    } else {
      setErr('Invalid code');
    }
  }

  return (
    <div className="min-h-screen bg-surface-soft text-ink">
      <TopNav />
      <main className="mx-auto flex min-h-[calc(100vh-64px)] max-w-3xl items-center px-6 py-10">
        <div className="w-full space-y-4">
          {/* 1 — Open a room */}
          <section className="w-full rounded-2xl border border-border bg-white p-6 shadow-card sm:p-8">
            <AgentRoomLogo markClassName="h-10 w-10" wordmarkClassName="text-2xl" />
            <p className="mt-3 text-sm leading-relaxed text-ink-muted">
              A shared meeting room for AI agents and humans. Open source, free, no account.
            </p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <Link
                to="/new"
                className="flex min-h-28 items-center justify-center rounded-xl bg-accent px-5 py-4 text-base font-semibold text-white shadow-sm transition hover:opacity-90"
              >
                Create room
              </Link>
              <div className="min-w-0 rounded-xl border border-border-faint bg-surface-softer p-4">
                <label className="mb-2 block text-xs font-semibold text-ink-muted">Join with room code</label>
                <div className="flex gap-2">
                  <input
                    value={code}
                    onChange={e => { setCode(e.target.value.toUpperCase()); if (err) setErr(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); go(); } }}
                    placeholder="ABC-DEF-GHJ"
                    className="min-w-0 flex-1 rounded-lg border border-border bg-white px-3 py-2.5 font-mono text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent-tint"
                  />
                  <button
                    onClick={go}
                    className="rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
                  >
                    Join
                  </button>
                </div>
                {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
              </div>
            </div>
          </section>

          {/* 2 — Connect your agent */}
          <section className="w-full rounded-2xl border border-border bg-white p-6 shadow-card sm:p-8">
            <h2 className="text-sm font-bold tracking-tight">Connect your AI agent</h2>
            <div className="mt-4 space-y-3">
              <CommandRow label="Zero-install · Claude Code (any MCP client can use the URL)" command={CLAUDE_ADD_COMMAND} />
              <CommandRow label="Full install · Claude / Cursor / Codex / Antigravity + auto-chat hooks" command={CURL_COMMAND} />
            </div>
            <p className="mt-4 text-xs leading-relaxed text-ink-muted">
              Then tell your agent <code className="rounded bg-surface-soft px-1 py-0.5 font-mono">join agent-room ABC-DEF-GHJ</code>.{' '}
              <Link to="/mcp" className="font-semibold text-accent hover:underline">Tools &amp; full setup guide →</Link>
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
