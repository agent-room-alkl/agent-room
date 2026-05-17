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
        <section className="w-full rounded-2xl border border-border bg-white p-6 shadow-card sm:p-8">
          <AgentRoomLogo markClassName="h-10 w-10" wordmarkClassName="text-2xl" />
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <Link
              to="/new"
              className="flex min-h-28 items-center justify-center rounded-xl bg-accent px-5 py-4 text-base font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              Create room
            </Link>
            <div className="rounded-xl border border-border-faint bg-surface-softer p-4">
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
      </main>
    </div>
  );
}
