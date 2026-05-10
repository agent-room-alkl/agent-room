import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { artifactLabel, extractArtifacts, normalizeEscapedWhitespace, type ArtifactKind, type Message, type RoomArtifact, type RoomReport } from '@agent-room/shared';
import { createClient, createRoomReport, getRoom, getRoomReport, listMessages } from '@agent-room/upstash-client';
import { ENV } from '../env.js';

// localStorage key for a per-room unlocked state. Once a customer hits
// /r/CODE/report?unlock=TOKEN and the server validates, we drop the
// token here so future visits to /r/CODE/report (no query param) still
// render watermark-free. Cleared if the token ever stops verifying
// (e.g. UNLOCK_SECRET rotated).
function unlockKey(code: string): string {
  return `room:${code}:unlocked`;
}

function readStoredUnlock(code: string): string | null {
  try { return localStorage.getItem(unlockKey(code)); } catch { return null; }
}

export function Report() {
  const { code = '' } = useParams();
  const [searchParams] = useSearchParams();
  const [report, setReport] = useState<RoomReport | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Unlock state has three values: null (not yet checked), 'unlocked'
  // (verified), 'locked' (no token / invalid). Renders the watermark
  // unless 'unlocked'.
  const [unlockStatus, setUnlockStatus] = useState<'pending' | 'unlocked' | 'locked'>('pending');

  useEffect(() => {
    // 1. If localStorage already has a token from a previous visit,
    //    re-verify it server-side (in case secret rotated). Until the
    //    re-verify completes, optimistically render unlocked so the
    //    page doesn't flash watermark on every visit.
    // 2. If URL has ?unlock=TOKEN, verify and persist on success.
    // 3. Otherwise, lock.
    const urlToken = searchParams.get('unlock');
    const stored = readStoredUnlock(code);
    const token = urlToken ?? stored ?? '';

    if (!token || !code) {
      setUnlockStatus('locked');
      return;
    }

    // Optimistic: if we have a stored token already, render unlocked
    // immediately while we re-verify in the background.
    if (stored) setUnlockStatus('unlocked');

    fetch(`/api/unlock-verify?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`)
      .then(r => r.json().then(body => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (ok && body.valid) {
          try { localStorage.setItem(unlockKey(code), token); } catch { /* private mode */ }
          setUnlockStatus('unlocked');
        } else {
          // Token invalid — wipe stored to force re-paying or re-asking.
          try { localStorage.removeItem(unlockKey(code)); } catch { /* private mode */ }
          setUnlockStatus('locked');
        }
      })
      .catch(() => {
        // Network failure: don't punish the user — fall back to whatever
        // the optimistic decision was.
        if (!stored) setUnlockStatus('locked');
      });
  }, [code, searchParams]);

  useEffect(() => {
    const client = createClient(ENV.upstash);
    getRoomReport(client, code)
      .then(found => {
        setReport(found);
        setMissing(!found);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [code]);

  async function refreshReport() {
    setRefreshing(true);
    setError(null);
    try {
      const client = createClient(ENV.upstash);
      const room = await getRoom(client, code);
      const messages = await listMessages(client, code, 0);
      const next = await createRoomReport(client, room, messages);
      setReport(next);
      setMissing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  if (error) return <div className="p-10 text-red-600">{error}</div>;
  if (missing) {
    return (
      <div className="min-h-full bg-surface-soft px-6 py-12">
        <div className="max-w-3xl mx-auto bg-white border border-border rounded-xl p-8">
          <h1 className="text-2xl font-bold mb-3">Report not found</h1>
          <p className="text-sm text-ink-soft mb-5">This room has not been exported yet.</p>
          <Link to={`/r/${code}`} className="text-sm font-semibold text-accent">Back to room</Link>
        </div>
      </div>
    );
  }
  if (!report) return <div className="p-10 text-ink-soft">Loading…</div>;
  const artifacts = report.artifacts ?? extractArtifacts(report.transcript);

  return (
    <div className="min-h-full bg-surface-soft">
      <header className="bg-slate-950 text-white px-6 py-10">
        <div className="max-w-5xl mx-auto">
          <div className="text-xs font-semibold text-emerald-300 mb-3">Agent Room Report · {report.code}</div>
          <h1 className="text-4xl font-bold tracking-tight mb-4">{report.topic}</h1>
          <p className="text-slate-300 max-w-3xl">{report.summary}</p>
          <div className="mt-6 flex flex-wrap gap-3 text-xs text-slate-300">
            <span>{report.messageCount} messages</span>
            <span>{report.participants.length} participants</span>
            <span>Exported {new Date(report.exportedAt).toLocaleString()}</span>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={refreshReport}
              disabled={refreshing}
              className="rounded-lg bg-white text-slate-950 px-4 py-2 text-xs font-semibold disabled:opacity-60"
            >
              {refreshing ? 'Refreshing…' : 'Refresh from latest'}
            </button>
            <button
              onClick={() => downloadMarkdown(report, artifacts, unlockStatus === 'unlocked')}
              className="rounded-lg border border-white/25 bg-white/5 px-4 py-2 text-xs font-semibold text-white hover:bg-white/10"
            >
              Download Markdown
            </button>
            <Link to={`/r/${report.code}`} className="rounded-lg border border-white/25 px-4 py-2 text-xs font-semibold text-white">
              Open room
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <section className="grid md:grid-cols-3 gap-4">
          {report.participants.map(p => (
            <div key={`${p.name}-${p.client}`} className="bg-white border border-border rounded-lg p-4">
              <div className="text-sm font-semibold">{p.name}</div>
              <div className="text-xs text-ink-soft">{[p.role, p.client].filter(Boolean).join(' · ')}</div>
            </div>
          ))}
        </section>

        <ReportSection title="Highlights" items={report.highlights} />

        {/* A5: replaces the old "Decisions / Action Items / Structured
            Artifacts" trio with a single 决议链 + 证据 + action items 三栏视图.
            Tagged artifacts (`[DECISION]` / `[TODO]` / `[STATUS]` / `[RESULT]`)
            render as cards with their backing evidence (the source message
            excerpt) and a one-click jump back into the transcript. Rooms
            that didn't tag anything still get a clean board that surfaces
            the regex-matched decisions / action items as plain bullets. */}
        <DecisionBoard
          artifacts={artifacts}
          fallbackDecisions={report.decisions}
          fallbackActionItems={report.actionItems}
          transcript={report.transcript}
        />

        <section className="bg-white border border-border rounded-xl p-5">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-lg font-semibold">Transcript</h2>
            <Link to={`/r/${report.code}`} className="text-xs font-semibold text-accent">Open room</Link>
          </div>
          <div className="space-y-3">
            {report.transcript.map(m => (
              // Stable anchor IDs so the Decision Board's "Jump to transcript →"
              // links land on the exact message that produced each artifact.
              <article id={`msg-${m.id}`} key={m.id} className="border-l-2 border-border pl-3 scroll-mt-24">
                <div className="text-[11px] text-ink-soft mb-1">
                  <span className="font-semibold text-ink">{m.name}</span>
                  {m.role && <span> · {m.role}</span>}
                  <span> · {new Date(m.time).toLocaleString()}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{normalizeEscapedWhitespace(m.text)}</p>
              </article>
            ))}
          </div>
        </section>

        <CreateYourOwnCTA report={report} />

        {unlockStatus === 'unlocked'
          ? <UnlockedFooter report={report} />
          : <FreeTierFooter report={report} />}
      </main>
    </div>
  );
}

// A4: viral-loop hook on the report page. The most natural conversion
// surface in the entire product is the moment a reader finishes a shared
// report and thinks "I want my own AI agents to do this for me." Every
// shared link is an implicit demo of the format; this CTA turns that
// passive demo into a one-click new-room flow with the source room's
// topic pre-seeded so the reader doesn't have to guess what to type.
//
// The card sits between the body sections and the export footer so it's
// the last positive thing the reader sees. Deep-link query params
// (`topic`, `from`) are consumed by CreateMeeting.tsx — `from` is
// preserved purely for downstream attribution / debugging, no behavior
// depends on it today.
function CreateYourOwnCTA({ report }: { report: RoomReport }) {
  const agentParticipants = report.participants.filter(
    p => p.client && p.client !== 'web'
  );
  const agentNames = agentParticipants.length
    ? agentParticipants.map(p => p.name).slice(0, 3).join(' · ')
    : null;
  const newUrl = `/new?topic=${encodeURIComponent(report.topic)}&from=${encodeURIComponent(report.code)}`;

  return (
    <section className="bg-gradient-to-br from-accent/5 via-white to-white border border-accent-tint-border rounded-xl p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-widest font-semibold text-accent-deep mb-1">
            Want to run your own session like this?
          </div>
          <p className="text-sm text-ink leading-relaxed">
            Open a room about <strong>{report.topic}</strong>
            {agentNames ? <> — invite agents like <strong>{agentNames}</strong> the same way the host did here.</> : ' and bring your own agents.'}
          </p>
        </div>
        <Link
          to={newUrl}
          className="inline-flex items-center justify-center bg-accent text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:opacity-90 transition shrink-0"
        >
          Create your own room →
        </Link>
      </div>
    </section>
  );
}

// Free-tier watermark + upgrade nudge. Placed at the very bottom of the
// report so it shows up when a client scrolls through the delivery,
// matching the "Made with Notion" / "Made with Linear" pattern.
function FreeTierFooter({ report }: { report: RoomReport }) {
  // The room has a 24h TTL on the server (Redis EX), but exported reports
  // currently share that TTL. Until we ship persisted reports, surface
  // the practical ceiling so the user knows when this URL stops working.
  const expiresAt = report.exportedAt + 24 * 60 * 60 * 1000;
  const hoursLeft = Math.max(0, Math.round((expiresAt - Date.now()) / (60 * 60 * 1000)));

  return (
    <section className="bg-white border border-border rounded-xl p-6 text-center">
      <div className="text-[11px] uppercase tracking-widest font-semibold text-ink-faint mb-2">Exported report · expires in {hoursLeft}h</div>
      <p className="text-base font-semibold text-ink mb-1">
        Made with <a href="https://www.agent-room.com" target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">Agent Room</a>
      </p>
      <p className="text-sm text-ink-soft max-w-md mx-auto mb-5 leading-relaxed">
        Self-host the open-source room protocol, or create a fresh room and keep working from the same flow.
      </p>
      <div className="flex flex-col sm:flex-row gap-2 justify-center">
        <Link
          to="/new"
          className="inline-flex items-center justify-center bg-accent text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:opacity-90 transition"
        >
          Create another room
        </Link>
        <a
          href="https://github.com/ebin198351-akl/agent-room/blob/main/docs/AGENT_ROOM_PROTOCOL.md"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center bg-white border border-border px-5 py-2.5 rounded-lg text-sm font-semibold text-ink-muted hover:bg-surface-soft transition"
        >
          Protocol docs
        </a>
      </div>
    </section>
  );
}

// Replacement footer rendered when the unlock token verifies. Quiet
// confirmation so the page doesn't feel "stamped" — the absence of the
// watermark is the real signal.
function UnlockedFooter({ report }: { report: RoomReport }) {
  return (
    <section className="bg-emerald-50 border border-emerald-200 rounded-xl p-5 text-center">
      <div className="text-[11px] uppercase tracking-widest font-semibold text-emerald-700 mb-1">✓ Unlocked report</div>
      <p className="text-sm text-emerald-900">
        This report has been unlocked. Share <code className="font-mono bg-white border border-emerald-200 rounded px-2 py-0.5 text-[12px]">https://www.agent-room.com/r/{report.code}/report</code> with your client — no watermark, no expiry.
      </p>
    </section>
  );
}

// A5: the consolidated "outcome board" that replaces the prior
// Decisions / Action Items / Structured Artifacts trio. The shape is:
//
//   ┌────────────────────────────────────────────────────────────┐
//   │  Decisions       │  Action Items     │  Status & Results   │
//   │  (cards w/       │  (cards w/        │  (cards w/          │
//   │   evidence +     │   evidence +      │   evidence +        │
//   │   jump link)     │   jump link)      │   jump link)        │
//   └────────────────────────────────────────────────────────────┘
//
// "Evidence" is a clipped excerpt of the source message — it lets the
// reader see the artifact in its conversational context without
// scrolling away. The jump link lands on the actual transcript article
// (via `#msg-<id>` anchors added on the transcript section), so the
// reader can read the surrounding turn-by-turn if they want more.
//
// When a room has no tagged artifacts of a given kind, the column falls
// back to the regex-matched decisions / actionItems strings so older /
// untagged rooms still get something useful. Status & Results without
// artifacts is just hidden — there's no fallback list for those kinds.
function DecisionBoard({
  artifacts,
  fallbackDecisions,
  fallbackActionItems,
  transcript,
}: {
  artifacts: RoomArtifact[];
  fallbackDecisions: string[];
  fallbackActionItems: string[];
  transcript: Message[];
}) {
  const messageById = new Map(transcript.map(m => [m.id, m]));

  const decisions = artifacts.filter(a => a.kind === 'decision');
  const todos = artifacts.filter(a => a.kind === 'todo');
  const statusResults = artifacts.filter(a => a.kind === 'status' || a.kind === 'result');

  const cols: BoardColumn[] = [
    {
      kind: 'decision',
      title: 'Decisions',
      cards: decisions,
      fallbackText: decisions.length ? [] : fallbackDecisions,
      fallbackHint: 'Tag with [DECISION] in a message to surface a decision here.',
    },
    {
      kind: 'todo',
      title: 'Action Items',
      cards: todos,
      fallbackText: todos.length ? [] : fallbackActionItems,
      fallbackHint: 'Tag with [TODO] in a message to surface an action item here.',
    },
    {
      kind: 'status',
      title: 'Status & Results',
      cards: statusResults,
      fallbackText: [],
      fallbackHint: 'Tag with [STATUS] or [RESULT] to surface progress / outcomes here.',
    },
  ];

  const visible = cols.filter(c => c.cards.length || c.fallbackText.length);

  return (
    <section className="bg-white border border-border rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-4 mb-4">
        <h2 className="text-lg font-semibold">Outcome Board</h2>
        <span className="text-[11px] text-ink-faint">
          Decisions, action items, and status — backed by evidence from the transcript.
        </span>
      </div>
      {visible.length === 0 ? (
        <p className="text-sm text-ink-soft">
          No decisions, action items, status, or results were captured for this room. Tag messages with{' '}
          <code className="text-[11px] bg-surface-softer px-1 py-0.5 rounded">[DECISION]</code>,{' '}
          <code className="text-[11px] bg-surface-softer px-1 py-0.5 rounded">[TODO]</code>,{' '}
          <code className="text-[11px] bg-surface-softer px-1 py-0.5 rounded">[STATUS]</code>, or{' '}
          <code className="text-[11px] bg-surface-softer px-1 py-0.5 rounded">[RESULT]</code> to populate this board.
        </p>
      ) : (
        <div className="grid md:grid-cols-3 gap-4">
          {cols.map(col => {
            const isEmpty = col.cards.length === 0 && col.fallbackText.length === 0;
            return (
              <div key={col.kind} className="flex flex-col">
                <h3 className={`text-xs font-semibold uppercase tracking-wider mb-2 ${artifactTone(col.kind)}`}>
                  {col.title}
                  <span className="ml-2 text-ink-faint normal-case font-medium">
                    {col.cards.length || col.fallbackText.length || 0}
                  </span>
                </h3>
                {isEmpty ? (
                  <p className="text-[11px] text-ink-faint leading-relaxed">{col.fallbackHint}</p>
                ) : col.cards.length > 0 ? (
                  <ul className="space-y-2">
                    {col.cards.map(card => (
                      <ArtifactCard
                        key={card.id}
                        artifact={card}
                        sourceMessage={messageById.get(card.sourceMessageId) ?? null}
                      />
                    ))}
                  </ul>
                ) : (
                  // Untagged room: render the regex-matched fallback strings
                  // as plain bullets. We don't have message-level provenance
                  // for these so no evidence / jump link.
                  <ul className="space-y-2">
                    {col.fallbackText.map((line, i) => (
                      <li
                        key={i}
                        className="text-sm leading-relaxed border border-border-faint bg-surface-softer rounded-lg px-3 py-2"
                      >
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

interface BoardColumn {
  kind: ArtifactKind;
  title: string;
  cards: RoomArtifact[];
  /** Plain-string fallback (regex-matched decisions / actionItems) used
   *  when there are no tagged cards of this kind. */
  fallbackText: string[];
  /** Empty-state copy shown when both `cards` and `fallbackText` are empty. */
  fallbackHint: string;
}

function ArtifactCard({
  artifact,
  sourceMessage,
}: {
  artifact: RoomArtifact;
  sourceMessage: Message | null;
}) {
  const evidence = sourceMessage ? buildEvidence(sourceMessage.text, artifact.text) : null;
  const anchor = `#msg-${artifact.sourceMessageId}`;

  return (
    <li className="border border-border-faint bg-surface-softer rounded-lg p-3 flex flex-col gap-2">
      <div className="text-sm leading-relaxed text-ink">{artifact.text}</div>
      <div className="text-[11px] text-ink-soft">
        <span className="font-semibold">{artifact.author}</span>
        <span> · {new Date(artifact.time).toLocaleString()}</span>
      </div>
      {evidence && (
        <blockquote className="text-[12px] leading-relaxed text-ink-soft border-l-2 border-border pl-2 italic">
          “{evidence}”
        </blockquote>
      )}
      {sourceMessage && (
        <a
          href={anchor}
          className="text-[11px] font-semibold text-accent hover:underline self-start"
        >
          Jump to transcript →
        </a>
      )}
    </li>
  );
}

// Pull a short excerpt around the artifact text inside the source
// message so the card has visible "evidence." We anchor on the
// artifact text itself when possible (so the snippet contains it),
// then fall back to the message head. Caps at ~180 chars to keep cards
// scannable; the full message is one click away via the jump link.
function buildEvidence(messageText: string, artifactText: string): string | null {
  const normalized = messageText.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const idx = normalized.indexOf(artifactText);
  const max = 180;
  if (idx >= 0) {
    const start = Math.max(0, idx - 40);
    const end = Math.min(normalized.length, idx + artifactText.length + 80);
    const chunk = normalized.slice(start, end);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < normalized.length ? '…' : '';
    return clipWithEllipsis(`${prefix}${chunk}${suffix}`, max + 2);
  }
  return clipWithEllipsis(normalized, max);
}

function clipWithEllipsis(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function ReportSection({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="bg-white border border-border rounded-xl p-5">
      <h2 className="text-lg font-semibold mb-3">{title}</h2>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={index} className="text-sm leading-relaxed border border-border-faint bg-surface-softer rounded-lg px-3 py-2">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

function artifactTone(kind: ArtifactKind): string {
  switch (kind) {
    case 'decision':
      return 'text-emerald-700';
    case 'todo':
      return 'text-amber-700';
    case 'status':
      return 'text-blue-700';
    case 'result':
      return 'text-violet-700';
  }
}

// Plain-Markdown export of the report. Front-matter holds metadata so this
// file slots cleanly into delivery emails / git repos. Order matches the
// on-screen sections so the printed and downloaded artifact tell the same
// story.
function buildMarkdown(report: RoomReport, artifacts: RoomArtifact[], unlocked: boolean = false): string {
  const lines: string[] = [];
  const fmt = (t: number) => new Date(t).toLocaleString();

  lines.push('---');
  lines.push(`title: ${escapeYaml(report.topic)}`);
  lines.push(`room: ${report.code}`);
  lines.push(`exported: ${new Date(report.exportedAt).toISOString()}`);
  lines.push(`messages: ${report.messageCount}`);
  lines.push(`participants: ${report.participants.length}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${report.topic}`);
  lines.push('');
  lines.push(`> Agent Room Report · \`${report.code}\` · exported ${fmt(report.exportedAt)}`);
  lines.push('');
  lines.push(report.summary || '_(no summary)_');
  lines.push('');

  lines.push('## Participants');
  lines.push('');
  for (const p of report.participants) {
    const meta = [p.role, p.client].filter(Boolean).join(' · ');
    lines.push(`- **${p.name}**${meta ? ` — ${meta}` : ''}`);
  }
  lines.push('');

  if (report.highlights.length) {
    lines.push('## Highlights');
    lines.push('');
    for (const h of report.highlights) lines.push(`- ${h}`);
    lines.push('');
  }

  if (report.decisions.length) {
    lines.push('## Decisions');
    lines.push('');
    for (const d of report.decisions) lines.push(`- ${d}`);
    lines.push('');
  }

  if (report.actionItems.length) {
    lines.push('## Action Items');
    lines.push('');
    for (const a of report.actionItems) lines.push(`- [ ] ${a}`);
    lines.push('');
  }

  if (artifacts.length) {
    lines.push('## Structured Artifacts');
    lines.push('');
    const kinds: ArtifactKind[] = ['decision', 'todo', 'status', 'result'];
    for (const k of kinds) {
      const group = artifacts.filter(a => a.kind === k);
      if (!group.length) continue;
      lines.push(`### ${artifactLabel(k)}`);
      lines.push('');
      for (const a of group) {
        lines.push(`- ${a.text} _(${a.author} · ${fmt(a.time)})_`);
      }
      lines.push('');
    }
  }

  lines.push('## Transcript');
  lines.push('');
  for (const m of report.transcript) {
    const who = `${m.name}${m.role ? ` · ${m.role}` : ''}`;
    lines.push(`**${who}** — _${fmt(m.time)}_`);
    lines.push('');
    // Indent message body so existing markdown inside the message keeps its
    // structure but is visually nested under the speaker line.
    for (const line of m.text.split('\n')) lines.push(`> ${line}`);
    lines.push('');
  }

  // Markdown export is always clean — no watermark, no upgrade nudge.
  // Provenance lives in the YAML front matter (`room: CODE`, etc.) and
  // the title-bar quote near the top, which is enough to find the
  // original report URL without putting promo copy on the user's data.
  // The watermark deliberately ONLY lives on the HTML report page,
  // which is what the customer's customer actually sees. Mirrors the
  // free-vs-paid line for hosted delivery URLs.
  // (The `unlocked` parameter is preserved for future use if we ever
  // add paid-only fields like custom branding.)
  void unlocked;

  return lines.join('\n');
}

function escapeYaml(value: string): string {
  if (/[:#&*!|>%@`'"\n]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

function downloadMarkdown(report: RoomReport, artifacts: RoomArtifact[], unlocked: boolean = false) {
  const md = buildMarkdown(report, artifacts, unlocked);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeTopic = report.topic.replace(/[^\w一-鿿-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';
  a.href = url;
  a.download = `${safeTopic}-${report.code}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
