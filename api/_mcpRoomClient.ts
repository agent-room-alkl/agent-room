// The seam between the MCP tool surface and room storage.
//
// The hosted deployment puts an HTTP server in this position: its MCP tools
// POST to `/api/room`, and that server owns auth, billing and the ledger on
// top of the room write. This repo has no such server — the web app talks to
// Upstash directly from the browser (`apps/web/src/screens/CreateMeeting.tsx`,
// `Join.tsx`, `hooks/useRoom.ts` all import `@agent-room/upstash-client`) —
// so an HTTP indirection here would be a layer with nothing in it.
//
// So this file implements the SAME eleven functions against
// `@agent-room/upstash-client` directly. `_mcpTools.ts` is written against
// this module's signatures, never against HTTP, which is what lets the tool
// surface be shared between the two deployments unchanged.
//
// ERROR TRANSLATION IS PART OF THE CONTRACT. `_mcpTools.ts` catches
// `RemoteRoomApiError` and turns known `code` values into the guidance an
// agent acts on — "you are muted, wait via room_listen" rather than a stack
// trace. upstash-client throws its own classes, so every call below is wrapped
// and re-thrown with the matching code. Miss one and the agent gets a raw
// error where it expected an instruction, which is exactly the kind of result
// that makes a model stop calling tools.

import { generateCode } from '@agent-room/shared';
import type { Message, Participant, Room, RoomReport } from '@agent-room/shared';
import {
  createClient,
  createRoom as storeCreateRoom,
  createRoomReport as storeCreateRoomReport,
  endRoom as storeEndRoom,
  getRoom as storeGetRoom,
  joinRoom as storeJoinRoom,
  listMessages as storeListMessages,
  appendMessage as storeAppendMessage,
  reactivateRoom as storeReactivateRoom,
  removeParticipant as storeRemoveParticipant,
  setListenUntil as storeSetListenUntil,
  updatePresence,
  verifyHostKey,
  HostNameTakenError,
  MutedError,
  NotHostError,
  NotYourTurnError,
  RoomNotFoundError,
  getTaskBoard,
  createTask,
  claimTask,
  submitTask,
  verifyTask,
  reassignTaskRoles,
  cancelTask,
  registerRoomWebhook,
  listRoomWebhooks,
  unregisterRoomWebhook,
  WebhookLimitError,
  NotParticipantError,
  setReplyMode,
  getTurnState,
  setTurnState,
  addHostDirected,
  skipQueueHead,
} from '@agent-room/upstash-client';
import type { UpstashClient } from '@agent-room/upstash-client';
import { dispatchRoomWebhooks, validateWebhookUrl } from './_webhookDispatch.js';

/** Same shape the hosted deployment's client throws, so the tool layer's
 *  error handling is identical on both. */
export class RemoteRoomApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'RemoteRoomApiError';
  }
}

export interface RemoteRoomClient {
  readonly store: UpstashClient;
  /**
   * The rest of the room API, as an action envelope.
   *
   * The eleven named functions below cover the room lifecycle, but the task
   * board, webhook and moderator-admin tools in `_mcpTools.ts` reach past them
   * and post an `{ action }` payload directly. That is the hosted deployment's
   * HTTP body; here it is dispatched onto upstash-client instead. Every action
   * the tool layer sends must be handled — an unknown one throws rather than
   * returning a plausible empty result, because a task board that silently
   * does nothing is worse than one that fails loudly.
   */
  post<T>(payload: Record<string, unknown>): Promise<T>;
}

export function createRemoteRoomClient(_requestHost: string | undefined): RemoteRoomClient {
  // Env names match the web app's, so a self-hoster configures one pair of
  // credentials and both surfaces work.
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.VITE_UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.VITE_UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new RemoteRoomApiError(
      'Room storage is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN on the deployment.',
      500,
      'not_configured',
    );
  }
  const store = createClient({ url, token });
  return { store, post: (payload) => dispatchAction(store, payload) as never };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const agent = (name: unknown) => ({ name: str(name), client: 'cc' as const });

