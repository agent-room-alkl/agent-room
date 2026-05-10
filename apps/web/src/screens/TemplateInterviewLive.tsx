// Plan B Phase 1+ — /templates/interview host monitor.
//
// Two-step flow, both rendered by this same component:
//   /templates/interview        → host setup form (interview brief)
//   /templates/interview/:code  → host monitor view (transcript +
//                                 candidate share link + host-note input)
//
// Host setup → on Start:
//   1. createRoom() with a fresh code, host as the creator.
//   2. joinRoom() the host as a web participant with role='Host'.
//   3. joinRoom() the AI Interviewer as a cc participant.
//   4. Persist the brief to sessionStorage keyed by room code.
//   5. Soft-navigate to /templates/interview/:code so a refresh restores
//      the monitor view.
//
// Host monitor view:
//   - Renders the live transcript (host notes labeled, AI replies played).
//   - Shows the share link the host gives the candidate (/r/:code).
//   - Drives the AI: only this browser POSTs /api/interview-reply, so
//     brief stays in host scope and per-IP cost caps apply once.
//
// Candidate flow:
//   - Candidate opens /r/:code (existing Room.tsx).
//   - They post messages as a web participant; speakerForMessage()
//     resolves them to 'candidate' on the host side, which advances
//     the interview stage and triggers the next AI question.
//   - Candidate doesn't see the brief; the AI reads it via the host
//     browser only.
//
// Critical property held since the original demo: the room is REAL.
// Two browsers (host + candidate) participate in one Upstash-backed
// room, the export pipeline (room_export → /r/CODE/report) works, and
// every AI line is a real message in storage.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
import { templateBySlug } from '../lib/liveTemplates.js';
import { copyText } from '../lib/copy.js';

const HOST_NAME = 'Host';
const briefStorageKey = (code: string) => `agent-room:interview-brief:${code}`;

type Stage = 'opening' | 'depth' | 'tradeoffs' | 'behavioral' | 'wrap';
type InterviewSpeaker = 'host' | 'candidate' | 'interviewer';

const INTERVIEWER_NAME = 'AI Interviewer';

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

function speakerForMessage(message: Message): InterviewSpeaker {
  if (message.name === INTERVIEWER_NAME && message.client === 'cc') return 'interviewer';
  if (message.role === 'Host' || message.role === 'host') return 'host';
  // Everyone else on web is the candidate (they joined via /r/:code
  // and chose their own name there). Non-web non-host non-AI clients
  // (e.g. an MCP-driven scorer agent down the road) also fall here for
  // now and would need their own role check before they're added.
  return 'candidate';
}

