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
import { AudioReplyBar } from '../components/AudioReplyBar.js';
import { VoiceButton } from '../components/VoiceButton.js';
import { templateBySlug } from '../lib/liveTemplates.js';

type Stage = 'opening' | 'depth' | 'tradeoffs' | 'behavioral' | 'wrap';
type InterviewSpeaker = 'host' | 'candidate' | 'interviewer';

const INTERVIEWER_NAME = 'AI Interviewer';
const DEFAULT_CANDIDATE_NAME = 'Candidate';

function pickStage(candidateTurns: number): Stage {
  if (candidateTurns <= 0) return 'opening';
  if (candidateTurns <= 2) return 'depth';
  if (candidateTurns <= 4) return 'tradeoffs';
  if (candidateTurns <= 6) return 'behavioral';
  return 'wrap';
}

// Mirrors api/interview-reply.ts's scripted ladder so the demo still
// produces real interviewer turns when /api/interview-reply isn't
// reachable. `vite dev` doesn't execute Vercel functions; we'd
// otherwise hit Vite's SPA fallback (index.html, not JSON) and
// silently fail. In production this only fires if the function 5xx's.
const CLIENT_LADDER: Record<Stage, string[]> = {
  opening: [
    "Hi — thanks for taking the time. I'll keep this to about 20 minutes. To start: walk me through the project from your last 6 months you're proudest of. What was the thing you owned, what was the trade-off you optimized for, and what would you do differently?",
  ],
  depth: [
    "That's a useful framing. Going one level deeper: what specifically did you give up to get the upside you described? I'm asking because the candidates I worry about are the ones who can't name what they traded away.",
    "Got it. One follow-up — at what point did you realize the original plan wasn't going to work, and what tipped it for you? I'm trying to read your debugging instincts.",
  ],
  tradeoffs: [
    "Switching gears for a minute. Imagine you have a service that's hitting 99.5% uptime but the team is exhausted from on-call. The CEO wants 99.9%. How do you push back, and what data would you bring?",
    "If you had to pick one of: cleaner architecture, faster shipping, or fewer outages — for the next quarter only — which do you pick and why? No 'all three' allowed.",
  ],
  behavioral: [
    "Tell me about a time you disagreed with a more senior person on a technical call. Walk me through what they were arguing, what you were arguing, and how it actually resolved. Names off, specifics on.",
    "Last one in this round — when did you most recently change your mind about something you'd previously been confident in? What changed?",
  ],
  wrap: [
    "Good answers across the board. Two minutes left — anything you want me to flag to the hiring manager that we didn't cover? Could be a strength I missed or a concern you'd rather raise yourself.",
    "Thanks — wrapping up. You'll get a structured scorecard out of this session within an hour. Have a good rest of your day.",
  ],
};

function clientLadderLine(
  stage: Stage,
  transcript: { speaker: InterviewSpeaker; text: string }[],
): string {
  const interviewerSoFar = transcript.filter(t => t.speaker === 'interviewer').length;
  const lines = CLIENT_LADDER[stage];
  return lines[Math.min(interviewerSoFar, lines.length - 1)] ?? lines[0]!;
}

function speakerForMessage(message: Message, candidateName: string): InterviewSpeaker {
  if (message.name === INTERVIEWER_NAME && message.client === 'cc') return 'interviewer';
  if (message.name === candidateName && message.role === 'Candidate') return 'candidate';
  if (message.role === 'Host' || message.role === 'host') return 'host';
  if (message.client === 'web') return 'host';
  return 'candidate';
}