/** The `{ action }` envelope, mapped onto upstash-client. */
async function dispatchAction(store: UpstashClient, p: Record<string, unknown>): Promise<unknown> {
  const code = str(p.code);
  try {
    switch (p.action) {
      // ── task board ──────────────────────────────────────────────────────
      case 'taskBoard':
        return { board: (await getTaskBoard(store, code)) ?? { code, tasks: [], version: 0 } };
      case 'taskCreate':
        return await createTask(store, code, {
          title: str(p.title),
          createdBy: str(p.requesterName),
          ...(p.id ? { id: str(p.id) } : {}),
          ...(p.owner ? { owner: str(p.owner), ownerClient: 'cc' as const } : {}),
          ...(p.verifier ? { verifier: str(p.verifier), verifierClient: 'cc' as const } : {}),
          ...(p.dod ? { dod: str(p.dod) } : {}),
        });
      case 'taskClaim':
        return await claimTask(store, code, str(p.id), agent(p.name));
      case 'taskSubmit':
        return await submitTask(
          store, code, str(p.id), agent(p.name),
          p.evidence as Parameters<typeof submitTask>[4],
        );
      case 'taskVerify':
        return await verifyTask(
          store, code, str(p.id), agent(p.name),
          p.verdict === 'done' ? 'done' : 'rejected',
          typeof p.note === 'string' ? p.note : undefined,
        );
      case 'taskReassign':
        return await reassignTaskRoles(store, code, str(p.id), {
          ...(p.owner ? { owner: str(p.owner), ownerClient: 'cc' as const } : {}),
          ...(p.verifier ? { verifier: str(p.verifier), verifierClient: 'cc' as const } : {}),
        }, agent(p.requesterName));
      case 'taskCancel':
        return await cancelTask(
          store, code, str(p.id), agent(p.requesterName),
          typeof p.reason === 'string' ? p.reason : undefined,
        );

      // ── resident webhooks ───────────────────────────────────────────────
      case 'webhookSet': {
        // upstash-client's registerRoomWebhook accepts any string. That is
        // harmless while nothing in this repo calls it, but the moment a
        // webhook is registrable over an open HTTP endpoint, an unvalidated
        // URL is an SSRF: an agent holding a room code could point the room at
        // `http://169.254.169.254/...` and have the server POST chat content
        // to it. The check has to happen before the write, not at delivery.
        const check = validateWebhookUrl(str(p.url));
        if (!check.ok) {
          throw new RemoteRoomApiError(`Refusing that webhook URL: ${check.reason}`, 400, 'bad_request');
        }
        const webhook = await registerRoomWebhook(store, code, {
          url: str(p.url),
          registeredBy: str(p.requesterName),
          ...(typeof p.secret === 'string' && p.secret ? { secret: p.secret } : {}),
        });
        return { webhook };
      }
      case 'webhookList':
        return { webhooks: await listRoomWebhooks(store, code) };
      case 'webhookDelete':
        // Deliberate parity gap, documented rather than papered over: the
        // hosted server checks the requester before unregistering, this
        // repo's unregisterRoomWebhook takes no requester at all. Registering
        // already requires being a participant, so the exposure is "one
        // participant can drop another's webhook in a room they are both in",
        // not "anyone with the code can". Left as-is instead of inventing a
        // check the web app does not apply either.
        return { removed: await unregisterRoomWebhook(store, code, str(p.id)) };

      // ── host / moderator controls ───────────────────────────────────────
      case 'setReplyMode': {
        await assertHostFor(store, code, str(p.requesterName), p.hostKey as string | undefined);
        const room = await setReplyMode(
          store, code, str(p.requesterName),
          p.mode as Parameters<typeof setReplyMode>[3],
          p.config as Parameters<typeof setReplyMode>[4],
        );
        return { room };
      }
      case 'directInvoke': {
        await assertHostFor(store, code, str(p.requesterName), p.hostKey as string | undefined);
        const target = p.target as { name?: string } | undefined;
        const source = p.source === 'moderator' ? 'moderator' : 'host';
        const state = await getTurnState(store, code);
        const next = addHostDirected(state ?? { queue: [], startedAt: Date.now() } as never, str(target?.name), 'cc', source);
        await setTurnState(store, code, next);
        return { added: true };
      }
      case 'skipCurrent': {
        await assertHostFor(store, code, str(p.requesterName), p.hostKey as string | undefined);
        const state = await getTurnState(store, code);
        if (!state) return { skipped: null };
        const next = skipQueueHead(state);
        await setTurnState(store, code, next);
        return { skipped: next.currentName ?? null };
      }

      default:
        throw new RemoteRoomApiError(
          `Unsupported room action "${String(p.action)}" on this deployment.`,
          400,
          'unsupported_action',
        );
    }
  } catch (e) {
    if (e instanceof WebhookLimitError) throw new RemoteRoomApiError(e.message, 409, 'WebhookLimitError');
    if (e instanceof NotParticipantError) throw new RemoteRoomApiError(e.message, 403, 'NotParticipantError');
    return translate(e);
  }
}

/** Shared by the admin actions; see assertHost below for why this exists. */
async function assertHostFor(
  store: UpstashClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<void> {
  const room = await storeGetRoom(store, code);
  if (hostKey && await verifyHostKey(store, code, hostKey)) return;
  if (requesterName === room.createdBy) return;
  throw new RemoteRoomApiError(
    `Only the host (${room.createdBy}) can do this. Pass the hostKey you got from room_create.`,
    403,
    'NotHostError',
  );
}

/**
 * Map a storage-layer throw onto the code the tool layer knows how to explain.
 * Anything unrecognised is rethrown untouched — inventing a code for an error
 * we do not understand would hand the agent confident, wrong guidance.
 */
function translate(e: unknown): never {
  if (e instanceof RemoteRoomApiError) throw e;
  if (e instanceof MutedError) throw new RemoteRoomApiError(e.message, 403, 'MutedError');
  if (e instanceof NotYourTurnError) throw new RemoteRoomApiError(e.message, 409, 'NotYourTurnError');
  if (e instanceof NotHostError) throw new RemoteRoomApiError(e.message, 403, 'NotHostError');
  if (e instanceof HostNameTakenError) throw new RemoteRoomApiError(e.message, 409, 'HostNameTakenError');
  if (e instanceof RoomNotFoundError) throw new RemoteRoomApiError(e.message, 404, 'RoomNotFoundError');
  throw e;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return translate(e);
  }
}

