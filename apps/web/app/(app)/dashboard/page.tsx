import Link from 'next/link';
import { api, session } from '@/lib/api';
import { Badge, Card, Stat } from '@/components/ui/primitives';

interface Dashboard {
  org: { name: string; plan: string }; totals: { projects: number; members: number; comparisons: number };
  last30Days: { comparisons: number; PASS: number; FAIL: number; NEEDS_REVIEW: number; pending: number; failed: number };
  openBreakingFindings: number;
  recentComparisons: Array<{ id: string; projectName: string; status: string; result?: string; createdAt: string }>;
  usage: { plan: string; limits: Record<string, number | null>; used: Record<string, number> };
}
const lim = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '∞' : v);

export default async function DashboardPage() {
  const { org } = await session();
  const d = await api<Dashboard>(`/orgs/${org.id}/dashboard`);
  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-semibold">{d.org.name}</h1><p className="text-sm text-muted">{d.org.plan} plan</p></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Projects" value={d.totals.projects} /><Stat label="Comparisons (30d)" value={d.last30Days.comparisons} />
        <Stat label="Open breaking findings" value={d.openBreakingFindings} tone={d.openBreakingFindings ? 'text-danger' : 'text-ok'} /><Stat label="Failed checks (30d)" value={d.last30Days.FAIL} tone={d.last30Days.FAIL ? 'text-danger' : undefined} />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2"><h2 className="mb-3 font-medium">Recent comparisons</h2>
          {d.recentComparisons.length === 0 ? <p className="text-sm text-muted">No comparisons yet. <Link className="text-brand" href="/projects">Create a project</Link> and upload two versions.</p> : (
            <table className="w-full text-sm"><tbody>{d.recentComparisons.map((c) => (
              <tr key={c.id} className="border-t border-line first:border-0"><td className="py-2"><Link className="text-brand hover:underline" href={`/comparisons/${c.id}`}>{c.projectName}</Link></td>
                <td><Badge value={c.result ?? c.status} /></td><td className="text-right text-muted">{new Date(c.createdAt).toLocaleString()}</td></tr>))}</tbody></table>)}
        </Card>
        <Card><h2 className="mb-3 font-medium">Plan usage</h2>
          <ul className="space-y-1 text-sm">
            <li>Projects: {d.usage.used.projects} / {lim(d.usage.limits.projects)}</li><li>Members: {d.usage.used.members} / {lim(d.usage.limits.members)}</li>
            <li>Versions this month: {d.usage.used.versionsThisMonth} / {lim(d.usage.limits.versionsPerMonth)}</li><li>Comparisons this month: {d.usage.used.comparisonsThisMonth} / {lim(d.usage.limits.comparisonsPerMonth)}</li>
          </ul></Card>
      </div>
    </div>
  );
}
