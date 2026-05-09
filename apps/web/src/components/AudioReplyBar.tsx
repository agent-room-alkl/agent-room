// Compact voice-message pill — modeled on WhatsApp / Telegram / WeChat
// voice bubbles. The previous design was a 14-bar pulsing waveform
// stretched across the whole bubble; Robin called that out as "way too
// big" — he wanted real chat-app voice UX.
//
// Design:
//   ▶  ━━━━━━━━━━━━━━━━  0:08
//   24px button   thin progress  duration
//
// Total height ~28px, narrow padding, doesn't dominate the message
// bubble. The progress bar fills as audio plays (driven by `progress`
// 0..1 from the parent). Duration is computed from text length when
// the parent doesn't know yet (~14 chars/sec at the rate ElevenLabs
// uses by default), then refines if a real duration arrives.
//
// Rendering is pure — Room.tsx owns the actual playback pipeline and
// passes both `active` (this is the message being spoken) and
// optionally `progress`. With no progress, we keep the bar idle but
// still clearly show "voice is available."

interface Props {
  active: boolean;
  /** 0..1 fraction of playback complete. 0 when not playing. */
  progress?: number;
  /** Optional caller-known duration in seconds. Used to render the
   *  duration counter. If omitted, parent can pass nothing and the
   *  bar shows just "Voice" instead of seconds. */
  durationSec?: number;
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AudioReplyBar({ active, progress = 0, durationSec }: Props) {
  const remaining = durationSec !== undefined ? Math.max(0, durationSec * (1 - progress)) : null;

  return (
    <div
      role="group"
      aria-label={active ? 'Voice message playing' : 'Voice message'}
      className={
        'mt-1.5 inline-flex items-center gap-2 rounded-full border px-2 py-1 ' +
        (active
          ? 'border-indigo-300 bg-indigo-50/80'
          : 'border-border-faint bg-surface-softer hover:bg-surface-soft transition')
      }
    >
      {/* Play / playing-pulse glyph. We keep it as a simple shape
          (▶ / ▎▎) so the bar stays small and doesn't need an icon
          dependency. The visual swap is enough to tell active from idle. */}
      <span
        aria-hidden
        className={
          'flex items-center justify-center shrink-0 w-5 h-5 rounded-full text-[10px] leading-none ' +
          (active ? 'bg-indigo-500 text-white' : 'bg-indigo-100 text-indigo-700')
        }
      >
        {active ? '▎▎' : '▶'}
      </span>

      {/* Thin progress track + fill — minimum width keeps the pill
          readable inside narrow message bubbles, max-width caps it
          short of overwhelming the text above it. */}
      <div className="relative h-1 w-24 sm:w-28 rounded-full bg-indigo-100 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-indigo-500 transition-[width] duration-150 ease-linear"
          style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }}
        />
      </div>

      <span className="text-[10px] tabular-nums text-ink-faint shrink-0 leading-none">
        {remaining !== null ? fmt(remaining) : 'voice'}
      </span>
    </div>
  );
}
