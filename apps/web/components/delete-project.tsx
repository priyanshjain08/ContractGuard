'use client';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';
import { Button } from '@/components/ui/button';

export function DeleteProject({ orgId, projectId }: { orgId: string; projectId: string }) {
  const router = useRouter();
  return <Button variant="destructive" size="sm" onClick={async () => { if (!confirm('Delete this project, all versions and comparisons? This cannot be undone.')) return; try { await call('DELETE', `/orgs/${orgId}/projects/${projectId}`); router.replace('/projects'); router.refresh(); } catch (e) { alert((e as Error).message); } }}>Delete project</Button>;
}
