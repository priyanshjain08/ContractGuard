'use client';
import { call } from '@/lib/client';
import { SimpleAction } from '@/components/forms';
export function UnlinkGithub({ orgId, id }: { orgId: string; id: string }) {
  return <SimpleAction label="Unlink" variant="destructive" onRun={() => call('DELETE', `/orgs/${orgId}/integrations/github/${id}`)} />;
}
