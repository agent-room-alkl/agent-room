// Compact voice-message pill — modeled on WhatsApp / Telegram / WeChat
// voice bubbles. Robin's prior feedback: the original waveform was
// "way too big" and (after the redesign) "couldn't be clicked to
// replay" and "the bar length should match the text length."
//
// Behaviour:
//   • Width scales with text length so a one-line "Hi." renders a
//     short pill and a 200-word answer renders a long one (capped to
//     keep narrow bubbles tidy).
//   • Click ▶ to (re-)play. Audio fetches /api/elevenlabs-tts and
//     plays the returned MP3 via <Audio>; falls back to browser TTS
//     if the function 503s / 404s / returns non-audio.
//   • A real progress bar fills as audio plays — driven by the
//     internal <Audio>.timeupdate when we own the pipeline (manual
//     play), or by the parent's `progress` prop when Room.tsx is
//     auto-playing the same message.
//   • Duration counter is computed from the actual audio duration
//     once playback starts; before that it falls back to a
//     ~14-chars-per-second estimate so the user sees a sensible
//     placeholder.
//
// Pure component still — no refs reach outside, no global state.
// Each bubble has its own pill instance with its own audio.

import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Text the bar speaks when the user clicks ▶. */
  text: string;
  /** True when this message is currently being auto-played by the
   *  parent's room-level pipeline. The pill shows the playing state
   *  but doesn't double-play (we don't fire our own audio while the
   *  parent is already speaking). */
  active: boolean;
  /** Optional 0..1 progress when the parent is the source of truth
   *  (auto-play). When the user manually clicks our internal ▶, we
   *  drive progress from the local <Audio> instead. */
  externalProgress?: number;
  /** Optional duration hint from the parent for the auto-play case. */
  externalDurationSec?: number;
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Width in CSS pixels of the progress track. Scales with text
 *  length but stays inside narrow bubbles. */
function trackWidthFor(text: string): number {
  const len = text.trim().length;
  // ~1.4px per char, clamped 56..280. Matches the rough WhatsApp
  // visual feel: a single sentence ≈ 100-130px, a paragraph maxes
  // out around 280.
  return Math.min(280, Math.max(56, Math.round(len * 1.4)));
}

export function AudioReplyBar({ text, active, externalProgress, externalDurationSec }: Props) {
  // Local manual-play state. When the user clicks ▶ we own the audio
  // pipeline for this bubble; when the parent's auto-play pipeline is
  // running (active=true), we read progress / duration from props.
  const [localPlaying, setLocalPlaying] = useState(false);
  const [localProgress, setLocalProgress] = useState(0);
  const [localDuration, setLocalDuration] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  // Stop / cleanup on unmount.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.onended = null;
        audioRef.current.ontimeupdate = null;
        audioRef.current.onerror = null;
        audioRef.current.onloadedmetadata = null;
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  async function playOnce() {
    if (busy) return;
    if (active) return; // parent is already speaking it; don't double-fire
    setBusy(true);
    setLocalProgress(0);
    setLocalDuration(null);
    try {
      // Stop any prior local playback first (the user may have clicked
      // ▶ on a different bubble; the browser otherwise overlaps audio).
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }

      const resp = await fetch('/api/elevenlabs-tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const ct = resp.headers.get('content-type') ?? '';
      if (!resp.ok || !ct.includes('audio/')) throw new Error('elevenlabs unavailable');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration)) setLocalDuration(audio.duration);
      };
      audio.ontimeupdate = () => {
        if (audio.duration > 0) setLocalProgress(Math.min(1, audio.currentTime / audio.duration));
      };
      audio.onended = () => {
        setLocalPlaying(false);
        setLocalProgress(1);
      };
      audio.onerror = () => {
        setLocalPlaying(false);
      };
      setLocalPlaying(true);
      await audio.play();
    } catch {
      // Fall back to browser TTS so the user always gets *some* voice.
      try {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(text);
          u.rate = 0.95;
          u.onend = () => { setLocalPlaying(false); setLocalProgress(1); };
          u.onerror = () => { setLocalPlaying(false); };
          setLocalPlaying(true);
          window.speechSynthesis.speak(u);
        } else {
          setLocalPlaying(false);
        }
      } catch {
        setLocalPlaying(false);
      }
    } finally {
      setBusy(false);
    }
  }

  function stopLocal() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    }
    setLocalPlaying(false);
    setLocalProgress(0);
  }

  // Decide which source of truth to display.
  const effectiveActive = active || localPlaying;
  const effectiveProgress = active ? (externalProgress ?? 0) : localProgress;
  const effectiveDuration = (active ? externalDurationSec : localDuration) ?? estimateDurationSec(text);
  const remaining = Math.max(0, effectiveDuration * (1 - effectiveProgress));
  const trackWidth = trackWidthFor(text);

  return (
    <button
      type="button"
      onClick={localPlaying ? stopLocal : playOnce}
      disabled={busy}
      aria-label={effectiveActive ? 'Pause voice playback' : 'Play voice message'}
      className={
        'mt-1.5 inline-flex items-center gap-2 rounded-full border px-2 py-1 transition ' +
        (effectiveActive
          ? 'border-indigo-300 bg-indigo-50/80'
          : 'border-border-faint bg-surface-softer hover:bg-surface-soft hover:border-border')
      }
    >
      <span
        aria-hidden
        className={
          'flex items-center justify-center shrink-0 w-5 h-5 rounded-full text-[10px] leading-none ' +
          (effectiveActive ? 'bg-indigo-500 text-white' : 'bg-indigo-100 text-indigo-700')
        }
      >
        {effectiveActive ? '▎▎' : '▶'}
      </span>

      <div
        className="relative h-1 rounded-full bg-indigo-100 overflow-hidden"
        style={{ width: `${trackWidth}px` }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-indigo-500 transition-[width] duration-100 ease-linear"
          style={{ width: `${Math.round(Math.max(0, Math.min(1, effectiveProgress)) * 100)}%` }}
        />
      </div>

      <span className="text-[10px] tabular-nums text-ink-faint shrink-0 leading-none">
        {fmt(remaining)}
      </span>
    </button>
  );
}

function estimateDurationSec(text: string): number {
  // ~14 chars/sec at the rate ElevenLabs uses by default. Used as a
  // visual placeholder before the audio's real duration is known.
  return Math.max(1, text.trim().length / 14);
}
