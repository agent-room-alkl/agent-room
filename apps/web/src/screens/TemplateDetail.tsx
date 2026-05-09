// Plan B Phase 1 — /templates/<slug> detail page.
//
// One component handles every Live Session Template (renders straight
// from `liveTemplates.ts`). Page is a 5-section deep demo:
//
//   1. Hero — emoji + label + tagline + status pill
//   2. Buyer card — persona / price / trigger event (the "is this me?" pitch)
//   3. Live mock — three-column board: roles · transcript · outcome
//      The transcript is intentionally specific (not lorem ipsum) so an
//      ICP-shaped reader can judge realism in 30 seconds.
//   4. Pricing tiers — illustrative not committed; what they'd react to
//   5. Pilot CTA — single-action conversion point (mailto for now)

import { Link, useParams } from 'react-router-dom';
import { TopNav } from '../components/TopNav.js';
import { templateBySlug, type LiveTemplate } from '../lib/liveTemplates.js';

function StatusPill({ status }: { status: LiveTemplate['status'] }) {
  const map = {
    'live-demo': { label: 'Live demo', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
    'design-preview': { label: 'Design preview', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
    'coming-soon': { label: 'Coming soon', cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
  } as const;
  const m = map[status];
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-widest px-2.5 py-1 rounded-full border ${m.cls}`}>
      {m.label}
    </span>
  );
}

export function TemplateDetail() {
  const { slug = '' } = useParams();
  const t = templateBySlug(slug);

  if (!t) {
    return (
      <div className="min-h-screen bg-surface-soft">
        <TopNav />
        <div className="max-w-3xl mx-auto px-6 py-20">
          <h1 className="text-2xl font-bold mb-3">Template not found</h1>
          <p className="text-sm text-ink-soft mb-5">
            We don't ship a "{slug}" template (yet). Browse the catalog or pitch us a new one.
          </p>
          <div className="flex gap-3">
            <Link to="/templates" className="text-sm font-semibold text-accent">← Back to templates</Link>
            <a href="mailto:hello@agent-room.com?subject=Template%20request" className="text-sm font-semibold text-ink-muted">Pitch a template →</a>
          </div>
        </div>
      </div>
    );
  }

  const pilotMailto = `mailto:hello@agent-room.com?subject=${encodeURIComponent(`Pilot: ${t.label}`)}&body=${encodeURIComponent(`Hi — I'd like to pilot ${t.label} for our team.\n\nWho I am:\nWhat I'd use it for:\nVolume I'd run (sessions / month):\nWhat would convince me to pay:\n`)}`;

  return (
    <div className="min-h-screen bg-surface-soft">
      <TopNav />

      {/* 1. Hero */}
      <header className="bg-slate-950 text-white px-6 py-14">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3 mb-4">
            <Link to="/templates" className="text-xs text-slate-400 hover:text-slate-200 transition">← Templates</Link>
            <span className="text-slate-600">·</span>
            <StatusPill status={t.status} />
          </div>
          <div className="flex items-start gap-4 mb-4">
            <span className="text-5xl leading-none">{t.emoji}</span>
            <div>
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">{t.label}</h1>
              <p className="text-lg text-slate-300 mt-2">{t.tagline}</p>
            </div>
          </div>
          <p className="text-base text-slate-200 max-w-3xl mt-5 leading-relaxed">{t.pitch}</p>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12 space-y-10">

        {/* 2. Buyer card */}
        <section className="bg-white border border-border rounded-2xl p-7">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint mb-3">Who buys this</div>
          <p className="text-base text-ink leading-relaxed mb-5">{t.buyer.persona}</p>

          <div className="grid md:grid-cols-2 gap-5 border-t border-border-faint pt-5">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1">Trigger event</div>
              <p className="text-sm text-ink-soft italic leading-relaxed">"{t.buyer.trigger}"</p>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1">Headline price</div>
              <p className="text-sm text-ink leading-relaxed font-mono">{t.buyer.price}</p>
              <p className="text-[11px] text-ink-faint mt-1">Illustrative — see tiers below.</p>
            </div>
          </div>
        </section>

        {/* 3. Live mock — three-column board */}
        <section>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-xl font-bold tracking-tight">What the room looks like</h2>
            <span className="text-[11px] text-ink-faint">Mock content — real-time voice/video coming next phase</span>
          </div>
          <div className="grid lg:grid-cols-[260px_1fr_320px] gap-4">
            {/* Roles column */}
            <aside className="bg-white border border-border rounded-2xl p-5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-3">Roles</h3>
              <ul className="space-y-3">
                {t.roles.map(role => (
                  <li key={role.name} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full ${role.ai ? 'bg-indigo-500' : 'bg-emerald-500'}`}
                        aria-hidden
                      />
                      <span className="text-sm font-semibold text-ink">{role.name}</span>
                      {role.ai && <span className="text-[9px] font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 rounded px-1.5 py-0.5">AI</span>}
                    </div>
                    <p className="text-[11px] text-ink-soft leading-snug pl-4">{role.brief}</p>
                  </li>
                ))}
              </ul>

              <div className="mt-6 pt-5 border-t border-border-faint">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-2">Voice indicator</h3>
                <div className="flex items-center gap-2 bg-slate-50 border border-border-faint rounded-lg px-3 py-2.5">
                  <div className="flex items-end gap-0.5 h-5">
                    <span className="w-0.5 bg-indigo-500 rounded-full animate-pulse" style={{ height: '40%', animationDelay: '0ms', animationDuration: '900ms' }} />
                    <span className="w-0.5 bg-indigo-500 rounded-full animate-pulse" style={{ height: '70%', animationDelay: '120ms', animationDuration: '900ms' }} />
                    <span className="w-0.5 bg-indigo-500 rounded-full animate-pulse" style={{ height: '95%', animationDelay: '240ms', animationDuration: '900ms' }} />
                    <span className="w-0.5 bg-indigo-500 rounded-full animate-pulse" style={{ height: '60%', animationDelay: '360ms', animationDuration: '900ms' }} />
                    <span className="w-0.5 bg-indigo-500 rounded-full animate-pulse" style={{ height: '85%', animationDelay: '480ms', animationDuration: '900ms' }} />
                    <span className="w-0.5 bg-indigo-500 rounded-full animate-pulse" style={{ height: '50%', animationDelay: '600ms', animationDuration: '900ms' }} />
                  </div>
                  <span className="text-[11px] text-ink-soft">{t.roles[0]?.name ?? 'AI'} is speaking</span>
                </div>
              </div>
            </aside>

            {/* Transcript column */}
            <div className="bg-white border border-border rounded-2xl p-5 min-h-[420px]">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-3">Transcript · live</h3>
              <ol className="space-y-4">
                {t.mockTranscript.map((line, i) => (
                  <li key={i} className="flex gap-3">
                    <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold ${line.ai ? 'bg-indigo-100 text-indigo-700' : 'bg-emerald-100 text-emerald-700'}`}>
                      {line.speaker.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold text-ink">{line.speaker}</span>
                        {line.ai && <span className="text-[9px] font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 rounded px-1.5 py-0.5">AI</span>}
                      </div>
                      <p className="text-[13px] leading-relaxed text-ink-soft">{line.text}</p>
                    </div>
                  </li>
                ))}
                <li className="text-[11px] text-ink-faint italic pt-2">…session continues for ~20 minutes…</li>
              </ol>
            </div>

            {/* Outcome column */}
            <aside className="bg-gradient-to-br from-accent-tint via-white to-amber-50 border border-accent-tint-border rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-accent-deep">{t.artifact.name}</h3>
                <span className="text-[10px] text-ink-faint">{t.artifact.deliverableShape}</span>
              </div>
              <ul className="space-y-3">
                {t.outcome.map((item, i) => (
                  <li key={i} className="border-b border-border-faint last:border-0 pb-3 last:pb-0">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-0.5">{item.label}</div>
                    <div className="text-sm text-ink leading-snug">{item.value}</div>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] leading-relaxed text-ink-soft mt-5 pt-4 border-t border-border-faint">
                {t.artifact.monetizationLine}
              </p>
            </aside>
          </div>
        </section>

        {/* 4. Pricing */}
        <section className="bg-white border border-border rounded-2xl p-7">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-xl font-bold tracking-tight">Illustrative pricing</h2>
            <span className="text-[11px] text-ink-faint">Not committed — looking for ICP signal</span>
          </div>
          <div className="grid md:grid-cols-3 gap-3">
            {t.pricing.map(p => (
              <div key={p.tier} className="border border-border rounded-xl p-5 flex flex-col">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{p.tier}</div>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="text-2xl font-bold tracking-tight">{p.price}</span>
                  <span className="text-xs text-ink-faint">/ {p.per}</span>
                </div>
                <ul className="mt-3 space-y-1.5">
                  {p.includes.map((inc, i) => (
                    <li key={i} className="text-xs text-ink-soft leading-relaxed flex gap-2">
                      <span className="text-accent shrink-0">✓</span>
                      <span>{inc}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* 5. Pilot CTA */}
        <section className="bg-slate-950 text-white rounded-2xl p-8 text-center">
          <h2 className="text-2xl font-bold tracking-tight mb-2">Would you pay for this?</h2>
          <p className="text-sm text-slate-300 max-w-xl mx-auto leading-relaxed mb-5">
            We're picking the next templates to build by who has budget today, not who has the coolest use case.
            If this lines up with your week, drop us a line — we'll send a pilot link before the public release.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href={pilotMailto}
              className="inline-flex items-center justify-center bg-white text-slate-950 px-6 py-3 rounded-lg text-sm font-semibold hover:opacity-90 transition"
            >
              Pitch us your pilot →
            </a>
            <Link to="/templates" className="inline-flex items-center justify-center border border-white/25 text-white px-6 py-3 rounded-lg text-sm font-semibold hover:bg-white/5 transition">
              See other templates
            </Link>
          </div>
          <p className="text-[11px] text-slate-500 mt-5">
            No card, no NDA. We'll reply within 1 business day or self-decline.
          </p>
        </section>
      </main>
    </div>
  );
}
