// Plan B Phase 1+ — /templates/interview live demo.
//
// Replaces the static mock for slug=interview with a *real* Agent Room
// the visitor can chat with. On mount this component:
//   1. Picks a candidate display name (from sessionStorage or "Candidate").
//   2. createRoom() — a new ephemeral room scoped to this demo session.
//   3. joinRoom() the candidate as a web participant.
//   4. joinRoom() an "AI Interviewer" cc participant.
//   5. POSTs to /api/interview-reply with stage=opening, then
//      appendMessage()s the returned line as the Interviewer's first turn.
//
// After that the page is a normal Agent Room: useRoom polls the
// transcript, the candidate types into a textarea, and every time a new
// candidate message appears in the live transcript we POST to
// /api/interview-reply and append the response. Stage advances based
// on the candidate-turn count so the interview wraps up cleanly.
//
// Critical property: the room is REAL. Two browsers can both watch the
// same demo room (the host's window + the candidate's link), the URL
// can be shared, the export pipeline (room_export → /r/CODE/report)
// works, and the AI's lines are real messages stored in Upstash. This
// is what Robin asked for after the static mock failed his read: "the
// room should have an AI in it, not pretend."

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  appendMessage,
  createClient,
  createRoom,
  joinRoom,
} from '@agent-room/upstash-client';
import { generateCode, type Message } from '@agent-room/shared';
import { ENV } from '../env.js';
import { colorForName, initialsFor } from '../lib/colors.js';
import { useRoom } from '../hooks/useRoom.js';
import { TopNav } from '../components/TopNav.js';
import { templateBySlug } from '../lib/liveTemplates.js';

type Stage = 'opening' | 'depth' | 'tradeoffs' | 'behavioral' | 'wrap';

const INTERVIEWER_NAME = 'AI Interviewer';
const DEFAULT_CANDIDATE_NAME = 'Candidate';

function pickStage(candidateTurns: number): Stage {
  if (candidateTurns <= 0) return 'opening';
  if (candidateTurns <= 2) return 'depth';
  if (candidateTurns <= 4) return 'tradeoffs';
  if (candidateTurns <= 6) return 'behavioral';
  return 'wrap';
}

