// Auto-retrospective for a room ("the retro writes itself").
//
// Everything is derived from data the room already produced — no new
// tracking. Sources, in order of trust:
//   - chat messages (type 'msg'): per-participant volume/share
//   - sys events in the transcript: turn timeouts / skips (eventType +
//     targetAgentName) and the task_update trail, which is the only durable
//     record of *how many times* a task bounced (the board itself keeps just
//     the latest evidence/verdict)
//   - the task board: timeline anchors (createdAt / evidence.at / verdict.at)
//     and the roleHistory reassignment audit
// Each section degrades independently: no board → no `tasks`; pre-metadata
// rooms simply show zero timeouts/skips.

import type {
  Message,
  Room,
  RoomRetro,
  RetroParticipantEntry,
  RetroTaskEntry,
  TaskBoard,
} from '@agent-room/shared';

// task_update sys texts are single-sourced from emitTaskSysMessage:
//   `<icon> <id> "<title>" — <verb> (now <state>).`
const TASK_STATE_RE = /(T-[A-Za-z0-9]+|[A-Za-z0-9-]+)\s+"/;

function taskEventState(text: string): string | null {
  const m = text.match(/\(now ([a-z_]+)\)\.?\s*$/);
  return m ? m[1]! : null;
}

function taskEventId(text: string): string | null {
  const m = text.match(TASK_STATE_RE);
  return m ? m[1]! : null;
}

export function buildRoomRetro(
  room: Pick<Room, 'createdAt' | 'participants'>,
  messages: Message[],
  board: TaskBoard | null | undefined,
): RoomRetro {
  const chat = messages.filter(m => m.type === 'msg');
  const sys = messages.filter(m => m.type === 'sys');

  // ── participants: volume + share, then fold in timeout/skip attribution ─
  const byName = new Map<string, RetroParticipantEntry>();
  const keyOf = (name: string, client: 'web' | 'cc') => `${client}:${name}`;
  for (const p of room.participants) {
    byName.set(keyOf(p.name, p.client), {
      name: p.name,
      client: p.client,
      messages: 0,
      chars: 0,
      sharePct: 0,
      timeouts: 0,
      skips: 0,
    });
  }
  let totalChars = 0;
  for (const m of chat) {
    const key = keyOf(m.name, m.client);
    if (!byName.has(key)) {
      byName.set(key, { name: m.name, client: m.client, messages: 0, chars: 0, sharePct: 0, timeouts: 0, skips: 0 });
    }
    const row = byName.get(key)!;
    row.messages += 1;
    row.chars += m.text.length;
    totalChars += m.text.length;
  }

  let timeouts = 0;
  let skips = 0;
  for (const m of sys) {
    const ev = m.metadata?.eventType;
    if (ev !== 'timed_out' && ev !== 'skipped_by_host' && ev !== 'skipped_by_grace') continue;
    const target = m.metadata?.targetAgentName;
    const targetClient = m.metadata?.targetAgentClient ?? 'cc';
    const row = target ? byName.get(keyOf(target, targetClient)) : undefined;
    if (ev === 'timed_out') {
      timeouts += 1;
      if (row) row.timeouts += 1;
    } else {
      skips += 1;
      if (row) row.skips += 1;
    }
  }

  const participants = [...byName.values()]
    .map(p => ({ ...p, sharePct: totalChars > 0 ? Math.round((p.chars / totalChars) * 100) : 0 }))
    .sort((a, b) => b.messages - a.messages);

  // ── tasks: board anchors + rejection/claim history from the sys trail ───
  let tasks: RetroTaskEntry[] | undefined;
  let rejections = 0;
  let tasksDone = 0;
  let tasksOpen = 0;
  if (board && board.tasks.length > 0) {
    const rejectionCount = new Map<string, number>();
    const claimedAt = new Map<string, number>();
    for (const m of sys) {
      if (m.metadata?.eventType !== 'task_update') continue;
      const id = taskEventId(m.text);
      const state = taskEventState(m.text);
      if (!id || !state) continue;
      if (state === 'rejected') {
        rejectionCount.set(id, (rejectionCount.get(id) ?? 0) + 1);
      }
      if (state === 'in_progress' && !claimedAt.has(id)) {
        claimedAt.set(id, m.time);
      }
    }
    tasks = board.tasks.map(t => {
      const decidedAt = t.verdict?.at;
      // Fallback: the board only keeps the latest verdict, so a task whose
      // current verdict is 'rejected' counts at least once even if the sys
      // trail was trimmed away.
      const rejected = Math.max(
        rejectionCount.get(t.id) ?? 0,
        t.verdict?.verdict === 'rejected' ? 1 : 0,
      );
      rejections += rejected;
      if (t.state === 'done') tasksDone += 1;
      else tasksOpen += 1;
      return {
        id: t.id,
        title: t.title,
        state: t.state,
        owner: t.owner,
        verifier: t.verifier,
        createdAt: t.createdAt,
        claimedAt: claimedAt.get(t.id),
        submittedAt: t.evidence?.at,
        decidedAt,
        cycleMs: decidedAt !== undefined ? Math.max(0, decidedAt - t.createdAt) : undefined,
        rejections: rejected,
        reassignments: t.roleHistory?.length ?? 0,
      };
    });
  }

  const lastActivity = messages.length > 0 ? Math.max(...messages.map(m => m.time)) : room.createdAt;

  return {
    generatedAt: Date.now(),
    durationMs: Math.max(0, lastActivity - room.createdAt),
    messageCount: chat.length,
    sysEventCount: sys.length,
    participants,
    ...(tasks ? { tasks } : {}),
    totals: { timeouts, skips, rejections, tasksDone, tasksOpen },
  };
}
