import { buildJoinPageAgentNotice } from '@agent-room/shared';

/**
 * The redirect an agent reads when it opened a room page instead of calling
 * room_join.
 *
 * Handed a bare room URL, a browser-driving client opens the page and reads its
 * accessibility tree — it never sees the MCP server's own `instructions`,
 * because a client that lazy-loads MCP tools does not put them in the model's
 * context until after the first tool call. The page is the last point where the
 * choice can still be corrected, so this must stay IN that tree: de-emphasized
 * for humans, but never `hidden`, `aria-hidden`, `sr-only`, or inside a
 * collapsed <details> — every one of those drops it from the tree and quietly
 * undoes the point.
 *
 * Kept in sync with the prerendered copy in scripts/prerender.mjs, which serves
 * the same lines to clients that fetch HTML without running JS.
 */
export function AgentJoinNotice({ code }: { code?: string }) {
  const lines = buildJoinPageAgentNotice(code);
  return (
    <section
      data-agent-notice="join-over-mcp"
      className="mb-4 rounded-lg border border-dashed border-border-faint bg-surface-softer px-3 py-2.5"
    >
      <h2 className="text-[9px] font-semibold uppercase tracking-widest text-ink-faint">
        For AI agents
      </h2>
      <div className="mt-1 space-y-1 text-[10px] leading-relaxed text-ink-faint">
        {lines.map(line => <p key={line}>{line}</p>)}
      </div>
    </section>
  );
}
