// Vercel Function: server-side STT proxy. The browser uploads recorded
// audio (any MediaRecorder-friendly mime — webm/opus on Chrome,
// mp4/aac on Safari, ogg/opus on Firefox) and we forward to
// ElevenLabs Scribe so:
//   • the API key never ships to the client bundle;
//   • we get high-quality multilingual transcription (Robin's complaint
//     about browser SpeechRecognition was specifically Chinese and
//     long-sentence accuracy — Scribe handles both materially better);
//   • a single key (`ELEVENLABS_API_KEY`) covers both TTS and STT,
//     keeping Vercel env config minimal.
//
// Same lessons as api/elevenlabs-tts.ts: no workspace imports, all
// inputs validated, errors mapped to JSON.

import type { VercelRequest, VercelResponse } from '@vercel/node';

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const DEFAULT_MODEL_ID = 'scribe_v1';
// Accepts any audio container the browser hands us. ElevenLabs Scribe
// handles webm, mp4, ogg, wav, mp3 transparently — we just forward
// the bytes + content-type.
const ACCEPTED_AUDIO_PREFIXES = ['audio/'];
// Cap upload size — Scribe accepts much more, but a 30-min interview
// turn at decent quality is well under 25 MB. This guards against a
// runaway recorder eating Vercel function memory / quota.
const MAX_BYTES = 25 * 1024 * 1024;

async function readBody(req: VercelRequest): Promise<Buffer | null> {
  // Vercel function bodies are streamed; we collect manually because
  // we want raw bytes (req.body would JSON-parse a non-JSON request
  // and lose the binary payload).
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > MAX_BYTES) {
        // Stop accumulating; final size check happens once stream ends.
        return;
      }
      chunks.push(b);
    });
    req.on('end', () => {
      if (total > MAX_BYTES) resolve(null);
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', () => resolve(null));
  });
}

export const config = {
  // Disable Vercel's default body parser so we receive the raw audio
  // bytes; otherwise it tries to parse multipart / JSON and drops the
  // payload.
  api: { bodyParser: false },
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST.' });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'stt_not_configured', message: 'Set ELEVENLABS_API_KEY to enable Scribe transcription.' });
    return;
  }

  const contentType = (req.headers['content-type'] ?? '').toString();
  const isAudio = ACCEPTED_AUDIO_PREFIXES.some(p => contentType.startsWith(p));
  if (!isAudio) {
    res.status(415).json({ error: 'unsupported_media_type', message: `Expected audio/* body, got ${contentType || 'none'}.` });
    return;
  }

  const buf = await readBody(req);
  if (!buf) {
    res.status(413).json({ error: 'payload_too_large', message: `Audio exceeds ${MAX_BYTES} bytes.` });
    return;
  }
  if (buf.length < 1024) {
    res.status(400).json({ error: 'audio_too_short', message: 'Audio body is empty or shorter than 1KB.' });
    return;
  }

  const langHint = typeof req.query.lang === 'string' ? req.query.lang : '';

  // Scribe accepts multipart/form-data with a `file` field plus a
  // `model_id`. We rebuild the multipart manually so we don't pull in
  // a form-data lib for one endpoint.
  const boundary = `----agent-room-${Math.random().toString(36).slice(2)}`;
  const ext = guessExt(contentType);
  const fileName = `audio.${ext}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model_id"\r\n\r\n${DEFAULT_MODEL_ID}\r\n` +
    (langHint ? `--${boundary}\r\nContent-Disposition: form-data; name="language_code"\r\n\r\n${langHint}\r\n` : '') +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, buf, tail]);

  let upstream: Response;
  try {
    upstream = await fetch(SCRIBE_URL, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
  } catch (e) {
    res.status(502).json({ error: 'upstream_fetch_failed', message: e instanceof Error ? e.message : String(e) });
    return;
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    res.status(upstream.status).json({
      error: 'elevenlabs_error',
      message: detail.slice(0, 500) || `ElevenLabs HTTP ${upstream.status}`,
    });
    return;
  }

  let json: unknown;
  try {
    json = await upstream.json();
  } catch {
    res.status(502).json({ error: 'elevenlabs_bad_response', message: 'Upstream returned non-JSON.' });
    return;
  }

  // Scribe response shape: { text: string, language_code?: string,
  //   words?: [{ text, start, end, ... }], language_probability?: number }
  const text = typeof (json as { text?: unknown }).text === 'string'
    ? (json as { text: string }).text.trim()
    : '';

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    text,
    language: typeof (json as { language_code?: unknown }).language_code === 'string'
      ? (json as { language_code: string }).language_code
      : undefined,
  });
}

function guessExt(contentType: string): string {
  // Scribe sniffs by container, but we name the file consistently so
  // an upstream log search by extension still finds it. The extension
  // doesn't have to be exact — it's just for observability.
  if (contentType.includes('webm')) return 'webm';
  if (contentType.includes('ogg')) return 'ogg';
  if (contentType.includes('mp4')) return 'mp4';
  if (contentType.includes('mpeg')) return 'mp3';
  if (contentType.includes('wav')) return 'wav';
  return 'bin';
}
