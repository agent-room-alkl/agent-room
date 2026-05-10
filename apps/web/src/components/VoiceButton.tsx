// Server-STT microphone button. Robin's read on browser-native
// SpeechRecognition: "网页麦克风 怎么能翻译的好呢" + "这个转的不对"
// — the in-browser recognizer mis-transcribes Chinese, drops words on
// long sentences, and double-fires the trailing phrase. Replaced
// with: MediaRecorder records, an Web Audio meter watches for
// silence, on commit we POST the audio blob to /api/stt (ElevenLabs
// Scribe) and use the high-quality transcript that comes back.
//
// Behaviour the caller sees is byte-identical: each finished spoken
// turn fires onTranscript(text) once. Hot-mic is preserved — after
// a turn commits, the recorder restarts so the user can keep
// answering question after question without re-clicking the mic.
//
// Why a separate /api/stt rather than calling Scribe straight from
// the browser? Same reason as TTS: the API key stays in Vercel env
// vars / dev plugin instead of the public bundle.

import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Fired once per spoken turn after the user is quiet for `silenceMs`. */
  onTranscript: (text: string) => void;
  disabled?: boolean;
  /** Milliseconds of silence after the last detected speech before
   *  the current turn is committed. Default 5000 — Robin's "等我不说话
   *  大概5秒后才结束". */
  silenceMs?: number;
  /** Hard upper bound for one hot-mic turn. Prevents background media
   *  or nonstop speech from turning into one giant room message. */
  maxTurnMs?: number;
  /** Optional language hint passed to Scribe as `language_code` (e.g.
   *  'zh', 'en'). Omit to let Scribe auto-detect. */
  lang?: string;
}

// VAD threshold: any frame with RMS amplitude below this counts as
// silence. Tuned for built-in laptop mics in a quiet room. A noisy
// office may need raising; the hot-mic loop is forgiving since we
// keep recording across silence and only commit once silenceMs has
// elapsed without speech.
const SILENCE_RMS = 0.02;
// Minimum recording duration before we'll commit. Stops the recorder
// from posting half-second blobs of throat-clearing.
const MIN_TURN_MS = 600;
const DEFAULT_MAX_TURN_MS = 90_000;

const AUDIO_EVENT_TAG_RE = /[\[(（【][^\])）】]{1,32}[\])）】]/gu;

