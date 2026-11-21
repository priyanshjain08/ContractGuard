import Link from 'next/link';
import { api, session } from '@/lib/api';
import { CreateProjectForm } from '@/components/forms';
import { Card } from '@/components/ui/primitives';

export default async function ProjectsPage() {
  const { org } = await session();
  const projects = await api<Array<{ id: string; name: string; description?: string; createdAt: string }>>(`/orgs/${org.id}/projects`);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Projects</h1>
      <Card><CreateProjectForm orgId={org.id} /></Card>
      {projects.length === 0 ? <p className="text-sm text-muted">No projects yet.</p> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{projects.map((p) => (
          <Link key={p.id} href={`/projects/${p.id}`}><Card className="hover:border-brand"><div className="font-medium">{p.name}</div><div className="mt-1 text-sm text-muted">{p.description ?? 'No description'}</div></Card></Link>))}</div>)}
    </div>
  );
}
