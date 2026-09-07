import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { createClient, getRoom, joinRoom, verifyHostKey, HostNameTakenError, RoomNotFoundError } from '@agent-room/upstash-client';
import type { Room } from '@agent-room/shared';
import { isValidCode, CODE_LEN, ROLE_PRESETS } from '@agent-room/shared';
import { ENV } from '../env.js';
import { CodeInput } from '../components/CodeInput.js';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { AgentJoinQuickstart } from '../components/AgentJoinQuickstart.js';
import { AgentJoinNotice } from '../components/AgentJoinNotice.js';
import { colorForName, initialsFor } from '../lib/colors.js';

function stripDashes(s: string) { return s.replace(/-/g, ''); }
function withDashes(s: string) { return s.match(/.{1,3}/g)?.join('-') ?? s; }

export function Join() {
  const { code: codeParam = '' } = useParams();
  const navigate = useNavigate();
  const [raw, setRaw] = useState(stripDashes(codeParam));
  const [room, setRoom] = useState<Room | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (raw.length !== CODE_LEN) { setRoom(null); return; }
    const dashed = withDashes(raw);
    if (!isValidCode(dashed)) { setErr('Invalid code'); return; }
    setErr(null);
    const client = createClient(ENV.upstash);
    getRoom(client, dashed)
      .then(setRoom)
      .catch(e => setErr(e instanceof RoomNotFoundError ? 'Room not found' : String(e)));
  }, [raw]);

  async function join() {
    if (!room || !name.trim()) return;
    setBusy(true); setErr(null);
    try {
      const client = createClient(ENV.upstash);
      const trimmed = name.trim();
      // Host-name lock: claiming the host's display name requires the host
      // key (set on createRoom). Without it we throw before sending join.
      if (trimmed === room.createdBy) {
        // Read from localStorage (survives tab close, scoped to this room
        // and bounded by the same 24h TTL on the server) with a session-
        // Storage fallback for hosts whose key landed there before this
        // change.
        const hostKey = localStorage.getItem(`room:${room.code}:hostKey`)
          ?? sessionStorage.getItem(`room:${room.code}:hostKey`)
          ?? undefined;
        await verifyHostKey(client, room.code, hostKey);
      }
      const participant = {
        name: trimmed,
        role: role.trim(),
        color: colorForName(trimmed),
        initials: initialsFor(trimmed),
        client: 'web' as const,
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      const result = await joinRoom(client, room.code, participant, {
        priorIdentity: { name: trimmed, client: 'web' },
      });
      // joinRoom may have suffixed the name on collision (e.g. "Robin (2)").
      // Persist whatever the server actually assigned so future writes use it.
      const finalName = result.participant.name;
      sessionStorage.setItem(`room:${room.code}:self`, JSON.stringify({ name: finalName, role: role.trim() }));
      navigate(`/r/${room.code}`);
    } catch (e) {
      if (e instanceof HostNameTakenError) {
        setErr(`The name "${name.trim()}" is reserved for the host of this room. Pick a different display name.`);
      } else {
        setErr(String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="bg-white px-6 py-5">
        <div className="mx-auto max-w-6xl">
          <Link to="/" aria-label="Agent Room home" className="inline-block hover:opacity-85 transition">
            <AgentRoomLogo markClassName="h-7 w-7" wordmarkClassName="text-base" />
          </Link>
        </div>
      </div>
      <div className="max-w-md mx-auto mt-10 p-8 bg-surface border border-border rounded-xl shadow-card">
      <h1 className="text-lg font-semibold tracking-tight">Join a meeting</h1>
      <p className="text-xs text-ink-soft mt-1 mb-6">Enter the 9-character code from your invite.</p>

      <AgentJoinNotice code={raw.length === CODE_LEN ? withDashes(raw) : undefined} />

      <div className="mb-4">
        <CodeInput value={raw} onChange={setRaw} />
      </div>

      {err && <div className="text-xs text-red-600 mb-3">{err}</div>}

      {room && (
        <>
          <div className="bg-surface-soft border border-border-faint rounded-lg p-3 mb-4 flex gap-2 items-center">
            <div className="w-7 h-7 rounded-md bg-accent-tint text-accent flex items-center justify-center text-sm">◇</div>
            <div>
              <div className="text-xs font-semibold">{room.topic}</div>
              <div className="text-[9px] text-ink-soft">Hosted by {room.createdBy} · {room.participants.length} here</div>
            </div>
          </div>

          <AgentJoinQuickstart roomCode={room.code} />

          <label className="block mb-3">
            <span className="text-[11px] font-semibold text-ink-muted block mb-1">Your name</span>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg outline-none text-sm focus:border-accent focus:ring-4 focus:ring-accent-tint" />
          </label>
          <label className="block mb-5">
            <span className="text-[11px] font-semibold text-ink-muted block mb-1">Your role <span className="text-ink-faint font-medium">optional</span></span>
            <select
              value={ROLE_PRESETS.some(p => p.role === role) ? role : ''}
              onChange={e => setRole(e.target.value)}
              className="w-full mb-2 px-3 py-2 bg-surface border border-border rounded-lg outline-none text-sm focus:border-accent focus:ring-4 focus:ring-accent-tint"
            >
              <option value="">Custom role</option>
              {ROLE_PRESETS.map(p => <option key={p.id} value={p.role}>{p.label}</option>)}
            </select>
            <input value={role} onChange={e => setRole(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg outline-none text-sm focus:border-accent focus:ring-4 focus:ring-accent-tint" />
          </label>

          <button disabled={busy} onClick={join} className="w-full bg-accent text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50">
            {busy ? 'Joining…' : 'Join meeting →'}
          </button>
        </>
      )}
      </div>
    </>
  );
}
