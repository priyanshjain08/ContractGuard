import { api, session } from '@/lib/api';
import { PolicyForm } from '@/components/forms';
import { Badge, Card } from '@/components/ui/primitives';

interface PolicyRec { id: string; name: string; version: number; projectId?: string; createdAt: string; policy: { profile: string; failOn?: string[]; failOnWarnings?: boolean; suppressions?: Array<{ ruleId?: string; operationPrefix?: string; reason: string; author: string; expiresAt?: string }> } }

export default async function PoliciesPage() {
  const { org } = await session();
  const [policies, projects, rules] = await Promise.all([
    api<PolicyRec[]>(`/orgs/${org.id}/policies`),
    api<Array<{ id: string; name: string }>>(`/orgs/${org.id}/projects`),
    api<Array<{ id: string; title: string }>>(`/rules`),
  ]);
  const canWrite = org.role === 'OWNER' || org.role === 'ADMIN';
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Compatibility policies</h1>
      {canWrite ? <Card><h2 className="mb-3 font-medium">New policy version</h2><PolicyForm orgId={org.id} projects={projects} rules={rules} /></Card> : <p className="text-sm text-muted">Only owners and admins can edit policies.</p>}
      <Card><h2 className="mb-3 font-medium">History <span className="text-xs text-muted">(append-only)</span></h2>
        {policies.length === 0 ? <p className="text-sm text-muted">No policies yet. Comparisons use the standard profile and fail on breaking changes.</p> : (
          <ul className="space-y-2 text-sm">{policies.map((p) => (
            <li key={p.id} className="rounded-md border border-line p-3"><div className="flex flex-wrap items-center gap-2"><b>{p.name}</b><span className="text-muted">v{p.version}</span><Badge value={p.policy.profile} /><span className="text-xs text-muted">fails on {(p.policy.failOn ?? ['BREAKING']).join(', ').toLowerCase()}{p.policy.failOnWarnings ? ' + warnings' : ''}</span><span className="ml-auto text-xs text-muted">{new Date(p.createdAt).toLocaleString()}</span></div>
              {p.policy.suppressions?.map((s, i) => <p key={i} className="mt-1 text-xs text-muted">Suppress {s.ruleId}{s.operationPrefix ? ` on ${s.operationPrefix}` : ''}: {s.reason} — {s.author}{s.expiresAt ? `, until ${s.expiresAt.slice(0, 10)}` : ''}</p>)}</li>))}</ul>)}
      </Card>
    </div>
  );
}