function normalizeTranscript(raw: string): string {
  return raw
    .replace(AUDIO_EVENT_TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMeaningfulTranscript(text: string): boolean {
  const compact = text.replace(/[^\p{L}\p{N}]+/gu, '');
  return compact.length >= 2;
}

export function VoiceButton({ onTranscript, disabled, silenceMs = 5000, maxTurnMs = DEFAULT_MAX_TURN_MS, lang }: Props) {
  // Three-state lifecycle: 'idle' (mic off), 'recording' (capturing
  // audio), 'transcribing' (audio uploaded, waiting on Scribe). We
  // surface this on the button so the user knows the system isn't
  // frozen during the upload round-trip.
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [meter, setMeter] = useState(0); // 0..1 input level for the bar
  const [elapsedMs, setElapsedMs] = useState(0);

  // The `listening` flag is the user's intent — do they want the mic
  // hot? We keep it in a ref so MediaRecorder/AudioContext callbacks
  // (which run outside React) can read the latest value without a
  // stale closure.
  const listeningRef = useRef(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const turnStartRef = useRef<number>(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Browsers without MediaRecorder (very old) get a hidden no-op
  // button. SpeechRecognition fallback is gone — we deliberately
  // chose Scribe quality over double-pipeline complexity.
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return null;
  }

  function pickMimeType(): string | undefined {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return undefined;
  }

  function clearMeterLoop() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  function clearElapsedTimer() {
    if (elapsedTimerRef.current !== null) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }

  async function startMic() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const { showToast } = await import('./Toast.js');
      showToast(`Mic permission denied: ${e instanceof Error ? e.message : String(e)}`);
      listeningRef.current = false;
      setState('idle');
      return;
    }
    streamRef.current = stream;

    // Audio analyser for VAD.
    const AC: typeof AudioContext = (window.AudioContext || (window as any).webkitAudioContext);
    const ctx = new AC();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    analyserRef.current = analyser;

    // Recorder.
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    recorder.onstop = () => {
      // commitTurn is what actually sends. onstop is the natural
      // place to flush — it fires whether the recorder was stopped
      // by the silence detector or by the user clicking off.
      const blob = chunksRef.current.length
        ? new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        : null;
      chunksRef.current = [];
      const turnLen = Date.now() - turnStartRef.current;
      const tooShort = turnLen < MIN_TURN_MS;
      if (blob && !tooShort) {
        void uploadAndCommit(blob);
      } else {
        // Too short / empty — treat as a silent click and just
        // restart the recorder if the user still wants to listen.
        if (listeningRef.current) startRecording();
        else fullyStop();
      }
    };

    startRecording();
    runMeterLoop();
    setState('recording');
  }

  function startRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state !== 'inactive') return;
    chunksRef.current = [];
    silenceStartRef.current = null;
    turnStartRef.current = Date.now();
    setElapsedMs(0);
    clearElapsedTimer();
    elapsedTimerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - turnStartRef.current);
    }, 200);
    try {
      recorder.start(250); // emit chunks every 250ms so onstop has data already
    } catch {
      // start() can throw if the recorder was just stopped. Try once more next tick.
      setTimeout(() => {
        try { recorder.start(250); } catch { /* give up; user can re-click */ }
      }, 100);
    }
  }

  function runMeterLoop() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (!listeningRef.current || !analyserRef.current) return;
      analyserRef.current.getFloatTimeDomainData(buf);
      // RMS amplitude of the frame.
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
      const rms = Math.sqrt(sum / buf.length);
      setMeter(Math.min(1, rms * 12)); // scale up for visual punch
      const now = Date.now();
      const recorder = recorderRef.current;
      if (now - turnStartRef.current >= maxTurnMs) {
        silenceStartRef.current = null;
        if (recorder && recorder.state === 'recording') {
          try { recorder.stop(); } catch { /* ignore */ }
        }
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (rms < SILENCE_RMS) {
        if (silenceStartRef.current === null) silenceStartRef.current = now;
        else if (now - silenceStartRef.current >= silenceMs) {
          // Commit current turn.
          silenceStartRef.current = null;
          if (recorder && recorder.state === 'recording') {
            try { recorder.stop(); } catch { /* ignore */ }
          }
        }
      } else {
        silenceStartRef.current = null;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  async function uploadAndCommit(blob: Blob) {
    setState('transcribing');
    clearElapsedTimer();
    setElapsedMs(0);
    try {
      const url = lang ? `/api/stt?lang=${encodeURIComponent(lang)}` : '/api/stt';
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (resp.ok) {
        const body = (await resp.json()) as { text?: string };
        const text = normalizeTranscript(body.text ?? '');
        if (hasMeaningfulTranscript(text)) onTranscript(text);
      } else {
        // Surface but keep mic hot — user can try again.
        const detail = await resp.text().catch(() => '');
        const { showToast } = await import('./Toast.js');
        showToast(`Transcription failed: ${detail.slice(0, 80) || resp.status}`);
      }
    } catch (e) {
      const { showToast } = await import('./Toast.js');
      showToast(`Transcription failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (listeningRef.current) {
      setState('recording');
      startRecording();
    } else {
      fullyStop();
    }
  }

  function fullyStop() {
    listeningRef.current = false;
    clearMeterLoop();
    clearElapsedTimer();
    silenceStartRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    streamRef.current = null;
    const ctx = audioCtxRef.current;
    if (ctx) {
      void ctx.close().catch(() => { /* ignore */ });
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
    setMeter(0);
    setElapsedMs(0);
    setState('idle');
  }

  function start() {
    listeningRef.current = true;
    void startMic();
  }

  function stop() {
    listeningRef.current = false;
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') {
      // Trigger onstop → uploadAndCommit (final flush) → fullyStop.
      try { recorder.stop(); } catch { fullyStop(); }
    } else {
      fullyStop();
    }
  }

  useEffect(() => {
    return () => fullyStop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sec = Math.floor(elapsedMs / 1000);
  const maxSec = Math.round(maxTurnMs / 1000);
  const elapsedLabel = state === 'recording'
    ? `${sec}s`
    : state === 'transcribing'
    ? '…'
    : '';

  return (
    <>
      <button
        type="button"
        disabled={disabled || state === 'transcribing'}
        onClick={state === 'idle' ? start : stop}
        aria-label={state === 'idle' ? 'Start listening' : state === 'recording' ? 'Stop listening' : 'Transcribing'}
        title={
          state === 'idle' ? 'Start streaming voice input'
          : state === 'recording' ? 'Stop (commit current turn)'
          : 'Transcribing your speech…'
        }
        className={`text-base leading-none w-9 h-9 flex items-center justify-center rounded-lg transition ${
          state === 'recording'
            ? 'bg-red-100 text-red-600 animate-pulse'
            : state === 'transcribing'
            ? 'bg-amber-100 text-amber-700'
            : 'bg-surface-softer text-ink-soft hover:bg-accent-tint hover:text-accent'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {state === 'transcribing' ? '⋯' : '🎤'}
      </button>
      {state !== 'idle' && (
        <div className="absolute left-3 right-3 -top-7 px-3 py-1 bg-accent-tint text-accent-deep text-[11px] italic rounded-full shadow-sm flex items-center gap-2 pointer-events-none">
          {state === 'recording' && (
            <>
              <span className="inline-flex items-end gap-[1.5px] h-3">
                {[0.25, 0.6, 0.9, 0.6, 0.25].map((scale, i) => (
                  <span
                    key={i}
                    className="w-[2px] bg-accent rounded-full transition-[height] duration-75"
                    style={{ height: `${Math.max(2, meter * 100 * scale)}%` }}
                  />
                ))}
              </span>
              <span className="truncate">Listening… {elapsedLabel} (auto-sends after ~{Math.round(silenceMs / 1000)}s silence, max {maxSec}s)</span>
            </>
          )}
          {state === 'transcribing' && (
            <span className="truncate">Transcribing your turn with Scribe…</span>
          )}
        </div>
      )}
    </>
  );
}
