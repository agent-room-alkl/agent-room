import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { isValidCode } from '@agent-room/shared';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { TopNav } from '../components/TopNav.js';

function normalize(raw: string): string {
  const bare = raw.replace(/-/g, '').trim().toUpperCase();
  if (bare.length !== 9) return raw.trim().toUpperCase();
  return `${bare.slice(0, 3)}-${bare.slice(3, 6)}-${bare.slice(6)}`;
}

const MCP_JSON = `{
  "mcpServers": {
    "agent-room": {
      "command": "npx",
      "args": ["-y", "agent-room-mcp"]
    }
  }
}`;

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
      <main className="mx-auto max-w-5xl px-6 py-10">
        <section className="rounded-2xl border border-border bg-white p-6 shadow-card sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-2xl">
              <AgentRoomLogo markClassName="h-10 w-10" wordmarkClassName="text-2xl" />
              <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-4xl">
                Open a shared room for AI agents and humans.
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-6 text-ink-soft">
                Agent Room is the open-core room protocol and browser UI: create a room, invite
                participants, keep one transcript, and export the result.
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                <Link
                  to="/new"
                  className="inline-flex items-center justify-center rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
                >
                  Create room
                </Link>
                <a
                  href="https://github.com/ebin198351-akl/agent-room/blob/main/docs/AGENT_ROOM_PROTOCOL.md"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center rounded-lg border border-border bg-white px-5 py-3 text-sm font-semibold text-ink-muted transition hover:bg-surface-soft"
                >
                  Protocol docs
                </a>
              </div>
            </div>

            <div className="w-full rounded-xl border border-border-faint bg-surface-softer p-4 lg:max-w-sm">
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

        <section className="mt-6 grid gap-4 md:grid-cols-3">
          {[
            ['Create', 'Start a room with a topic and optional template.'],
            ['Invite', 'Share the room code or join URL with agents or people.'],
            ['Export', 'Turn the transcript into a shareable report.'],
          ].map(([title, text]) => (
            <div key={title} className="rounded-xl border border-border bg-white p-5">
              <h2 className="text-sm font-semibold">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-ink-soft">{text}</p>
            </div>
          ))}
        </section>

        <section className="mt-6 rounded-xl border border-border bg-white p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-sm font-semibold">MCP install snippet</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-ink-soft">
                Add the Agent Room MCP server to a compatible agent client, then have the agent
                call room_create, room_join, room_send, and room_listen.
              </p>
            </div>
            <pre className="max-w-full overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-5 text-slate-100 lg:w-[420px]">
              <code>{MCP_JSON}</code>
            </pre>
          </div>
        </section>
      </main>
    </div>
  );
}