export function TemplateInterviewLive() {
  // Static template metadata (status pill, pricing, pilot CTA). We keep
  // the buyer story rendered on the page so the live demo stays
  // commercially honest — visitors see what would be sold AND what's
  // running today.
  const t = useMemo(() => templateBySlug('interview'), []);

  const [code, setCode] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [candidateName] = useState<string>(() => {
    if (typeof sessionStorage === 'undefined') return DEFAULT_CANDIDATE_NAME;
    return sessionStorage.getItem('templates:interview:candidate') ?? DEFAULT_CANDIDATE_NAME;
  });
  const [usingLiveLLM, setUsingLiveLLM] = useState<boolean | null>(null);
  const [draft, setDraft] = useState('');
  const [busyReply, setBusyReply] = useState(false);
  // Track which candidate messages we've already responded to so a
  // re-render or a duplicate poll doesn't trigger two AI replies.
  const repliedToRef = useRef<Set<number>>(new Set());

  // Set up the room on first mount. Strict-mode-safe: a ref guards
  // against React 18's intentional double-invocation of effects in dev.
  const setupRef = useRef(false);
  useEffect(() => {
    if (setupRef.current) return;
    setupRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const newCode = generateCode();
        const client = createClient(ENV.upstash);
        await createRoom(client, {
          code: newCode,
          topic: 'AI Interview Demo — Senior Engineer',
          createdBy: candidateName,
        });
        // Join self as candidate (web). createRoom already adds the
        // host (candidate) as the first participant, but we joinRoom
        // again with priorIdentity so refreshes don't add a "(2)".
        await joinRoom(
          client,
          newCode,
          {
            name: candidateName,
            role: 'Candidate',
            color: colorForName(candidateName),
            initials: initialsFor(candidateName),
            client: 'web',
            joinedAt: Date.now(),
            lastSeenAt: Date.now(),
          },
          { priorIdentity: { name: candidateName, client: 'web' } },
        );
        // Add the AI Interviewer as a cc participant — same machinery
        // any MCP-driven agent uses, just driven from the browser.
        await joinRoom(
          client,
          newCode,
          {
            name: INTERVIEWER_NAME,
            role: 'Interviewer',
            color: colorForName(INTERVIEWER_NAME),
            initials: initialsFor(INTERVIEWER_NAME),
            client: 'cc',
            joinedAt: Date.now(),
            lastSeenAt: Date.now(),
          },
          { priorIdentity: { name: INTERVIEWER_NAME, client: 'cc' } },
        );
        if (cancelled) return;
        setCode(newCode);
      } catch (e) {
        if (!cancelled) setSetupError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => { cancelled = true; };
  }, [candidateName]);

  const { room, messages, error: roomError } = useRoom(code ?? '', candidateName);

  const candidateTurns = useMemo(
    () => messages.filter(m => m.type === 'msg' && m.client === 'web' && m.name === candidateName).length,
    [messages, candidateName],
  );

  // Trigger an AI reply. Pulls the current transcript shape and posts a
  // turn from "AI Interviewer". Idempotent on its own — but we still
  // gate at the call site by message id (`repliedToRef`) so two fires
  // don't double-post.
  const triggerInterviewerTurn = useCallback(
    async (forCandidateMessageId: number | 'opening') => {
      if (!code) return;
      setBusyReply(true);
      try {
        const stage = forCandidateMessageId === 'opening' ? 'opening' : pickStage(candidateTurns);
        const transcriptForLLM = messages
          .filter(m => m.type === 'msg')
          .map(m => ({
            speaker: (m.name === INTERVIEWER_NAME ? 'interviewer' : 'candidate') as 'candidate' | 'interviewer',
            text: m.text,
          }));
        const resp = await fetch('/api/interview-reply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, transcript: transcriptForLLM, stage }),
        });
        const body = await resp.json() as { text: string; ai: boolean; stage: Stage };
        setUsingLiveLLM(body.ai);
        const client = createClient(ENV.upstash);
        const msg: Message = {
          id: Date.now(),
          type: 'msg',
          name: INTERVIEWER_NAME,
          role: 'Interviewer',
          color: colorForName(INTERVIEWER_NAME),
          initials: initialsFor(INTERVIEWER_NAME),
          client: 'cc',
          text: body.text,
          time: Date.now(),
        };
        await appendMessage(client, code, msg);
      } catch (e) {
        // Surfacing through console — the room itself stays usable, the
        // UI just won't post the line. The candidate can retry by
        // sending another message.
        console.error('[interview-reply] failed', e);
      } finally {
        setBusyReply(false);
      }
    },
    [code, messages, candidateTurns],
  );

  // After room setup, fire the opening turn once.
  useEffect(() => {
    if (!code) return;
    if (messages.length > 0) return; // someone already opened
    if (busyReply) return;
    if (repliedToRef.current.has(-1)) return; // sentinel: opening already triggered
    repliedToRef.current.add(-1);
    void triggerInterviewerTurn('opening');
    // We intentionally exclude busyReply / triggerInterviewerTurn from
    // deps — `repliedToRef` already gates duplicate runs. Adding either
    // back would re-fire the opening on every busyReply flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, messages.length]);

  // After every new candidate message that we haven't replied to yet,
  // fire the next interviewer turn.
  useEffect(() => {
    if (!code) return;
    if (busyReply) return;
    const lastCandidate = [...messages].reverse().find(m =>
      m.type === 'msg' && m.client === 'web' && m.name === candidateName,
    );
    if (!lastCandidate) return;
    if (repliedToRef.current.has(lastCandidate.id)) return;
    // Only fire if the candidate's message is genuinely the last one
    // (not already followed by an interviewer reply still mid-flight).
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.id !== lastCandidate.id) return;
    repliedToRef.current.add(lastCandidate.id);
    void triggerInterviewerTurn(lastCandidate.id);
    // Same exclusion rationale as the opening effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, messages, busyReply, candidateName]);

  async function sendCandidate() {
    const text = draft.trim();
    if (!code || !text) return;
    setDraft('');
    const client = createClient(ENV.upstash);
    const msg: Message = {
      id: Date.now(),
      type: 'msg',
      name: candidateName,
      role: 'Candidate',
      color: colorForName(candidateName),
      initials: initialsFor(candidateName),
      client: 'web',
      text,
      time: Date.now(),
    };
    try {
      await appendMessage(client, code, msg);
    } catch (e) {
      console.error('[interview send] failed', e);
    }
  }

  if (!t) return null; // type-narrow; should never happen for slug=interview

  if (setupError) {
    return (
      <div className="min-h-screen bg-surface-soft">
        <TopNav />
        <div className="max-w-2xl mx-auto px-6 py-16">
          <h1 className="text-xl font-bold mb-2">Couldn't start the demo</h1>
          <p className="text-sm text-ink-soft mb-4">{setupError}</p>
          <Link to="/templates" className="text-sm font-semibold text-accent">← Back to templates</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-soft">
      <TopNav />

      {/* Hero — same shape as the static template page so visitors get the
          same buyer context. The status pill flips based on whether the
          live LLM is actually answering, so we never claim more than is
          true on the wire. */}
      <header className="bg-slate-950 text-white px-6 py-12">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3 mb-3">
            <Link to="/templates" className="text-xs text-slate-400 hover:text-slate-200">← Templates</Link>
            <span className="text-slate-600">·</span>
            <span
              className={
                'text-[10px] font-semibold uppercase tracking-widest px-2.5 py-1 rounded-full border ' +
                (usingLiveLLM === true
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                  : usingLiveLLM === false
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  : 'bg-slate-500/15 text-slate-300 border-slate-500/30')
              }
            >
              {usingLiveLLM === true
                ? 'Live demo · LLM-driven'
                : usingLiveLLM === false
                ? 'Live demo · scripted (LLM key not set)'
                : 'Starting demo…'}
            </span>
          </div>
          <div className="flex items-start gap-4 mb-3">
            <span className="text-5xl leading-none">{t.emoji}</span>
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">{t.label}</h1>
              <p className="text-base text-slate-300 mt-1">{t.tagline}</p>
            </div>
          </div>
          <p className="text-sm text-slate-300 max-w-2xl mt-3 leading-relaxed">
            This is a working demo. The room you see below is a real Agent Room — both you and the
            AI Interviewer are participants. Chat to it; the answers come from a real model when
            <code className="mx-1 text-[12px] bg-slate-800/60 px-1.5 py-0.5 rounded">ANTHROPIC_API_KEY</code>
            is set, otherwise from a scripted ladder so you can still see the shape end-to-end.
          </p>
          {code && (
            <p className="text-[11px] text-slate-500 mt-3 font-mono">
              Room: <Link to={`/r/${code}`} className="text-slate-300 hover:text-white underline">/r/{code}</Link>
              {' · '}
              <Link to={`/r/${code}/report`} className="text-slate-300 hover:text-white underline">view scorecard once you wrap</Link>
            </p>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        {/* Live three-column board: roles + chat + outcome. Mirrors the
            static demo layout so the buyer can compare the design preview
            against what's actually running. */}
        <div className="grid lg:grid-cols-[240px_1fr_300px] gap-4">
          {/* Roles */}
          <aside className="bg-white border border-border rounded-2xl p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-3">In the room</h3>
            <ul className="space-y-3">
              {(room?.participants ?? []).map(p => (
                <li key={`${p.name}-${p.client}`} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        'w-2 h-2 rounded-full ' +
                        (p.client === 'cc' ? 'bg-indigo-500' : 'bg-emerald-500')
                      }
                      aria-hidden
                    />
                    <span className="text-sm font-semibold text-ink">{p.name}</span>
                    {p.client === 'cc' && (
                      <span className="text-[9px] font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 rounded px-1.5 py-0.5">
                        AI
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-ink-soft leading-snug pl-4">{p.role}</p>
                </li>
              ))}
              {!room && <li className="text-[11px] text-ink-faint">Setting up the room…</li>}
            </ul>
          </aside>

          {/* Chat */}
          <div className="bg-white border border-border rounded-2xl p-5 flex flex-col min-h-[480px]">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-3">Live transcript</h3>
            {roomError && <p className="text-xs text-red-600 mb-2">{roomError}</p>}
            <ol className="flex-1 space-y-4 overflow-y-auto pr-1 max-h-[480px]">
              {messages.filter(m => m.type === 'msg').map(m => (
                <li key={m.id} className="flex gap-3">
                  <div
                    className={
                      'shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold ' +
                      (m.client === 'cc'
                        ? 'bg-indigo-100 text-indigo-700'
                        : 'bg-emerald-100 text-emerald-700')
                    }
                  >
                    {m.initials}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-semibold text-ink">{m.name}</span>
                      {m.client === 'cc' && (
                        <span className="text-[9px] font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 rounded px-1.5 py-0.5">
                          AI
                        </span>
                      )}
                      <span className="text-[10px] text-ink-faint">{new Date(m.time).toLocaleTimeString()}</span>
                    </div>
                    <p className="text-[13px] leading-relaxed text-ink-soft whitespace-pre-wrap">{m.text}</p>
                  </div>
                </li>
              ))}
              {busyReply && (
                <li className="text-[11px] text-ink-faint italic pl-11">AI Interviewer is thinking…</li>
              )}
              {!code && (
                <li className="text-[11px] text-ink-faint italic">Creating the room…</li>
              )}
            </ol>

            <div className="border-t border-border-faint pt-3 mt-3 flex flex-col gap-2">
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void sendCandidate();
                  }
                }}
                placeholder={code ? 'Type your answer… (Enter to send, Shift+Enter for newline)' : 'Setting up…'}
                rows={2}
                disabled={!code}
                className="w-full resize-none px-3 py-2 bg-surface-softer border border-border rounded-lg text-sm leading-relaxed outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint disabled:opacity-50"
              />
              <button
                onClick={() => void sendCandidate()}
                disabled={!code || !draft.trim()}
                className="self-end bg-accent text-white px-4 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>

          {/* Outcome — what the buyer would receive at the end */}
          <aside className="bg-gradient-to-br from-accent-tint via-white to-amber-50 border border-accent-tint-border rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-accent-deep">{t.artifact.name}</h3>
              <span className="text-[10px] text-ink-faint">{t.artifact.deliverableShape}</span>
            </div>
            <ul className="space-y-3">
              {t.outcome.map((item, i) => (
                <li key={i} className="border-b border-border-faint last:border-0 pb-3 last:pb-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-0.5">{item.label}</div>
                  <div className="text-sm text-ink leading-snug">{item.value}</div>
                </li>
              ))}
            </ul>
            <p className="text-[11px] leading-relaxed text-ink-soft mt-4 pt-4 border-t border-border-faint">
              {t.artifact.monetizationLine}
            </p>
            {code && messages.filter(m => m.type === 'msg' && m.client === 'web').length >= 3 && (
              <Link
                to={`/r/${code}/report`}
                className="mt-4 block text-center bg-slate-950 text-white text-xs font-semibold py-2 rounded-lg hover:opacity-90 transition"
              >
                Generate scorecard →
              </Link>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
