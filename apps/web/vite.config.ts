import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

// Local-dev proxy for the Vercel functions in /api that the
// /templates/interview demo + /r/<CODE> voice playback / mic input
// rely on. Vite dev doesn't execute Vercel functions, so without this
// plugin those endpoints fall back to the silent / browser-TTS /
// browser-SpeechRecognition path. With it, `npm run dev:web` behaves
// close enough to production that you can hear the real ElevenLabs
// voice and use Scribe-quality STT locally.
//
// Reads `ELEVENLABS_API_KEY` (and optional `ELEVENLABS_VOICE_ID` /
// `ELEVENLABS_MODEL_ID`) from `apps/web/.env.local` — same names the
// real Vercel function uses, so production env vars work unchanged.
function elevenLabsTtsDevPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'agent-room:elevenlabs-tts-dev',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/elevenlabs-tts', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'method_not_allowed' }));
          return;
        }
        const apiKey = env.ELEVENLABS_API_KEY;
        if (!apiKey) {
          res.statusCode = 503;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'tts_not_configured', message: 'Set ELEVENLABS_API_KEY in apps/web/.env.local to enable local TTS.' }));
          return;
        }
        // Read JSON body.
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        let payload: { text?: unknown };
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'bad_json' }));
          return;
        }
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'missing_text' }));
          return;
        }
        const voiceId = env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
        const modelId = env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
        const clipped = text.length > 1600 ? `${text.slice(0, 1599)}...` : text;
        const upstream = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
            body: JSON.stringify({
              text: clipped,
              model_id: modelId,
              voice_settings: {
                stability: 0.48,
                similarity_boost: 0.75,
                style: 0.18,
                use_speaker_boost: true,
              },
            }),
          },
        );
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => '');
          res.statusCode = upstream.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'elevenlabs_error', message: detail.slice(0, 500) || `ElevenLabs HTTP ${upstream.status}` }));
          return;
        }
        const audio = Buffer.from(await upstream.arrayBuffer());
        res.statusCode = 200;
        res.setHeader('content-type', 'audio/mpeg');
        res.setHeader('cache-control', 'no-store');
        res.end(audio);
      });
    },
  };
}

// Local-dev proxy for /api/stt (ElevenLabs Scribe). Browser POSTs
// raw audio (MediaRecorder output) with audio/* content-type; we
// forward to Scribe with the same multipart shape api/stt.ts uses
// in production. Returns { text, language } JSON.
function elevenLabsSttDevPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'agent-room:elevenlabs-stt-dev',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/stt', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'method_not_allowed' }));
          return;
        }
        const apiKey = env.ELEVENLABS_API_KEY;
        if (!apiKey) {
          res.statusCode = 503;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'stt_not_configured', message: 'Set ELEVENLABS_API_KEY in apps/web/.env.local to enable local Scribe.' }));
          return;
        }
        const contentType = (req.headers['content-type'] ?? '').toString();
        if (!contentType.startsWith('audio/')) {
          res.statusCode = 415;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'unsupported_media_type', message: `Expected audio/* body, got ${contentType || 'none'}.` }));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        const MAX = 25 * 1024 * 1024;
        for await (const c of req) {
          const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += b.length;
          if (total > MAX) {
            res.statusCode = 413;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'payload_too_large' }));
            return;
          }
          chunks.push(b);
        }
        const buf = Buffer.concat(chunks);
        if (buf.length < 1024) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'audio_too_short' }));
          return;
        }

        const url = new URL(req.url ?? '', 'http://localhost');
        const langHint = url.searchParams.get('lang') ?? '';

        const boundary = `----agent-room-${Math.random().toString(36).slice(2)}`;
        const ext = contentType.includes('webm') ? 'webm'
          : contentType.includes('ogg') ? 'ogg'
          : contentType.includes('mp4') ? 'mp4'
          : contentType.includes('mpeg') ? 'mp3'
          : contentType.includes('wav') ? 'wav' : 'bin';
        const head = Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n` +
          (langHint ? `--${boundary}\r\nContent-Disposition: form-data; name="language_code"\r\n\r\n${langHint}\r\n` : '') +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
          'utf8',
        );
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

        const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
          body: Buffer.concat([head, buf, tail]) as unknown as BodyInit,
        });
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => '');
          res.statusCode = upstream.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'elevenlabs_error', message: detail.slice(0, 500) }));
          return;
        }
        let json: unknown;
        try { json = await upstream.json(); } catch {
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'elevenlabs_bad_response' }));
          return;
        }
        const text = typeof (json as { text?: unknown }).text === 'string'
          ? (json as { text: string }).text.trim() : '';
        const lang = typeof (json as { language_code?: unknown }).language_code === 'string'
          ? (json as { language_code: string }).language_code : undefined;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ text, language: lang }));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Pull env vars from .env.local etc. so the dev plugins can read
  // ELEVENLABS_API_KEY without leaking it to the client bundle —
  // loadEnv only loads the string keys we ask for.
  const env = loadEnv(mode, process.cwd(), 'ELEVENLABS_');
  return {
    plugins: [react(), elevenLabsTtsDevPlugin(env), elevenLabsSttDevPlugin(env)],
    server: { port: 5173 },
  };
});