export function TemplateInterviewLive() {
  // Static template metadata (status pill, pricing, pilot CTA). We keep
  // the buyer story rendered on the page so the live demo stays
  // commercially honest — visitors see what would be sold AND what's
  // running today.
  const t = useMemo(() => templateBySlug('interview'), []);

  // urlCode === string when we're on /templates/interview/:code (host
  // monitor view, room already created); undefined when we're on the
  // bare /templates/interview setup form. The same component handles
  // both because the setup step soft-navigates into the monitor URL
  // after createRoom — keeping component state intact across the route
  // change. A fresh mount on /:code (e.g. host refreshed) hits the
  // urlCode branch in the setup effect below and skips createRoom.
  const { code: urlCode } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const [code, setCode] = useState<string | null>(urlCode ?? null);
  const [setupError, setSetupError] = useState<string | null>(null);
  // brief === null means the host hasn't submitted the setup form yet;
  // brief === '' means submitted with no extra context (use the default
  // SMB SaaS engineering persona). Gating room creation on brief !== null
  // means the AI gets the host's tailoring on its very first turn rather
  // than after the candidate has already started talking. On a fresh
  // mount of /templates/interview/:code we hydrate brief from
  // sessionStorage (Codex's suggestion: refresh-safe without a server
  // schema change).
  const [brief, setBrief] = useState<string | null>(() => {
    if (!urlCode) return null;
    if (typeof sessionStorage === 'undefined') return '';
    return sessionStorage.getItem(briefStorageKey(urlCode)) ?? '';
  });
  const [briefDraft, setBriefDraft] = useState('');
  // The visitor of /templates/interview is always the Host, not a
  // candidate. Candidates land via the share link → /r/:code (existing
  // Room.tsx). The HOST_NAME constant keeps speakerForMessage's
  // role-based heuristic consistent so the host's notes don't get
  // counted as candidate answers in scorecard logic later.
  const candidateName = HOST_NAME;
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

    // Host-monitor mount: /templates/interview/:code refresh case. Room
    // already exists (created during a previous setup submit); we just
    // need to populate `code` so useRoom starts polling. Brief was
    // hydrated from sessionStorage in the initial state above.
    if (urlCode) {
      setupRef.current = true;
      setCode(urlCode);
      return;
    }

    // Setup form mount: wait for the host to submit the brief.
    if (brief === null) return;
    setupRef.current = true;

    (async () => {
      try {
        const newCode = generateCode();
        const client = createClient(ENV.upstash);
        await createRoom(client, {
          code: newCode,
          topic: 'AI Interview',
          createdBy: HOST_NAME,
        });
        // Join self as Host (web). createRoom already adds the creator
        // as the first participant, but we joinRoom again with
        // priorIdentity so refreshes don't add a "(2)". The candidate
        // doesn't join here — they land on /r/:code via the share link
        // and pick their own display name there.
        await joinRoom(
          client,
          newCode,
          {
            name: HOST_NAME,
            role: 'Host',
            color: colorForName(HOST_NAME),
            initials: initialsFor(HOST_NAME),
            client: 'web',
            joinedAt: Date.now(),
            lastSeenAt: Date.now(),
          },
          { priorIdentity: { name: HOST_NAME, client: 'web' } },
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
        // Persist brief so a host refresh on /templates/interview/:code
        // restores the same context without re-prompting.
        if (typeof sessionStorage !== 'undefined') {
          try { sessionStorage.setItem(briefStorageKey(newCode), brief ?? ''); } catch {}
        }
        setCode(newCode);
        // Soft-navigate into the monitor URL. Same component instance
        // continues — `setupRef.current` is already true so this effect
        // doesn't re-fire on the route change.
        navigate(`/templates/interview/${newCode}`, { replace: true });
      } catch (e) {
        setSetupError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [urlCode, brief, navigate]);

  const { room, messages, error: roomError } = useRoom(code ?? '', candidateName);

  // Count messages whose speaker resolves to 'candidate' — the actual
  // interviewee joining via /r/:code, not the host's own notes. Stage
  // progression keys off this, so getting the count right matters.
  const candidateTurns = useMemo(
    () => messages.filter(m => m.type === 'msg' && speakerForMessage(m) === 'candidate').length,
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
            speaker: speakerForMessage(m),
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
  // fire the next interviewer turn. Candidate is identified by
  // speakerForMessage (role-based), not by name — the candidate
  // chose their own display name when joining /r/:code so we can't
  // match on `name === candidateName` here.
  //
  // Only the host browser runs this trigger logic — the candidate's
  // /r/:code Room.tsx never calls /api/interview-reply, which keeps
  // brief, LLM cost, and turn pacing on a single trusted controller.
  useEffect(() => {
    if (!code) return;
    if (busyReply) return;
    const lastCandidate = [...messages].reverse().find(m =>
      m.type === 'msg' && speakerForMessage(m) === 'candidate',
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
          body: JSON.stringify({ text: messageToSpeak.text, code }),
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

  // Send a Host note. Posted as role='Host' so speakerForMessage()
  // resolves to 'host' on every consumer (transcript label, scorecard
  // logic, /api/interview-reply schema). A host note is visible to
  // both the candidate and the AI; the AI treats it as context, not
  // as a candidate answer (see the host-as-context handling in
  // api/interview-reply.ts post-A6d2d46a).
  async function sendHostNote() {
    unlockSpeech();
    const text = draft.trim();
    if (!code || !text) return;
    setDraft('');
    const client = createClient(ENV.upstash);
    const msg: Message = {
      id: Date.now(),
      type: 'msg',
      name: HOST_NAME,
      role: 'Host',
      color: colorForName(HOST_NAME),
      initials: initialsFor(HOST_NAME),
      client: 'web',
      text,
      time: Date.now(),
    };
    try {
      await appendMessage(client, code, msg);
    } catch (e) {
      console.error('[host note send] failed', e);
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
            You're the host. Share the candidate link below and the AI Interviewer will run the
            screen with whoever joins. You stay an observer here — your messages post as Host
            notes the AI uses for context, never as candidate answers in the scorecard.
          </p>
          {code && (
            <p className="text-[11px] text-slate-500 mt-3 font-mono">
              Room: <Link to={`/r/${code}`} className="text-slate-300 hover:text-white underline">/r/{code}</Link>
              {' · '}
              <Link to={`/r/${code}/report`} className="text-slate-300 hover:text-white underline">view scorecard once the interview wraps</Link>
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
                  const speaker = speakerForMessage(m);
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

            <div className="border-t border-border-faint pt-3 mt-3 flex flex-col gap-3">
              {code && (
                <div className="bg-accent-tint border border-accent-tint-border rounded-lg p-3 flex flex-col gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-accent-deep">
                    Candidate share link
                  </div>
                  <div className="flex items-stretch gap-2">
                    <input
                      readOnly
                      value={`${typeof window === 'undefined' ? '' : window.location.origin}/r/${code}`}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 min-w-0 font-mono text-[12px] px-2.5 py-1.5 bg-white border border-accent-tint-border rounded-md text-ink-soft outline-none focus:border-accent"
                    />
                    <button
                      onClick={() => copyText(`${window.location.origin}/r/${code}`, 'Link copied')}
                      className="shrink-0 bg-accent text-white px-3 py-1.5 rounded-md text-[11px] font-semibold hover:opacity-90 transition"
                    >
                      Copy
                    </button>
                  </div>
                  <p className="text-[11px] text-ink-soft leading-snug">
                    Send this link to the candidate. They join from any browser — no signup. The
                    AI Interviewer is already in the room; the screen begins as soon as they say
                    hello.
                  </p>
                </div>
              )}
              <textarea
                value={draft}
                onFocus={unlockSpeech}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void sendHostNote();
                  }
                }}
                placeholder={code ? 'Add a host note (visible to AI as context, also visible to the candidate). Optional.' : 'Setting up…'}
                rows={2}
                disabled={!code}
                className="w-full resize-none px-3 py-2 bg-surface-softer border border-border rounded-lg text-sm leading-relaxed outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint disabled:opacity-50"
              />
              <div className="flex items-center justify-end gap-2 relative">
                <button
                  onClick={() => void sendHostNote()}
                  disabled={!code || !draft.trim()}
                  className="bg-ink text-white px-4 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
                >
                  Post host note
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
