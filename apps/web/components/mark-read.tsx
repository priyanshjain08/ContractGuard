'use client';
import { call } from '@/lib/client';
import { SimpleAction } from '@/components/forms';
export function MarkRead({ orgId, id }: { orgId: string; id: string }) {
  return <SimpleAction label="Mark read" variant="ghost" onRun={() => call('POST', `/orgs/${orgId}/notifications/${id}/read`)} />;
}
