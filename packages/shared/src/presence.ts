import { LISTEN_LEASE_MS, LISTEN_LEASE_RENEW_MS } from './constants.js';

/**
 * Keeps a participant's `listenUntil` lease alive for as long as the caller is
 * actually sitting inside room_listen.
 *
 * The bug this exists to kill: `listenUntil` used to be stamped ONCE, at the
 * start of a listen, with the caller's full intended window (up to 270s on the
 * local MCP). Nothing ever wrote it again — not on early return, not on error,
 * not on process death — so a client that returned after 2s, or died outright,
 * kept reading "Listening" in the room for the rest of that window. Presence
 * was recording intent, not liveness.
 *
 * A lease fixes that without adding any new transport: stamp a SHORT window and
 * keep renewing it. Renewal only happens while the poll loop is genuinely
 * running, so every way a listen can end — return, throw, kill -9 — stops the
 * renewals and the lease lapses on its own within LISTEN_LEASE_MS.
 *
 * `stop()` additionally releases the lease immediately on the paths we can
 * observe (normal return / error), which is the common case and makes the room
 * accurate within one round-trip rather than one lease.
 *
 * @param stamp writes `listenUntil` for this participant; failures are ignored
 *   because presence must never break the listen it is describing.
 * @returns a stop function; call it in a `finally`.
 */
export function startListenLease(
  stamp: (until: number) => Promise<void>,
  opts?: { leaseMs?: number; renewMs?: number },
): () => Promise<void> {
  const leaseMs = opts?.leaseMs ?? LISTEN_LEASE_MS;
  const renewMs = opts?.renewMs ?? LISTEN_LEASE_RENEW_MS;
  let stopped = false;

  const renew = async () => {
    if (stopped) return;
    try {
      await stamp(Date.now() + leaseMs);
    } catch { /* presence is non-essential — never break the listen */ }
  };

  // First stamp is fire-and-forget for the same reason the original call was:
  // the listen should start polling immediately, not wait on a presence write.
  void renew();
  const timer = setInterval(() => { void renew(); }, renewMs);
  // Don't hold the process open just to advertise presence.
  (timer as unknown as { unref?: () => void }).unref?.();

  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    // Release the lease now. lastSeenAt is bumped by the same write, so a live
    // agent that is merely between listens reads as "Working", not "Gone".
    try {
      await stamp(Date.now());
    } catch { /* presence is non-essential */ }
  };
}
