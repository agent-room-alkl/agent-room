import { createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export interface UsageLimit {
  allowed: boolean;
  count: number;
  limit: number;
  resetSeconds: number;
  skipped?: 'not_configured' | 'redis_error';
}

interface UsageInput {
  req: VercelRequest;
  res: VercelResponse;
  service: 'interview-reply' | 'elevenlabs-tts';
  roomCode?: string;
  defaultLimit: number;
  envLimitName: string;
}

const DAY_SECONDS = 24 * 60 * 60;

function usageEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.VITE_UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.VITE_UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function clientIp(req: VercelRequest): string {
  const forwarded = headerValue(req.headers['x-forwarded-for']).split(',')[0]?.trim();
  return forwarded || headerValue(req.headers['x-real-ip']).trim() || 'unknown';
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function safeRoomCode(value: string | undefined): string {
  const normalized = (value ?? '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16);
  return normalized || 'no-room';
}

function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function redisPipeline(
  env: { url: string; token: string },
  commands: readonly (readonly (string | number)[])[],
): Promise<unknown[]> {
  const resp = await fetch(`${env.url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
    },
    body: JSON.stringify(commands),
    cache: 'no-store',
  });
  if (!resp.ok) throw new Error(`Upstash HTTP ${resp.status}`);
  const out = (await resp.json()) as Array<{ result: unknown }>;
  return out.map(x => x.result);
}

export async function checkUsageLimit(input: UsageInput): Promise<UsageLimit> {
  const limit = envLimit(input.envLimitName, input.defaultLimit);
  const env = usageEnv();
  if (!env) {
    input.res.setHeader('X-Agent-Room-Usage-Limit-Skipped', 'not_configured');
    return { allowed: true, count: 0, limit, resetSeconds: DAY_SECONDS, skipped: 'not_configured' };
  }

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ipHash = stableHash(clientIp(input.req));
  const room = safeRoomCode(input.roomCode);
  const key = `agent-room:usage:${input.service}:${day}:room:${room}:ip:${ipHash}`;

  try {
    const [countRaw] = await redisPipeline(env, [
      ['INCR', key],
      ['EXPIRE', key, DAY_SECONDS],
    ]);
    const count = typeof countRaw === 'number' ? countRaw : Number(countRaw);
    const safeCount = Number.isFinite(count) ? count : limit + 1;
    const remaining = Math.max(0, limit - safeCount);
    input.res.setHeader('X-RateLimit-Limit', String(limit));
    input.res.setHeader('X-RateLimit-Remaining', String(remaining));
    input.res.setHeader('X-RateLimit-Reset', String(DAY_SECONDS));
    return { allowed: safeCount <= limit, count: safeCount, limit, resetSeconds: DAY_SECONDS };
  } catch {
    input.res.setHeader('X-Agent-Room-Usage-Limit-Skipped', 'redis_error');
    return { allowed: true, count: 0, limit, resetSeconds: DAY_SECONDS, skipped: 'redis_error' };
  }
}

