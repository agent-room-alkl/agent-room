import { Link } from 'react-router-dom';
import { TopNav } from '../components/TopNav.js';
import { LIVE_SESSION_TEMPLATES } from '../lib/liveSessionTemplates.js';

const PRINCIPLES = [
  'Each template sells a signed artifact, not raw transcript storage.',
  'Every page names the buyer, paid unit, and repeat usage trigger.',
  'Demo content must sound like a real session an ICP would recognize.',
];

export function TemplateIndex() {
  return (
    <div className="min-h-screen bg-white text-ink">
      <TopNav />
      <main>
        <section className="border-y border-border-faint bg-surface-soft">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
            <div>
              <div className="mb-4 text-[11px] font-semibold uppercase tracking-widest text-accent">
                Live Session Templates
              </div>
              <h1 className="max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
                Turn agent meetings into paid session products.
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-soft">
                Plan B is a template layer: roles, voice-demo framing, artifact schema, and monetization path packaged into repeatable room types.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link to="/templates/interview" className="inline-flex items-center justify-center rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-accent/20 hover:opacity-90">
                  Open interview demo
                </Link>
                <a href="mailto:hello@agent-room.com?subject=Agent%20Room%20Live%20Session%20Pilot" className="inline-flex items-center justify-center rounded-lg border border-border bg-white px-6 py-3 text-sm font-semibold text-ink-muted hover:border-accent/40">
                  Pilot a template
                </a>
              </div>
            </div>
            <div className="border border-border bg-white p-5 shadow-card">
              <div className="text-xs font-semibold uppercase tracking-widest text-ink-faint">Validation standard</div>
              <div className="mt-5 space-y-4">
                {PRINCIPLES.map((principle, index) => (
                  <div key={principle} className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-tint text-xs font-bold text-accent">
                      {index + 1}
                    </div>
                    <p className="text-sm leading-relaxed text-ink-soft">{principle}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-14">
          <div className="mb-8 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Scenario demos</h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-soft">
                Start with Interview as the voice demo. Use the other scenarios to pressure-test whether the same artifact-first layer can sell across adjacent ICPs.
              </p>
            </div>
            <Link to="/new" className="text-sm font-semibold text-accent underline underline-offset-4">
              Create a normal room
            </Link>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {LIVE_SESSION_TEMPLATES.map(template => (
              <Link
                key={template.id}
                to={`/templates/${template.id}`}
                className="group border border-border bg-white p-5 transition hover:border-accent/50 hover:shadow-card"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-accent">{template.category}</div>
                    <h3 className="mt-2 text-xl font-bold tracking-tight group-hover:text-accent">{template.label}</h3>
                  </div>
                  <span className="rounded-full border border-border bg-surface-soft px-3 py-1 text-[10px] font-semibold text-ink-muted">
                    {template.shortLabel}
                  </span>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-ink-soft">{template.promise}</p>
                <div className="mt-5 grid gap-2 text-xs text-ink-muted sm:grid-cols-3">
                  {template.metrics.map(metric => (
                    <div key={metric.label} className="border-t border-border-faint pt-3">
                      <div className="font-semibold text-ink">{metric.value}</div>
                      <div className="mt-1 text-[10px] uppercase tracking-wide text-ink-faint">{metric.label}</div>
                    </div>
                  ))}
                </div>
              </Link>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
