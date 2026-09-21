import { useState } from 'react';
import type { Message } from '@agent-room/shared';

// Deliver mode system events. Plan and report messages are cards the host can
// read at a glance; an escalation is addressed to the host.

const STYLE: Record<string, { cls: string; title: string }> = {
  deliver_escalated: { cls: 'border-red-200 bg-red-50 text-red-900', title: 'Needs you' },
  deliver_report: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-900', title: 'Delivery report' },
  deliver_plan: { cls: 'border-indigo-200 bg-indigo-50 text-indigo-900', title: 'Plan' },
  deliver_verifier_reassigned: { cls: 'border-amber-200 bg-amber-50 text-amber-900', title: 'Review reassigned' },
};

export function isDeliverEvent(message: Message): boolean {
  const type = message.metadata?.eventType;
  return !!type && type in STYLE;
}

const BTN = 'h-6 rounded border border-current/20 bg-white/70 px-2 text-[10px] font-semibold hover:bg-white disabled:opacity-50';

export function DeliverEventCard({ message, onViewTaskBoard, onStart, startPlanId }: {
  message: Message;
  onViewTaskBoard?: () => void;
  /** Host only: start the waiting plan — same as the Start button on the plan bar. */
  onStart?: () => Promise<void>;
  startPlanId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const type = message.metadata?.eventType ?? '';
  const style = STYLE[type] ?? STYLE.deliver_plan!;
  const taskId = message.metadata?.taskId;
  const planId = message.metadata?.planId;
  const canStart = type === 'deliver_plan' && !!onStart && !!startPlanId && (!planId || planId === startPlanId);

  return (
    <div className={`mx-auto w-full max-w-[min(560px,94%)] rounded-md border px-3 py-2 text-left ${style.cls}`}>
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide opacity-80">
        <span>{style.title}</span>
        {taskId && <span className="font-mono normal-case">{taskId}</span>}
        <span className="ml-auto font-normal normal-case">
          {new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-snug">{message.text}</div>
      {(onViewTaskBoard || canStart) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {canStart && (
            <button
              type="button"
              className="h-6 rounded border border-accent bg-accent px-2 text-[10px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try { await onStart!(); } finally { setBusy(false); }
              }}
            >
              {busy ? 'Starting…' : 'Start'}
            </button>
          )}
          {onViewTaskBoard && (
            <button type="button" className={BTN} onClick={onViewTaskBoard}>View task board</button>
          )}
        </div>
      )}
    </div>
  );
}
