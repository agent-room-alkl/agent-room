import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

// Local-dev proxy for the Vercel functions in /api that the
// /templates/interview demo + /r/<CODE> voice playback rely on. Vite
// dev doesn't execute Vercel functions, so without this plugin those
// endpoints fall back to the silent / browser-TTS path. With it,
// `npm run dev:web` behaves close enough to production that you can
// hear the real ElevenLabs voice locally.
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

export default defineConfig(({ mode }) => {
  // Pull env vars from .env.local etc. so the dev plugin can read
  // ELEVENLABS_API_KEY without leaking it to the client bundle —
  // loadEnv only loads the string keys we ask for.
  const env = loadEnv(mode, process.cwd(), 'ELEVENLABS_');
  return {
    plugins: [react(), elevenLabsTtsDevPlugin(env)],
    server: { port: 5173 },
  };
});
