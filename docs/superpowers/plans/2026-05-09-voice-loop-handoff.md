# Voice loop — 2026-05-09 handoff

End of day. Voice path works end-to-end on `claude/plan-b-template-pages` (PR #30).
Tomorrow's job: close the hot-mic guardrails. This doc is the pickup memo so you don't
need to re-read the chat scrollback.

## What works today

- **Mic in `/r/<CODE>`** opens MediaRecorder, runs RMS-based VAD, commits a chunk
  after 5 s of silence, restarts the recorder (hot-mic), uploads chunks to
  `/api/stt`.
- **`/api/stt`** proxies to ElevenLabs Scribe (`scribe_v1`), returns `{ text, language }`.
  - `tag_audio_events=false`, `diarize=false` set on every upload (cc9f3e8)
  - bracket-tag stripper (`(...)` / `[...]` ≤ 32 chars) belt-and-suspenders
- **Vite dev plugin** mirrors prod `/api/stt` end-to-end so `npm -w apps/web run dev`
  exercises the same Scribe path.
- **AI replies are spoken back** via `/api/elevenlabs-tts` (Rachel, multilingual_v2).
  Three guards: baseline cursor, dedup `Set<id>`, self-skip.
- **AudioReplyBar** is the WhatsApp-style pill: click ▶ to replay, width
  `clamp(text.length * 1.4, 56, 280)px`, real progress from `<audio>.timeupdate`.

## This session's commits (on `claude/plan-b-template-pages`)

```
cc9f3e8  fix(stt): suppress Scribe audio-event tags + diarization
4dcb33f  feat(web,api): replace browser STT with ElevenLabs Scribe via /api/stt
35a4db8  feat(web): mic stays hot across turns — silence commits, doesn't close
604007a  feat(web): VoiceButton streams continuously, commits after 5s silence
0c0035b  feat(web): mic auto-sends transcript — speak, AI hears, AI replies
902f673  feat(web): voice pill is clickable to replay + width scales with text
```

## Open bug found at end of session

**Hot-mic transcribes background audio as phantom user messages.**

Reproduction: open `/r/<CODE>`, hit the mic button, then play any video/podcast
in the background. After ~5 s of "silence" relative to your voice, Scribe gets
fed a chunk of the video soundtrack, dutifully transcribes it, and the result
posts into the room as a real user message (with the participant's display name).

Robin's session showed a 1300-character "dolphins / sea lions / subscribe & like"
ramble appearing under the `test` participant — which was actually his own
browser tab leaking a YouTube clip's audio.

This is a product bug, not a Scribe quality bug. Scribe is doing its job; the
client should not be feeding it long noise tails.

## Tomorrow's prioritized backlog

Order is what I'd ship first. None of these need new infra — they're all
surgical edits to `apps/web/src/components/VoiceButton.tsx` and `api/stt.ts`.

### B+D first (the fix to today's bug). ~45 min.

1. **B. 90 s hard-cap chunker** — VoiceButton MUST stop the current
   MediaRecorder when its accumulated duration ≥ 90 s, even if RMS-VAD hasn't
   detected silence. Then immediately restart a fresh recorder. This caps the
   biggest single phantom message at ~90 s of audio (≈ 200–250 transcribed
   words) instead of unbounded.
2. **noise-only drop** — both client and `/api/stt`. After bracket-tag strip,
   if the resulting text has fewer than 3 non-whitespace chars or is entirely
   punctuation, return `{ text: "" }` from the API and short-circuit the
   `onTranscript` call on the client. This kills `(ambient noise)` →
   empty-string drift.
3. **D. friendly 25 MB error** — currently `/api/stt` returns 413 with
   `payload_too_large` and the VoiceButton silently swallows it. Surface a
   toast `录音过长，已自动重启`.

### A second (UX affordance). ~1 h.

4. **"转写中…" state** — VoiceButton already has `transcribing` internal state.
   Surface it: render a small label in the floating mic strip while the chunk
   is in flight to `/api/stt`. Without this, users think the mic is broken
   during the 1–2 s gap between commit and transcript arrival.
5. **Transcript preview** — when `/api/stt` returns, echo the text into the
   composer input as half-opacity preview for ~600 ms before auto-sending.
   Gives the user a "this is what it heard" beat. Cheap confidence builder.

### C nice-to-have. ~30 min.

6. **Recording duration counter** — show "0:42" climbing in the mic strip.
   Highlight red at 80 s so the user knows the 90-s chunker is about to fire.

## Files involved

- `apps/web/src/components/VoiceButton.tsx` — all client work (B, D-toast, A, C)
- `api/stt.ts` — server-side noise-only drop + fix the existing bracket-strip
  to skip empty results without 200-OK-empty
- `apps/web/vite.config.ts` — keep dev plugin in lockstep with `api/stt.ts`
  changes (the hardest-to-remember chore — every `api/stt.ts` change needs a
  mirror edit here, otherwise local dev silently diverges from prod)
- `apps/web/src/screens/Room.tsx` — only if we want to surface a toast for
  413 / dropped-empty events (otherwise no change needed)

## How to test

```sh
# 1. local dev
cd /Users/robin/Project/agent-room/.claude/worktrees/vigilant-albattani-2c99e4
git checkout claude/plan-b-template-pages
git pull
npm -w apps/web run dev   # vite on :5173
# .env.local must have ELEVENLABS_API_KEY (already set) and the
# VITE_UPSTASH_REDIS_REST_URL / _TOKEN public demo creds

# 2. open a room
# create one in another tab (Codex or `room_create` MCP), grab CODE,
# visit http://localhost:5173/r/<CODE>, hit the mic button.

# 3. for the bug repro
# play any youtube clip on the same machine. wait. watch a phantom
# message arrive in the room with whatever the video soundtrack said.

# 4. for the fix verification
# after B+D land, the same setup should produce no phantom messages
# unless you actually speak; long ambient noise should chunk every
# 90 s and each chunk should be dropped if it doesn't reach the
# noise-only threshold.
```

## Risk notes

- `MediaRecorder.stop()` + immediate `new MediaRecorder()` has a small (~50 ms)
  window where audio is dropped. For a 90-s cap this is fine; for shorter
  caps we'd want overlapping recorders. Don't optimize for now.
- The Scribe response when you upload pure silence/noise is variable —
  sometimes empty string, sometimes a hallucination, sometimes `(silence)`.
  The noise-only drop must be defensive: strip → trim → length check → drop.
- `tag_audio_events=false` reduces but does not eliminate Scribe's bracket
  tags. Keep the regex strip even after the API param is set. (Confirmed by
  cc9f3e8 review.)

## Out of scope for tomorrow

- Push-to-talk mode. Hot-mic is what Robin asked for explicitly; we'd be
  reversing that decision. The chunker + noise-drop should make hot-mic
  workable without a mode switch.
- Server-side speaker diarization. We pass `diarize=false` because uploads
  are per-participant per-chunk; meeting-wide diarization belongs in a
  different pipeline.
- Live partial-transcript streaming (Scribe doesn't expose it on the
  speech-to-text endpoint, only on Conversational AI). Don't promise this
  in copy.
