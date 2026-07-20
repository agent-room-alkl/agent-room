import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createClient, createRoom, verifyHostClaim, HostNameTakenError } from '../src/index.js';

const ENV = { url: 'https://example.upstash.io', token: 't' };
const CODE = 'TST-CDE-FGH';

// Stateful in-memory Upstash fake so createRoom's SET round-trips to the GET
// inside verifyHostClaim.
function installFakeRedis(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map<string, string>(Object.entries(seed));
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    const args = JSON.parse(init.body) as string[];
    const [op, key, val] = args;
    let result: unknown = null;
    if (op === 'GET') result = store.has(key) ? store.get(key) : null;
    else if (op === 'SET') { store.set(key, val as string); result = 'OK'; }
    else if (op === 'DEL') { result = store.delete(key) ? 1 : 0; }
    return new Response(JSON.stringify({ result }), { headers: { 'Content-Type': 'application/json' } });
  }));
  return store;
}

describe('verifyHostClaim', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('accepts the authenticated room owner with NO hostKey (the lost-key recovery)', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createRoom(client, { code: CODE, topic: 'Q3', createdBy: 'robin', ownerId: 'user_owner' });

    await expect(verifyHostClaim(client, CODE, { authedUserId: 'user_owner' })).resolves.toBeUndefined();
  });

  it('still accepts a valid hostKey (unchanged path)', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { hostKey } = await createRoom(client, { code: CODE, topic: 'Q3', createdBy: 'robin', ownerId: 'user_owner' });

    await expect(verifyHostClaim(client, CODE, { hostKey })).resolves.toBeUndefined();
  });

  it('rejects a wrong hostKey with no auth', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createRoom(client, { code: CODE, topic: 'Q3', createdBy: 'robin', ownerId: 'user_owner' });

    await expect(verifyHostClaim(client, CODE, { hostKey: 'not-the-key' })).rejects.toBeInstanceOf(HostNameTakenError);
  });

  it('rejects an anonymous caller (no key, no owner identity) — impersonation stays blocked', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createRoom(client, { code: CODE, topic: 'Q3', createdBy: 'robin', ownerId: 'user_owner' });

    await expect(verifyHostClaim(client, CODE, {})).rejects.toBeInstanceOf(HostNameTakenError);
  });

  it('rejects a DIFFERENT signed-in user with no hostKey', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createRoom(client, { code: CODE, topic: 'Q3', createdBy: 'robin', ownerId: 'user_owner' });

    await expect(verifyHostClaim(client, CODE, { authedUserId: 'user_someone_else' })).rejects.toBeInstanceOf(HostNameTakenError);
  });

  it('does not grant host via owner-id when the room has no ownerId (anonymous room)', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    // Anonymous room: created with no ownerId, so only the hostKey can claim host.
    const { hostKey } = await createRoom(client, { code: CODE, topic: 'Q3', createdBy: 'robin' });

    await expect(verifyHostClaim(client, CODE, { authedUserId: 'anyone' })).rejects.toBeInstanceOf(HostNameTakenError);
    await expect(verifyHostClaim(client, CODE, { hostKey })).resolves.toBeUndefined();
  });

  it('allows legacy rooms with no hostKeyHash (back-compat)', async () => {
    const legacyRoom = {
      code: CODE, topic: 'Q3', createdAt: 0, createdBy: 'robin', ownerId: 'user_owner',
      status: 'active', version: 1, participants: [], replyMode: 'open',
    };
    installFakeRedis({ [`room:${CODE}`]: JSON.stringify(legacyRoom) });
    const client = createClient(ENV);

    await expect(verifyHostClaim(client, CODE, {})).resolves.toBeUndefined();
  });
});
