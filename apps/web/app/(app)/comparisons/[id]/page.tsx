import Link from 'next/link';
import { api, session } from '@/lib/api';
import { AutoRefresh } from '@/components/auto-refresh';
import { ExplainButton } from '@/components/forms';
import { buttonClass } from '@/components/ui/button';
import { Badge, Card, Input, Select, Stat } from '@/components/ui/primitives';

interface Comparison {
  id: string; projectId: string; baseVersionId: string; targetVersionId: string; status: string; result?: string; error?: string; engineVersion?: string; createdAt: string;
  summary?: { total: number; suppressed: number; byCategory: Record<string, number>; operations: { added: number; removed: number } };
  report?: { policy: { profile: string }; unsupported: Array<{ construct: string }> };
}
interface Finding {
  id: string; ruleId: string; category: string; severity: string; policyOutcome: string; title: string; summary: string; method?: string; path?: string;
  location: string; schemaPath: string; evidence: string; recommendation: string; oldValue?: unknown; newValue?: unknown; baseLine?: number; targetLine?: number;
  suppression?: { reason: string; author: string };
}
const PAGE = 25;

export default async function ComparisonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { org } = await session();
  const c = await api<Comparison>(`/orgs/${org.id}/comparisons/${id}`);
  const versions = await api<Array<{ id: string; number: number; label: string }>>(`/orgs/${org.id}/projects/${c.projectId}/versions`);
  const label = (vid: string) => { const v = versions.find((x) => x.id === vid); return v ? `v${v.number} (${v.label})` : 'deleted version'; };
  const pending = c.status === 'QUEUED' || c.status === 'RUNNING';

  const offset = Math.max(Number(sp.offset ?? 0) || 0, 0);
  const qs = new URLSearchParams();
  for (const k of ['category', 'severity', 'outcome', 'q']) if (sp[k]) qs.set(k, sp[k]!);
  const findings = c.status === 'COMPLETED' ? await api<{ total: number; items: Finding[] }>(`/orgs/${org.id}/comparisons/${id}/findings?${qs}&limit=${PAGE}&offset=${offset}`) : { total: 0, items: [] };
  const link = (o: number) => { const p = new URLSearchParams(qs); p.set('offset', String(o)); return `?${p}`; };
  const base = `/api/orgs/${org.id}/comparisons/${id}`;

  return (
    <div className="space-y-6">
      <AutoRefresh active={pending} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">{label(c.baseVersionId)} → {label(c.targetVersionId)}</h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted"><Badge value={c.result ?? c.status} />{c.report && <>profile {c.report.policy.profile}</>}{c.engineVersion && <>· engine {c.engineVersion}</>}<Link className="text-brand" href={`/projects/${c.projectId}`}>Back to project</Link></p></div>
        {c.status === 'COMPLETED' && <div className="flex gap-2">{['json', 'csv', 'html'].map((f) => <a key={f} className={buttonClass({ variant: 'outline', size: 'sm' })} href={`${base}/report.${f}`} download>Export {f.toUpperCase()}</a>)}</div>}
      </div>

      {pending && <Card><p className="text-sm">Analysis {c.status === 'QUEUED' ? 'is queued' : 'is running'}… this page refreshes automatically.</p></Card>}
      {c.status === 'FAILED' && <Card><p role="alert" className="text-sm text-danger">Analysis failed: {c.error ?? 'unknown error'}</p></Card>}

      {c.summary && <>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Breaking" value={c.summary.byCategory.BREAKING} tone={c.summary.byCategory.BREAKING ? 'text-danger' : undefined} /><Stat label="Potentially breaking" value={c.summary.byCategory.POTENTIALLY_BREAKING} tone="text-warn" />
          <Stat label="Non-breaking" value={c.summary.byCategory.NON_BREAKING} tone="text-ok" /><Stat label="Informational" value={c.summary.byCategory.INFORMATIONAL} /><Stat label="Suppressed" value={c.summary.suppressed} />
        </div>
        {c.report && c.report.unsupported.length > 0 && <p className="text-xs text-muted">Not analyzed: {[...new Set(c.report.unsupported.map((u) => u.construct))].join(', ')}.</p>}

        <Card>
          <form className="mb-4 flex flex-wrap items-end gap-3" method="get">
            <Input name="q" placeholder="Search findings…" defaultValue={sp.q} className="w-56" aria-label="Search findings" />
            <Select name="category" defaultValue={sp.category ?? ''} aria-label="Category"><option value="">All categories</option><option>BREAKING</option><option>POTENTIALLY_BREAKING</option><option>NON_BREAKING</option><option>INFORMATIONAL</option></Select>
            <Select name="severity" defaultValue={sp.severity ?? ''} aria-label="Severity"><option value="">All severities</option><option>critical</option><option>high</option><option>medium</option><option>low</option><option>info</option></Select>
            <Select name="outcome" defaultValue={sp.outcome ?? ''} aria-label="Outcome"><option value="">All outcomes</option><option>FAIL</option><option>WARN</option><option>PASS</option><option>SUPPRESSED</option></Select>
            <button className={buttonClass({ variant: 'outline' })} type="submit">Filter</button>
          </form>
          <p className="mb-3 text-sm text-muted" data-testid="findings-total">{findings.total} finding(s)</p>
          <ul className="space-y-3">{findings.items.map((f) => (
            <li key={f.id} className="rounded-md border border-line bg-panel-2 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs"><Badge value={f.category} /><Badge value={f.severity} /><Badge value={f.policyOutcome} /><code className="text-muted">{f.ruleId}</code>
                {(f.baseLine || f.targetLine) && <span className="text-muted">{f.baseLine ? `base line ${f.baseLine}` : ''}{f.baseLine && f.targetLine ? ' · ' : ''}{f.targetLine ? `target line ${f.targetLine}` : ''}</span>}</div>
              <h3 className="mt-2 font-medium">{f.title}{f.path && <span className="ml-2 font-normal text-muted"><code>{f.method} {f.path}</code></span>}</h3>
              <p className="mt-1 text-sm">{f.summary}</p>
              <details className="mt-2 text-sm"><summary className="cursor-pointer text-brand">Evidence & recommendation</summary>
                <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-1"><dt className="text-muted">Location</dt><dd>{f.location}{f.schemaPath && f.schemaPath !== '$' ? <> · <code>{f.schemaPath}</code></> : null}</dd>
                  <dt className="text-muted">Evidence</dt><dd>{f.evidence}</dd>
                  {f.oldValue !== undefined && <><dt className="text-muted">Before</dt><dd><code>{JSON.stringify(f.oldValue)}</code></dd></>}
                  {f.newValue !== undefined && <><dt className="text-muted">After</dt><dd><code>{JSON.stringify(f.newValue)}</code></dd></>}
                  <dt className="text-muted">Recommendation</dt><dd>{f.recommendation}</dd>
                  {f.suppression && <><dt className="text-muted">Suppressed</dt><dd>{f.suppression.reason} (by {f.suppression.author})</dd></>}</dl>
                <ExplainButton orgId={org.id} comparisonId={c.id} findingId={f.id} />
              </details>
            </li>))}</ul>
          <div className="mt-4 flex justify-between text-sm">
            {offset > 0 ? <Link className="text-brand" href={link(Math.max(offset - PAGE, 0))}>← Previous</Link> : <span />}
            {offset + PAGE < findings.total ? <Link className="text-brand" href={link(offset + PAGE)}>Next →</Link> : <span />}
          </div>
        </Card></>}
    </div>
  );
}
