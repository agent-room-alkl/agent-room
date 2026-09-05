import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskBoard } from '@agent-room/shared';
import { ROOM_POLL_MS, ROOM_POLL_HIDDEN_MS } from '@agent-room/shared';
import { createClient, getTaskBoard } from '@agent-room/upstash-client';
import { ENV } from '../env.js';

/**
 * Polls the room's task board. The board already exists server-side (created
 * by room_task via MCP); the web client was the only participant that never
 * read it, so a host on a phone could not see what their agents were working
 * on. Mirrors useRoom's visibility handling: slow down when hidden rather
 * than stopping, so a backgrounded tab still catches state changes.
 */
export function useTaskBoard(code: string) {
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const clientRef = useRef(createClient(ENV.upstash));
  const busyRef = useRef(false);

  // Bumped whenever the effect re-runs for a new room. An in-flight fetch
  // that resolves after the switch belongs to the old room, and two polls can
  // resolve out of order, so a stale result is dropped rather than written.
  const epochRef = useRef(0);

  const reload = useCallback(async () => {
    const epoch = epochRef.current;
    try {
      const next = await getTaskBoard(clientRef.current, code);
      if (epoch !== epochRef.current) return;
      setBoard(next);
    } catch {
      // Leave the last good board on screen; the next poll retries.
    } finally {
      if (epoch === epochRef.current) setLoaded(true);
    }
  }, [code]);

  useEffect(() => {
    epochRef.current += 1;
    setBoard(null);
    setLoaded(false);
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (slow: boolean) => {
      if (timer) return;
      void reload();
      timer = setInterval(() => void reload(), slow ? ROOM_POLL_HIDDEN_MS : ROOM_POLL_MS);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => { stop(); start(document.hidden); };

    document.addEventListener('visibilitychange', onVis);
    start(document.hidden);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
  }, [code, reload]);

  /**
   * Runs one board mutation, then refreshes. Serialized via `busy` so a
   * double-tap on a phone cannot fire two writes against the same CAS
   * version. Errors surface as a toast and leave the board untouched.
   */
  const run = useCallback(async (
    action: (client: ReturnType<typeof createClient>) => Promise<unknown>,
    failureLabel: string,
  ): Promise<boolean> => {
    // Guard on a ref, not the `busy` state. Two taps inside one tick (an
    // easy double-tap on a phone) both read the pre-render state value and
    // would both fire a write against the same CAS version; the ref is
    // already true by the time the second one checks.
    if (busyRef.current) {
      const { showToast } = await import('../components/Toast.js');
      showToast('Still saving the last change, try again in a moment');
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await action(clientRef.current);
      await reload();
      return true;
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(e instanceof Error ? `${failureLabel}: ${e.message}` : failureLabel);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [reload]);

  return { board, loaded, busy, reload, run };
}
