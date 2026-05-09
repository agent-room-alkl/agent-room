import { Link, Navigate, useParams } from 'react-router-dom';
import { TopNav } from '../components/TopNav.js';
import { liveSessionTemplateById } from '../lib/liveSessionTemplates.js';

export function TemplateDetail() {
  const { templateId } = useParams();
  const template = liveSessionTemplateById(templateId);
  if (!template) return <Navigate to="/templates" replace />;

  const newRoomUrl = `/new?topic=${encodeURIComponent(template.topicSeed)}&template=${encodeURIComponent(template.id)}`;

  return (
    <div className="min-h-screen bg-white text-ink">
      <TopNav />
      <main>
        <section className="border-y border-border-faint bg-surface-soft">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <Link to="/templates" className="text-sm font-semibold text-accent underline underline-offset-4">
                Templates
              </Link>
              <div className="mt-5 text-[11px] font-semibold uppercase tracking-widest text-accent">{template.category}</div>
              <h1 className="mt-3 text-4xl font-bold leading-tight tracking-tight sm:text-6xl">{template.label}</h1>
              <p className="mt-5 text-lg leading-relaxed text-ink-soft">{template.promise}</p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link to={newRoomUrl} className="inline-flex items-center justify-center rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-accent/20 hover:opacity-90">
                  Try page flow
                </Link>
                <a href={`mailto:hello@agent-room.com?subject=${encodeURIComponent(template.label + ' pilot')}`} className="inline-flex items-center justify-center rounded-lg border border-border bg-white px-6 py-3 text-sm font-semibold text-ink-muted hover:border-accent/40">
                  Discuss pilot
                </a>
              </div>
            </div>

            <VoiceDemoPanel />
          </div>
        </section>

        <section className="mx-auto grid max-w-6xl gap-6 px-6 py-12 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="border border-border bg-white p-6 shadow-card">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-ink-faint">Paid artifact</div>
            <h2 className="mt-3 text-2xl font-bold tracking-tight">{template.artifact.title}</h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">{template.artifact.description}</p>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {template.artifact.fields.map(field => (
                <div key={field} className="rounded-md border border-border-faint bg-surface-soft px-3 py-2 text-xs font-semibold text-ink-muted">
                  {field}
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {template.metrics.map(metric => (
              <div key={metric.label} className="border border-border bg-white p-5 shadow-sm">
                <div className="text-2xl font-bold tracking-tight">{metric.value}</div>
                <div className="mt-2 text-[10px] font-semibold uppercase tracking-widest text-ink-faint">{metric.label}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="border-y border-border-faint bg-white">
          <div className="mx-auto grid max-w-6xl gap-8 px-6 py-12 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Mock session transcript</h2>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                These are intentionally concrete. The demo has to feel like a real paid session, or the template is not ready.
              </p>
              <div className="mt-6">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-ink-faint">Template roles</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {template.roles.map(role => (
                    <span key={role} className="rounded-full border border-accent-tint-border bg-accent-tint px-3 py-1 text-xs font-semibold text-accent">
                      {role}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-3">
              {template.demoMessages.map(message => (
                <div key={`${message.speaker}-${message.text}`} className={`border p-4 ${
                  message.tone === 'agent'
                    ? 'border-accent-tint-border bg-accent-tint/45'
                    : message.tone === 'guest'
                      ? 'border-emerald-200 bg-emerald-50'
                      : 'border-border bg-surface-soft'
                }`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-bold">{message.speaker}</div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{message.role}</div>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-ink-soft">{message.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-12">
          <div className="grid gap-4 lg:grid-cols-3">
            <BusinessBlock title="Who pays" text={template.buyer} />
            <BusinessBlock title="Pricing hypothesis" text={template.pricing} />
            <BusinessBlock title="Repeat trigger" text={template.frequency} />
          </div>
          <div className="mt-8 border border-border bg-surface-soft p-6">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-accent">Conversion hook</div>
            <div className="mt-3 text-2xl font-bold tracking-tight">{template.conversion}</div>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-soft">{template.proof}</p>
          </div>
        </section>
      </main>
    </div>
  );
}

function VoiceDemoPanel() {
  return (
    <div className="border border-border bg-[#111318] p-5 text-white shadow-card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-emerald-300">Voice demo shell</div>
          <div className="mt-1 text-xl font-bold tracking-tight">Live interview in progress</div>
        </div>
        <div className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-semibold text-emerald-200">Page demo</div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-[0.85fr_1.15fr]">
        <div className="border border-white/10 bg-white/5 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-white/45">Candidate</div>
          <div className="mt-2 text-lg font-bold">Maya Chen</div>
          <div className="mt-1 text-sm text-white/65">Senior frontend engineer</div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-[68%] bg-emerald-300" />
          </div>
          <div className="mt-2 text-xs text-white/50">12:18 / 18:00</div>
        </div>

        <div className="border border-white/10 bg-white/5 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-white/45">Scorecard preview</div>
            <div className="text-xs font-semibold text-emerald-200">Advance with follow-up</div>
          </div>
          {[
            ['Incident judgment', '8.4'],
            ['System reasoning', '7.8'],
            ['Communication clarity', '8.1'],
          ].map(([label, value]) => (
            <div key={label} className="mb-3">
              <div className="mb-1 flex justify-between text-xs">
                <span className="text-white/70">{label}</span>
                <span className="font-bold text-white">{value}</span>
              </div>
              <div className="h-1.5 rounded-full bg-white/10">
                <div className="h-full rounded-full bg-[#F59E0B]" style={{ width: `${Number(value) * 10}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BusinessBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="border border-border bg-white p-5 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">{title}</div>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{text}</p>
    </div>
  );
}
