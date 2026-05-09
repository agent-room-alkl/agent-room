// Vercel Function: server-side ElevenLabs TTS proxy for Agent Room voice
// playback. The browser sends only text; the ElevenLabs API key stays in
// Vercel env vars and never ships to the client bundle.

import type { VercelRequest, VercelResponse } from '@vercel/node';

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel — American, warm, expressive
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const MAX_TEXT_CHARS = 1600;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST.' });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'tts_not_configured', message: 'Set ELEVENLABS_API_KEY to enable ElevenLabs playback.' });
    return;
  }

  const body = (req.body ?? {}) as { text?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'missing_text', message: 'Text is required.' });
    return;
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID ?? DEFAULT_MODEL_ID;
  const clippedText = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}...` : text;

  const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text: clippedText,
      model_id: modelId,
      voice_settings: {
        stability: 0.48,
        similarity_boost: 0.75,
        style: 0.18,
        use_speaker_boost: true,
      },
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    res.status(upstream.status).json({
      error: 'elevenlabs_error',
      message: detail.slice(0, 500) || `ElevenLabs HTTP ${upstream.status}`,
    });
    return;
  }

  const audio = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(audio);
}
