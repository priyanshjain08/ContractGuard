import { api, session } from '@/lib/api';
import { GithubLinkForm } from '@/components/forms';
import { UnlinkGithub } from '@/components/unlink-github';
import { Badge, Card } from '@/components/ui/primitives';

export default async function SettingsPage() {
  const { org, user } = await session();
  const isAdmin = org.role === 'OWNER' || org.role === 'ADMIN';
  const [projects, links, audit] = await Promise.all([
    api<Array<{ id: string; name: string }>>(`/orgs/${org.id}/projects`),
    isAdmin ? api<Array<{ id: string; repo: string; specPath: string; installationId: number; projectId: string }>>(`/orgs/${org.id}/integrations/github`) : Promise.resolve([]),
    isAdmin ? api<Array<{ id: string; action: string; at: string; targetType?: string }>>(`/orgs/${org.id}/audit?limit=25`) : Promise.resolve([]),
  ]);
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? 'unknown';
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Card><h2 className="mb-2 font-medium">Account</h2><p className="text-sm">{user.name} · {user.email}</p><p className="mt-1 text-sm text-muted">Organization: {org.name} · role <Badge value={org.role} /> · plan {org.plan}</p>
        <p className="mt-2 text-xs text-muted">Plan changes are applied by the billing webhook adapter (not included); limits are enforced by the API today.</p></Card>
      <Card><h2 className="mb-3 font-medium">GitHub pull-request checks</h2>
        {!isAdmin ? <p className="text-sm text-muted">Only owners and admins can manage integrations.</p> : <>
          <p className="mb-3 text-sm text-muted">Install the ContractGuard GitHub App on a repository, then link it to a project. Webhook URL: <code>/api/webhooks/github</code>.</p>
          {projects.length > 0 ? <GithubLinkForm orgId={org.id} projects={projects} /> : <p className="text-sm text-muted">Create a project first.</p>}
          <ul className="mt-4 space-y-2 text-sm">{links.map((l) => <li key={l.id} className="flex items-center justify-between rounded-md border border-line p-2"><span><code>{l.repo}</code> · {l.specPath} → {name(l.projectId)} (installation {l.installationId})</span><UnlinkGithub orgId={org.id} id={l.id} /></li>)}</ul></>}
      </Card>
      {isAdmin && <Card><h2 className="mb-3 font-medium">Audit log</h2>
        <table className="w-full text-sm"><tbody>{audit.map((a) => <tr key={a.id} className="border-t border-line first:border-0"><td className="py-1.5"><code>{a.action}</code></td><td className="text-muted">{a.targetType}</td><td className="text-right text-muted">{new Date(a.at).toLocaleString()}</td></tr>)}</tbody></table></Card>}
    </div>
  );
}
