// Outbound delivery for room webhooks (see packages/upstash-client/src/webhooks.ts).
//
// Called from the /api/room 'send' path via waitUntil() — never on the
// response's critical path, and a failing endpoint can only ever slow its own
// delivery, not the chat.
//
// SSRF posture: these POSTs originate from our serverless functions, so a
// malicious registration could otherwise probe internal networks. We require
// https, and refuse localhost / private / link-local / metadata hostnames and
// IP literals at registration AND at delivery time. This is a hostname-level
// check — a DNS name that later resolves to a private address (DNS rebinding)
// is not caught, which is acceptable here because the request is a blind
// POST of chat data with no response echoed back to any caller.
// AGENT_ROOM_WEBHOOK_ALLOW_HTTP=1 relaxes the scheme check for self-hosters
// on private networks (and for tests).

import { createHmac } from 'node:crypto';
import type { Message, Room } from '@agent-room/shared';
import {
  listRoomWebhooks,
  saveRoomWebhooks,
  type RoomWebhook,
} from '@agent-room/upstash-client';
import type { UpstashClient } from '@agent-room/upstash-client';

const DELIVERY_TIMEOUT_MS = 5_000;
// Drop a hook after this many consecutive failures — dead endpoints stop
// costing us a 5s timeout on every message for the rest of the room's 24h.
const MAX_CONSECUTIVE_FAILURES = 20;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',
]);

function isPrivateIpLiteral(hostname: string): boolean {
  // IPv6 literal (URL hostnames keep brackets off after parsing)
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare === '::1' || bare === '::') return true;
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(bare) || /^fe[89ab][0-9a-f]:/i.test(bare)) return true;
  const m = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function validateWebhookUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Not a valid absolute URL.' };
  }
  const allowHttp = process.env.AGENT_ROOM_WEBHOOK_ALLOW_HTTP === '1';
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return { ok: false, reason: 'Webhook URLs must be https.' };
  }
  const host = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (isPrivateIpLiteral(host) && !allowHttp)
  ) {
    return { ok: false, reason: 'Webhook URLs must point at a public host.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Webhook URLs must not embed credentials.' };
  }
  return { ok: true, url };
}

export interface WebhookMessageEvent {
  event: 'message';
  code: string;
  topic: string;
  message: Pick<Message, 'id' | 'name' | 'client' | 'role' | 'text' | 'time'>;
  // Absolute message cursor after this message — pass as `since` to
  // room_list_messages / room_listen to read anything newer.
  cursor?: number;
}

async function deliverOne(hook: RoomWebhook, body: string, code: string): Promise<boolean> {
  const check = validateWebhookUrl(hook.url);
  if (!check.ok) return false;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'agent-room-webhook/1',
    'x-agentroom-event': 'message',
    'x-agentroom-room': code,
    'x-agentroom-webhook-id': hook.id,
  };
  if (hook.secret) {
    headers['x-agentroom-signature'] =
      'sha256=' + createHmac('sha256', hook.secret).update(body).digest('hex');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const resp = await fetch(check.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Fire the room's webhooks for one appended chat message. Hooks registered
// by the sender are skipped (the sender doesn't need waking for its own
// words). Failure bookkeeping is best-effort: hooks that keep failing are
// dropped so they stop costing timeouts.
export async function dispatchRoomWebhooks(
  client: UpstashClient,
  room: Room,
  message: Message,
  cursor: number | null,
): Promise<void> {
  let hooks: RoomWebhook[];
  try {
    hooks = await listRoomWebhooks(client, room.code);
  } catch {
    return;
  }
  const targets = hooks.filter(h => h.registeredBy !== message.name);
  if (targets.length === 0) return;

  const payload: WebhookMessageEvent = {
    event: 'message',
    code: room.code,
    topic: room.topic,
    message: {
      id: message.id,
      name: message.name,
      client: message.client,
      role: message.role,
      text: message.text,
      time: message.time,
    },
    ...(cursor !== null ? { cursor } : {}),
  };
  const body = JSON.stringify(payload);

  const results = await Promise.all(targets.map(h => deliverOne(h, body, room.code)));

  // Persist failure counters / drops only when something changed.
  let changed = false;
  const survivors: RoomWebhook[] = [];
  for (const hook of hooks) {
    const idx = targets.indexOf(hook);
    if (idx === -1) {
      survivors.push(hook);
      continue;
    }
    if (results[idx]) {
      if (hook.failCount) { hook.failCount = 0; changed = true; }
      survivors.push(hook);
    } else {
      hook.failCount = (hook.failCount ?? 0) + 1;
      changed = true;
      if (hook.failCount >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[room ${room.code}] dropping webhook ${hook.id} after ${hook.failCount} consecutive failures`);
      } else {
        survivors.push(hook);
      }
    }
  }
  if (changed) {
    try {
      await saveRoomWebhooks(client, room.code, survivors, room.createdAt);
    } catch { /* bookkeeping only */ }
  }
}
