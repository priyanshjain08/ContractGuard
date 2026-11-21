import Link from 'next/link';
import { api, session } from '@/lib/api';
import { SimpleAction } from '@/components/forms';
import { MarkRead } from '@/components/mark-read';
import { Card } from '@/components/ui/primitives';

export default async function NotificationsPage() {
  const { org } = await session();
  const notes = await api<Array<{ id: string; title: string; body: string; link?: string; readAt?: string; createdAt: string }>>(`/orgs/${org.id}/notifications`);
  void SimpleAction;
  return (
    <div className="space-y-4"><h1 className="text-2xl font-semibold">Notifications</h1>
      {notes.length === 0 ? <p className="text-sm text-muted">Nothing yet. You will be notified when comparisons finish or fail.</p> : notes.map((n) => (
        <Card key={n.id} className={n.readAt ? 'opacity-60' : ''}><div className="flex items-center justify-between gap-3"><div><div className="font-medium">{n.title}</div><div className="text-sm text-muted">{n.body}</div>
          <div className="mt-1 text-xs text-muted">{new Date(n.createdAt).toLocaleString()}{n.link && <> · <Link className="text-brand" href={n.link}>Open</Link></>}</div></div>{!n.readAt && <MarkRead orgId={org.id} id={n.id} />}</div></Card>))}
    </div>
  );
}