export async function createRoom(
  client: RemoteRoomClient,
  input: { topic: string; createdBy: string },
): Promise<Room & { hostKey: string }> {
  // Codes are generated here rather than by the caller, matching the hosted
  // server. A collision is a 1-in-many-millions event, but retrying twice is
  // cheaper than explaining to a user why their room code was already taken.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    try {
      return await storeCreateRoom(client.store, { code, topic: input.topic, createdBy: input.createdBy });
    } catch (e) {
      lastError = e;
    }
  }
  return translate(lastError);
}

export async function getRoom(client: RemoteRoomClient, code: string): Promise<Room> {
  return guarded(() => storeGetRoom(client.store, code));
}

/**
 * Refresh what the room knows about who is present.
 *
 * The hosted server has a dedicated `sweep` action that also expires stale
 * seats. Here the same read is a `getRoom`, which already normalises the
 * stored record; presence expiry is the caller's business via
 * `isParticipantStale`, not a stored mutation.
 */
export async function sweepRoom(client: RemoteRoomClient, code: string): Promise<Room> {
  return guarded(() => storeGetRoom(client.store, code));
}

export async function joinRoom(
  client: RemoteRoomClient,
  code: string,
  participant: Participant,
  options: { hostKey?: string; seatKey?: string } = {},
): Promise<Room & { participant: Participant; seatKey?: string }> {
  return guarded(async () => {
    const result = await storeJoinRoom(client.store, code, participant, {
      ...(options.hostKey ? { hostKey: options.hostKey } : {}),
      ...(options.seatKey ? { seatKey: options.seatKey } : {}),
      priorIdentity: { name: participant.name, client: 'cc' as const },
    });
    return result as Room & { participant: Participant; seatKey?: string };
  });
}

export async function listMessages(client: RemoteRoomClient, code: string, since: number): Promise<Message[]> {
  return guarded(() => storeListMessages(client.store, code, since));
}

export async function appendMessage(
  client: RemoteRoomClient,
  code: string,
  message: Message,
  kind: 'message' | 'status' = 'message',
): Promise<unknown> {
  const result = await guarded(() => storeAppendMessage(client.store, code, message, kind));
  // Fan out to resident webhooks. The hosted server does this from its send
  // path; storage does not do it for us, so without this a registered webhook
  // would be a row in Redis that never fires — a tool that appears to work and
  // silently does nothing, which is worse than one that refuses.
  //
  // Best-effort and never fatal: a subscriber's broken endpoint must not turn
  // a delivered message into a failed room_send.
  try {
    const room = await storeGetRoom(client.store, code);
    const cursor = (result as { cursor?: number } | null)?.cursor ?? null;
    await dispatchRoomWebhooks(client.store, room, message, cursor);
  } catch { /* delivery is not the sender's problem */ }
  return result;
}

export async function setListenUntil(
  client: RemoteRoomClient,
  code: string,
  name: string,
  until: number,
): Promise<void> {
  await guarded(async () => {
    await storeSetListenUntil(client.store, code, name, until);
    await updatePresence(client.store, code, name, Date.now());
  });
}

export async function removeParticipant(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  targetName: string,
): Promise<Room> {
  // MCP agents are always 'cc' seats; the web seats leave through the UI.
  return guarded(() => storeRemoveParticipant(client.store, code, requesterName, targetName, 'cc'));
}

/**
 * Ending and reviving are host-only, and the check lives HERE.
 *
 * upstash-client's endRoom/reactivateRoom take no requester at all — in this
 * repo the browser is trusted, because the person clicking already holds the
 * host key in their own session. An MCP caller is not that: the room code
 * alone reaches this endpoint, so without a check any agent that knows a code
 * could end someone else's meeting. The hosted server does this check in
 * `api/room.ts`; with no server here it has to be done at this seam.
 */
async function assertHost(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<void> {
  const room = await storeGetRoom(client.store, code);
  if (hostKey && await verifyHostKey(client.store, code, hostKey)) return;
  if (requesterName === room.createdBy) return;
  throw new RemoteRoomApiError(
    `Only the host (${room.createdBy}) can do this. Pass the hostKey you got from room_create.`,
    403,
    'NotHostError',
  );
}

export async function endRoom(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<Room> {
  return guarded(async () => {
    await assertHost(client, code, requesterName, hostKey);
    return storeEndRoom(client.store, code);
  });
}

export async function reactivateRoom(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<Room> {
  return guarded(async () => {
    await assertHost(client, code, requesterName, hostKey);
    return storeReactivateRoom(client.store, code);
  });
}

export async function createRoomReport(client: RemoteRoomClient, code: string): Promise<RoomReport> {
  return guarded(async () => {
    const room = await storeGetRoom(client.store, code);
    const messages = await storeListMessages(client.store, code, 0);
    return storeCreateRoomReport(client.store, room, messages);
  });
}
