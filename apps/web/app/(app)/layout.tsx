import { api, session } from '@/lib/api';
import { Shell } from '@/components/shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await session();
  const notes = await api<Array<{ readAt?: string }>>(`/orgs/${s.org.id}/notifications`);
  return <Shell user={s.user} orgs={s.orgs} activeOrgId={s.org.id} unread={notes.filter((n) => !n.readAt).length}>{children}</Shell>;
}