export function TemplateInterviewLive() {
  // Static template metadata (status pill, pricing, pilot CTA). We keep
  // the buyer story rendered on the page so the live demo stays
  // commercially honest — visitors see what would be sold AND what's
  // running today.
  const t = useMemo(() => templateBySlug('interview'), []);

  const [code, setCode] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  // brief === null means the host hasn't submitted the setup form yet;
  // brief === '' means submitted with no extra context (use the default
  // SMB SaaS engineering persona). Gating room creation on brief !== null
  // means the AI gets the host's tailoring on its very first turn rather
  // than after the candidate has already started talking.
  const [brief, setBrief] = useState<string | null>(null);
  const [briefDraft, setBriefDraft] = useState('');
  const [candidateName] = useState<string>(() => {
    if (typeof sessionStorage === 'undefined') return DEFAULT_CANDIDATE_NAME;
    return sessionStorage.getItem('templates:interview:candidate') ?? DEFAULT_CANDIDATE_NAME;
  });
  const [usingLiveLLM, setUsingLiveLLM] = useState<boolean | null>(null);
  const [draft, setDraft] = useState('');
  const [busyReply, setBusyReply] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<number | null>(null);
  // Track which candidate messages we've already responded to so a
  // re-render or a duplicate poll doesn't trigger two AI replies.
  const repliedToRef = useRef<Set<number>>(new Set());
  const spokenMessageRef = useRef<number | null>(null);
  const speechUnlockedRef = useRef(false);

  // Set up the room on first mount. Strict-mode-safe via the ref guard
  // alone — no `cancelled` flag, because React 18's dev double-invoke
  // pattern (mount → unmount → mount) would set cancelled=true between
  // the first invocation's awaits, which then skipped setCode and the
  // page hung at "Creating the room…" forever. The ref guard prevents
  // a SECOND setup from starting; we let the FIRST setup complete
  // normally even if its effect cleanup ran. setState on an unmounted
  // component is a no-op + warning in dev, not a crash, which is the
  // right trade-off for this single-shot setup.
  const setupRef = useRef(false);
  useEffect(() => {
    if (setupRef.current) return;
    if (brief === null) return; // wait for the host to submit the setup form
    setupRef.current = true;

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
        setCode(newCode);
      } catch (e) {
        setSetupError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [candidateName, brief]);

  const { room, messages, error: roomError } = useRoom(code ?? '', candidateName);

  const candidateTurns = useMemo(
    () => messages.filter(m => m.type === 'msg' && m.client === 'web' && m.name === candidateName).length,
    [messages, candidateName],
  );
  const latestInterviewerMessage = useMemo(
    () => [...messages].reverse().find(m => m.type === 'msg' && m.name === INTERVIEWER_NAME && m.client === 'cc') ?? null,
    [messages],
  );

  const unlockSpeech = useCallback(() => {
    if (speechUnlockedRef.current) return;
    if (!('speechSynthesis' in window)) return;
    speechUnlockedRef.current = true;
    const utterance = new SpeechSynthesisUtterance(' ');
    utterance.volume = 0;
    window.speechSynthesis.speak(utterance);
  }, []);

  useEffect(() => {
    const onFirstGesture = () => unlockSpeech();
    window.addEventListener('pointerdown', onFirstGesture, { once: true });
    window.addEventListener('keydown', onFirstGesture, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onFirstGesture);
      window.removeEventListener('keydown', onFirstGesture);
    };
  }, [unlockSpeech]);

  // Trigger an AI reply. Pulls the current transcript shape and posts a
  // turn from "AI Interviewer". Idempotent on its own — but we still
  // gate at the call site by message id (`repliedToRef`) so two fires
  // don't double-post.
  //
  // Falls back to an in-page scripted ladder when /api/interview-reply
  // is unreachable. This matters for two cases: (a) `vite dev` doesn't
  // execute Vercel serverless functions, so localhost would otherwise
  // get a 404 + non-JSON Vite SPA fallback that blew up resp.json();
  // (b) production transient failures of the function itself. Either
  // way the demo keeps moving and the badge flips honestly to
  // "scripted" so we don't claim more intelligence than is on the wire.
  const triggerInterviewerTurn = useCallback(
    async (forCandidateMessageId: number | 'opening') => {
      if (!code) return;
      setBusyReply(true);
      try {
        const stage = forCandidateMessageId === 'opening' ? 'opening' : pickStage(candidateTurns);
        const transcriptForLLM = messages
          .filter(m => m.type === 'msg')
          .map(m => ({
            speaker: speakerForMessage(m, candidateName),
            text: m.text,
          }));
        let resp: Response | null = null;
        try {
          resp = await fetch('/api/interview-reply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code, transcript: transcriptForLLM, stage, brief: brief ?? '' }),
          });
        } catch (e) {
          console.warn('[interview-reply] fetch threw, using client fallback', e);
        }

        let body: { text: string; ai: boolean; stage: Stage };
        if (resp && resp.ok) {
          // The function may also return non-JSON in dev (when Vite's SPA
          // fallback intercepts /api/* with index.html). Try-parse and
          // fall back if the body isn't a JSON envelope.
          try {
            body = (await resp.json()) as { text: string; ai: boolean; stage: Stage };
          } catch {
            body = { text: clientLadderLine(stage, transcriptForLLM), ai: false, stage };
          }
        } else {
          body = { text: clientLadderLine(stage, transcriptForLLM), ai: false, stage };
        }
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
    [code, messages, candidateTurns, brief, candidateName],
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

  // Voice demo layer: every new AI Interviewer message renders as text
  // AND tries to auto-play. Tries ElevenLabs (Rachel · American) via
  // /api/elevenlabs-tts first; falls back to the browser's built-in
  // speech synthesis if the function 503s (key not configured) or
  // 404s (vite dev without our dev plugin). Some browsers block all
  // audio until after the user's first interaction; we render the
  // visual audio bar either way and the unlock-on-first-gesture
  // listener primes both pipelines.
  useEffect(() => {
    if (!latestInterviewerMessage) return;
    if (spokenMessageRef.current === latestInterviewerMessage.id) return;
    spokenMessageRef.current = latestInterviewerMessage.id;
    const messageToSpeak = latestInterviewerMessage;
    setSpeakingMessageId(messageToSpeak.id);

    const fallbackTimer = window.setTimeout(() => {
      setSpeakingMessageId(current => (current === messageToSpeak.id ? null : current));
    }, Math.max(7000, messageToSpeak.text.length * 90));

    let cancelled = false;
    let activeAudio: HTMLAudioElement | null = null;
    let activeUrl: string | null = null;

    function clearSpeaking() {
      window.clearTimeout(fallbackTimer);
      setSpeakingMessageId(current => (current === messageToSpeak.id ? null : current));
    }

    async function playElevenLabsOrBrowser() {
      try {
        const resp = await fetch('/api/elevenlabs-tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: messageToSpeak.text }),
        });
        const ct = resp.headers.get('content-type') ?? '';
        if (!resp.ok || !ct.includes('audio/')) throw new Error('ElevenLabs unavailable');
        const blob = await resp.blob();
        if (cancelled) return;
        activeUrl = URL.createObjectURL(blob);
        activeAudio = new Audio(activeUrl);
        activeAudio.onended = clearSpeaking;
        activeAudio.onerror = clearSpeaking;
        await activeAudio.play();
        return;
      } catch {
        // Fall through to browser TTS.
      }
      if (cancelled || !('speechSynthesis' in window)) {
        clearSpeaking();
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(messageToSpeak.text);
      utterance.rate = 0.95;
      utterance.pitch = 1;
      utterance.onend = clearSpeaking;
      utterance.onerror = clearSpeaking;
      window.setTimeout(() => window.speechSynthesis.speak(utterance), 120);
    }

    void playElevenLabsOrBrowser();

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
      if (activeAudio) {
        activeAudio.pause();
        activeAudio.onended = null;
        activeAudio.onerror = null;
      }
      if (activeUrl) URL.revokeObjectURL(activeUrl);
    };

    return () => {
      window.clearTimeout(fallbackTimer);
      if (window.speechSynthesis.speaking) window.speechSynthesis.cancel();
    };
  }, [latestInterviewerMessage]);

  // Optional explicit text lets the mic auto-send a recognized
  // transcript without going through the input field at all. Default
  // pulls from `draft` (the typed input).
  async function sendCandidate(explicitText?: string) {
    unlockSpeech();
    const text = (explicitText ?? draft).trim();
    if (!code || !text) return;
    if (!explicitText) setDraft('');
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

  if (brief === null) {
    return (
      <div className="min-h-screen bg-surface-soft">
        <TopNav />
        <main className="max-w-2xl mx-auto px-6 py-12">
          <div className="bg-white border border-border rounded-2xl p-7 shadow-card">
            <div className="flex items-center gap-3 mb-1">
              <Link to="/templates" className="text-xs text-ink-faint hover:text-ink-muted">← Templates</Link>
            </div>
            <div className="flex items-start gap-4 mb-5 mt-3">
              <span className="text-4xl leading-none">{t.emoji}</span>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">{t.label}</h1>
                <p className="text-sm text-ink-soft mt-0.5">{t.tagline}</p>
              </div>
            </div>

            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-2">
              Interview brief <span className="normal-case font-normal text-ink-faint">(optional)</span>
            </h2>
            <textarea
              value={briefDraft}
              onChange={(e) => setBriefDraft(e.target.value)}
              placeholder={
                "What role is this for? Any company context the AI should know, must-cover topics, or things to avoid?\n\n" +
                "Example: Senior backend engineer, Python + Postgres + AWS. Probe API design and on-call instincts. We're a 40-person SaaS in fintech. Skip front-end depth. Don't share team names or comp."
              }
              rows={8}
              maxLength={4000}
              className="w-full resize-y px-3 py-2 bg-surface-softer border border-border rounded-lg text-sm leading-relaxed outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint"
            />
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-faint">
              <span>The candidate doesn't see this — only the AI uses it to tailor questions. Boundaries (no comp / individuals / financials / code generation) still apply regardless.</span>
              <span className="font-mono shrink-0 ml-3">{briefDraft.length}/4000</span>
            </div>

            <div className="mt-6 flex flex-col sm:flex-row gap-2">
              <button
                onClick={() => setBrief(briefDraft.trim())}
                className="flex-1 bg-accent text-white px-5 py-3 rounded-xl text-sm font-semibold hover:opacity-90 transition shadow-sm"
              >
                Start interview →
              </button>
              <button
                onClick={() => { setBriefDraft(''); setBrief(''); }}
                className="bg-white border border-border px-5 py-3 rounded-xl text-sm font-semibold text-ink-muted hover:bg-surface-soft transition"
              >
                Skip — use defaults
              </button>
            </div>
          </div>
        </main>
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
                (() => {
                  const speaker = speakerForMessage(m, candidateName);
                  return (
                    <li key={m.id} className="flex gap-3">
                      <div
                        className={
                          'shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold ' +
                          (speaker === 'interviewer'
                            ? 'bg-indigo-100 text-indigo-700'
                            : speaker === 'host'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-emerald-100 text-emerald-700')
                        }
                      >
                        {m.initials}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-semibold text-ink">{m.name}</span>
                          {speaker === 'interviewer' && (
                            <span className="text-[9px] font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 rounded px-1.5 py-0.5">
                              AI
                            </span>
                          )}
                          {speaker === 'host' && (
                            <span className="text-[9px] font-semibold text-amber-700 bg-amber-50 border border-amber-100 rounded px-1.5 py-0.5">
                              Host note
                            </span>
                          )}
                          <span className="text-[10px] text-ink-faint">{new Date(m.time).toLocaleTimeString()}</span>
                        </div>
                        <p className="text-[13px] leading-relaxed text-ink-soft whitespace-pre-wrap">{m.text}</p>
                        {speaker === 'interviewer' && (
                          <AudioReplyBar text={m.text} active={speakingMessageId === m.id} />
                        )}
                      </div>
                    </li>
                  );
                })()
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
                onFocus={unlockSpeech}
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
              <div className="flex items-center justify-end gap-2 relative">
                {/* Mic — records audio with MediaRecorder, sends to
                    /api/stt (ElevenLabs Scribe) on a 5-second silence
                    boundary, and the final transcript auto-sends as a
                    candidate message. Real-time interview feel: speak,
                    the AI hears, the AI replies with voice. */}
                <VoiceButton
                  onTranscript={(t) => { void sendCandidate(t); }}
                  disabled={!code}
                />
                <button
                  onClick={() => void sendCandidate()}
                  disabled={!code || !draft.trim()}
                  className="bg-accent text-white px-4 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
                >
                  Send
                </button>
              </div>
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

// (Inline waveform AudioReplyBar removed — Robin asked for compact
// chat-app voice pill design + click-to-replay + width that scales
// with text length. The shared `apps/web/src/components/AudioReplyBar`
// implementation now handles all three; importing it keeps the
// /templates/interview demo and the regular /r/<CODE> rooms visually
// consistent.)
