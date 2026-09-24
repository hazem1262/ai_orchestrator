import type { Source } from '@orc/core';
import { type ReactNode, useState } from 'react';
import { usePlanContent } from '@/api/queries/safety.ts';
import { useSessionLinks } from '@/api/queries/session-detail.ts';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mb-4">
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

const Empty = () => <p className="text-xs text-neutral-500">None</p>;
const LINK = 'text-primary underline';

export function LinksTab({ source, id }: { source: Source; id: string }) {
  const q = useSessionLinks(source, id);
  const [planPath, setPlanPath] = useState<string | null>(null);
  const plan = usePlanContent(planPath);
  if (q.isLoading) return <p className="p-3">Loading links…</p>;
  if (q.isError || !q.data)
    return (
      <p role="alert" className="p-3">
        Could not load links.
      </p>
    );
  const l = q.data;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <Section title="Pull requests">
          {l.prs.length === 0 ? (
            <Empty />
          ) : (
            <ul>
              {l.prs.map((p) => (
                <li key={p.url}>
                  <a href={p.url} target="_blank" rel="noreferrer" className={LINK}>
                    {`${p.repo}#${p.number}`}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Tickets">
          {l.tickets.length === 0 ? (
            <Empty />
          ) : (
            <ul>
              {l.tickets.map((t) => (
                <li key={t.id}>
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noreferrer" className={LINK}>
                      {t.id}
                    </a>
                  ) : (
                    <span>{t.id}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Plans">
          {l.plans.length === 0 ? (
            <Empty />
          ) : (
            <ul>
              {l.plans.map((p) => (
                <li key={p.path}>
                  <button
                    type="button"
                    className="underline"
                    title={p.path}
                    onClick={() => setPlanPath(p.path)}
                  >
                    {p.title}
                  </button>
                  <span className="ml-2 text-xs text-neutral-500">
                    {p.source} · matched by {p.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Artifacts">
          {l.artifacts.length === 0 ? (
            <Empty />
          ) : (
            <ul>
              {l.artifacts.map((a) => (
                <li key={`${a.url ?? ''}|${a.path ?? ''}`}>
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noreferrer" className={LINK}>
                      {a.title ?? a.url}
                    </a>
                  ) : (
                    <span>{a.title ?? a.path}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Remote-control bridge">
          {l.bridgeSessionId ? <code>{l.bridgeSessionId}</code> : <Empty />}
        </Section>
      </div>
      {planPath && (
        <section aria-label="Plan" className="text-xs">
          <h3 className="mb-1 font-mono">{planPath}</h3>
          <pre data-testid="plan-content" className="whitespace-pre-wrap rounded bg-neutral-50 p-2">
            {plan.data?.text ?? (plan.isError ? 'Could not load the plan.' : 'Loading…')}
          </pre>
        </section>
      )}
    </div>
  );
}
