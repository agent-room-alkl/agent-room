import { useState } from 'react';
import type { TaskBoard } from '@agent-room/shared';
import { deliverPlanProgress, deliverPlanTasks, latestDeliverPlan } from '@agent-room/shared';

// Deliver mode: the plan the room is working on, above the chat. Before the
// host's go it asks for one; after, it is a progress strip that opens the
// task board.

const CHIP = 'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold';

export function DeliverPlanBar({ board, canStart, onStart, onOpenBoard }: {
  board: TaskBoard | null;
  /** The viewer is the host. */
  canStart: boolean;
  onStart: () => Promise<void>;
  onOpenBoard: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const plan = latestDeliverPlan(board);
  if (!board || !plan) return null;
  const tasks = deliverPlanTasks(board, plan.id);
  const p = deliverPlanProgress(tasks);
  const chips = [
    { label: 'In progress', count: p.inProgress + p.notStarted, cls: 'border-indigo-200 bg-indigo-50 text-indigo-700' },
    { label: 'Awaiting review', count: p.awaitingReview, cls: 'border-amber-200 bg-amber-50 text-amber-800' },
    { label: 'Done', count: p.done, cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
    { label: 'Escalated', count: p.escalated, cls: 'border-red-200 bg-red-50 text-red-700' },
  ];

  return (
    <div className="shrink-0 border-b border-border-faint bg-surface px-3 py-2 sm:px-5" data-testid="deliver-plan-bar">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px]">
        <span className="font-mono font-semibold text-ink">{plan.id}</span>
        <span className="text-ink-soft">
          {tasks.length} task{tasks.length === 1 ? '' : 's'} · lead @{plan.lead}
        </span>
        {plan.reportedAt ? (
          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">Delivered</span>
        ) : !plan.startedAt ? (
          <>
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
              {canStart ? 'Review the plan, then start it' : 'Waiting for the host to start'}
            </span>
            {canStart && (
              <span className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onOpenBoard}
                  className="h-7 rounded-md border border-border bg-white px-2.5 text-[11px] font-semibold text-ink-soft hover:bg-surface-soft"
                >
                  Review
                </button>
                <button
                  type="button"
                  disabled={busy || tasks.length === 0}
                  onClick={async () => {
                    setBusy(true);
                    try { await onStart(); } finally { setBusy(false); }
                  }}
                  className="h-7 rounded-md bg-accent px-3 text-[11px] font-semibold text-white hover:brightness-110 disabled:opacity-60"
                >
                  {busy ? 'Starting…' : 'Start'}
                </button>
              </span>
            )}
          </>
        ) : null}
      </div>
      {plan.startedAt && tasks.length > 0 && (
        <button type="button" onClick={onOpenBoard} className="mt-1.5 flex flex-wrap items-center gap-1.5" aria-label="Plan progress — open the task board">
          {chips.map(c => (
            <span key={c.label} className={`${CHIP} ${c.count > 0 ? c.cls : 'border-border-faint bg-surface text-ink-faint'}`}>
              {c.count} {c.label}
            </span>
          ))}
        </button>
      )}
    </div>
  );
}
