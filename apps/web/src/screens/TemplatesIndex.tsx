// Plan B Phase 1 — /templates index page.
//
// Lists every Live Session Template as a buyer-facing card. Each card
// answers the three questions a buyer has in 10 seconds:
//   1. Is this for me? (persona line)
//   2. What do I get? (artifact + outcome shape)
//   3. What's it cost? (price headline)
//
// Click → /templates/<slug>/ for the deep demo. Status pill on each
// card is honest about which demos are live vs design-preview vs
// coming-soon — Robin's commercial bar requires we don't oversell.

import { Link } from 'react-router-dom';
import { TopNav } from '../components/TopNav.js';
import { LIVE_TEMPLATES, type LiveTemplate } from '../lib/liveTemplates.js';

function StatusPill({ status }: { status: LiveTemplate['status'] }) {
  const map: Record<LiveTemplate['status'], { label: string; cls: string }> = {
    'live-demo': { label: 'Live demo', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    'design-preview': { label: 'Design preview', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
    'coming-soon': { label: 'Coming soon', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  };
  const m = map[status];
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${m.cls}`}>
      {m.label}
    </span>
  );
}

export function TemplatesIndex() {
  return (
    <div className="min-h-screen bg-surface-soft">
      <TopNav />
      <header className="bg-slate-950 text-white px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-indigo-300 mb-3">
            实时会话 · Live Sessions
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
            One protocol, many shaped sessions.
          </h1>
          <p className="text-lg text-slate-300 max-w-2xl">
            Every template below is an Agent Room with the roles, prompt pack, and outcome
            artifact pre-wired for a specific job. Pick the one closest to yours, see what
            the deliverable looks like, and tell us if you'd pay for it.
          </p>
          <p className="text-xs text-slate-400 max-w-2xl mt-5 leading-relaxed">
            We're sharing these as <strong className="text-slate-200">design previews</strong>,
            not finished products. The pages show the buyer story, the artifact shape, and
            the price point — what we're validating before wiring real-time voice/video.
            Concrete pilot interest is welcome; reply through the page CTA.
          </p>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="grid md:grid-cols-2 gap-5">
          {LIVE_TEMPLATES.map(t => (
            <Link
              key={t.id}
              to={`/templates/${t.slug}`}
              className="group bg-white border border-border rounded-2xl p-6 hover:border-accent/50 hover:shadow-lg hover:shadow-slate-900/5 transition flex flex-col"
            >
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-3">
                  <span className="text-3xl leading-none">{t.emoji}</span>
                  <div>
                    <h2 className="text-xl font-bold tracking-tight group-hover:text-accent transition">{t.label}</h2>
                    <p className="text-xs text-ink-faint">{t.tagline}</p>
                  </div>
                </div>
                <StatusPill status={t.status} />
              </div>

              <p className="text-sm text-ink-soft leading-relaxed mb-5 flex-1">{t.pitch}</p>

              <div className="border-t border-border-faint pt-4 grid sm:grid-cols-2 gap-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-1">For</div>
                  <div className="text-xs text-ink leading-snug">{t.buyer.persona}</div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-1">Price</div>
                  <div className="text-xs text-ink leading-snug font-mono">{t.buyer.price}</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mt-3 mb-1">You receive</div>
                  <div className="text-xs text-ink leading-snug">{t.artifact.name} <span className="text-ink-faint">({t.artifact.deliverableShape})</span></div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between text-[11px] font-semibold text-accent">
                <span>View demo →</span>
                <span className="text-ink-faint font-normal">{t.roles.length} roles · 1 artifact</span>
              </div>
            </Link>
          ))}
        </div>

        <section className="mt-16 bg-white border border-border rounded-2xl p-7">
          <h3 className="text-lg font-semibold mb-2">Why this exists</h3>
          <p className="text-sm text-ink-soft leading-relaxed mb-3">
            Agent Room's protocol — rooms, roles, transcripts, and structured artifacts —
            is the same regardless of who's in the room. A hiring scorecard, a coaching
            feedback report, and an engineering standup recap are the same shape under the
            hood: a real-time multi-party session that produces a signed-off deliverable.
          </p>
          <p className="text-sm text-ink-soft leading-relaxed mb-3">
            The templates above are how we surface that protocol as buyable products. Each
            one is a thin UX layer over the same protocol — no new infrastructure, no
            vertical lock-in. If a category gets traction, we can split it into its own
            sub-brand without touching the core. If it doesn't, we sunset the template,
            not the platform.
          </p>
          <p className="text-sm text-ink-faint leading-relaxed">
            Want a template we don't list? <a href="mailto:hello@agent-room.com?subject=Live%20Session%20Template%20request" className="text-accent font-semibold">Email us</a> with the persona + the artifact they'd pay for. We're prioritizing by who has budget today, not who has the coolest use case.
          </p>
        </section>
      </main>
    </div>
  );
}
