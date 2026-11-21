import Link from 'next/link';
import { api, session } from '@/lib/api';
import { CompareForm, SimpleAction, UploadSpecForm } from '@/components/forms';
import { Badge, Card } from '@/components/ui/primitives';
import { DeleteProject } from '@/components/delete-project';

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { org } = await session();
  const [project, versions, comparisons, policies] = await Promise.all([
    api<{ id: string; name: string; description?: string; environments: Array<{ id: string; name: string }> }>(`/orgs/${org.id}/projects/${projectId}`),
    api<Array<{ id: string; number: number; label: string; title: string; apiVersion: string; openapi: string; checksum: string; sizeBytes: number; source: string; createdAt: string }>>(`/orgs/${org.id}/projects/${projectId}/versions`),
    api<Array<{ id: string; baseVersionId: string; targetVersionId: string; status: string; result?: string; createdAt: string }>>(`/orgs/${org.id}/comparisons?projectId=${projectId}`),
    api<Array<{ id: string; name: string; version: number }>>(`/orgs/${org.id}/policies?projectId=${projectId}`),
  ]);
  const num = new Map(versions.map((v) => [v.id, v.number]));
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between"><div><h1 className="text-2xl font-semibold">{project.name}</h1><p className="text-sm text-muted">{project.description} · environments: {project.environments.map((e) => e.name).join(', ')}</p></div>
        <DeleteProject orgId={org.id} projectId={project.id} /></div>
      <Card><h2 className="mb-3 font-medium">Add a specification version</h2><UploadSpecForm orgId={org.id} projectId={project.id} /></Card>
      <Card><h2 className="mb-3 font-medium">Compare versions</h2><CompareForm orgId={org.id} versions={versions} policies={policies} /></Card>
      <Card><h2 className="mb-3 font-medium">Version registry <span className="text-xs text-muted">(immutable)</span></h2>
        {versions.length === 0 ? <p className="text-sm text-muted">No versions yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-muted"><tr><th className="py-1">#</th><th>Label</th><th>API</th><th>OpenAPI</th><th>Source</th><th>SHA-256</th><th>Added</th></tr></thead>
            <tbody>{versions.map((v) => <tr key={v.id} className="border-t border-line"><td className="py-2">v{v.number}</td><td>{v.label}</td><td>{v.title} {v.apiVersion}</td><td>{v.openapi}</td><td>{v.source}</td><td><code className="text-xs">{v.checksum.slice(0, 12)}</code></td><td className="text-muted">{new Date(v.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>)}
      </Card>
      <Card><h2 className="mb-3 font-medium">Comparison history</h2>
        {comparisons.length === 0 ? <p className="text-sm text-muted">No comparisons yet.</p> : (
          <table className="w-full text-sm"><tbody>{comparisons.map((c) => <tr key={c.id} className="border-t border-line first:border-0"><td className="py-2"><Link className="text-brand hover:underline" href={`/comparisons/${c.id}`}>v{num.get(c.baseVersionId) ?? '?'} → v{num.get(c.targetVersionId) ?? '?'}</Link></td><td><Badge value={c.result ?? c.status} /></td><td className="text-right text-muted">{new Date(c.createdAt).toLocaleString()}</td></tr>)}</tbody></table>)}
      </Card>
    </div>
  );
}
