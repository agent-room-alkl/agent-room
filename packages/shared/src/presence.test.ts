import { describe, it, expect, vi, afterEach } from 'vitest';
import { startListenLease } from './presence.js';

describe('startListenLease', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('stamps a short lease immediately, not the caller full listen window', async () => {
    const stamped: number[] = [];
    const before = Date.now();
    const stop = startListenLease(async (until) => { stamped.push(until); }, {
      leaseMs: 15_000,
      renewMs: 5_000,
    });
    await vi.waitFor(() => expect(stamped).toHaveLength(1));

    // The old bug: a 270s listen stamped listenUntil 270s into the future once.
    // A lease is bounded by leaseMs regardless of how long the caller intends
    // to poll, so a client that dies mid-listen stops reading as live fast.
    expect(stamped[0]! - before).toBeLessThanOrEqual(15_000 + 1_000);
    expect(stamped[0]!).toBeGreaterThan(before);
    await stop();
  });

  it('keeps renewing the lease while the listen is still running', async () => {
    vi.useFakeTimers();
    const stamped: number[] = [];
    const stop = startListenLease(async (until) => { stamped.push(until); }, {
      leaseMs: 15_000,
      renewMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(16_000);

    // 3 renewals inside one nominal lease length: presence never lapses for an
    // agent that is genuinely sitting in the poll.
    expect(stamped.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < stamped.length; i++) {
      expect(stamped[i]!).toBeGreaterThan(stamped[i - 1]!);
    }
    await stop();
  });

  it('releases the lease on stop so an early return stops reading as Listening', async () => {
    const stamped: number[] = [];
    const stop = startListenLease(async (until) => { stamped.push(until); });
    await vi.waitFor(() => expect(stamped.length).toBeGreaterThanOrEqual(1));

    await stop();
    const released = stamped[stamped.length - 1];
    // Released lease is in the past (or now) — the UI reads "not listening"
    // within one round-trip instead of for the rest of the intended window.
    expect(released).toBeLessThanOrEqual(Date.now());
  });

  it('stops renewing after stop, even if the caller keeps running', async () => {
    vi.useFakeTimers();
    const stamped: number[] = [];
    const stop = startListenLease(async (until) => { stamped.push(until); }, {
      leaseMs: 15_000,
      renewMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await stop();
    const afterStop = stamped.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stamped).toHaveLength(afterStop);
  });

  it('never throws when the presence write fails', async () => {
    const stop = startListenLease(async () => { throw new Error('upstash down'); });
    await expect(stop()).resolves.toBeUndefined();
  });
});
