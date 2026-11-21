import { api, session } from '@/lib/api';
import { AddMemberForm, MemberRow } from '@/components/forms';
import { Card } from '@/components/ui/primitives';

export default async function TeamPage() {
  const { org, user } = await session();
  const members = await api<Array<{ userId: string; email: string; name: string; role: string }>>(`/orgs/${org.id}/members`);
  const canManage = org.role === 'OWNER' || org.role === 'ADMIN';
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Team</h1>
      {canManage && <Card><AddMemberForm orgId={org.id} /><p className="mt-2 text-xs text-muted">Email invitations are not implemented: the person must already have a ContractGuard account.</p></Card>}
      <Card><table className="w-full text-left text-sm"><thead className="text-xs text-muted"><tr><th className="py-1">Name</th><th>Email</th><th>Role</th><th /></tr></thead>
        <tbody>{members.map((m) => <MemberRow key={m.userId} orgId={org.id} member={m} canManage={canManage && m.userId !== user.id} />)}</tbody></table></Card>
    </div>
  );
}
