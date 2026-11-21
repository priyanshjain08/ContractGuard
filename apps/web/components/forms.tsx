'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { call } from '@/lib/client';
import { Button } from '@/components/ui/button';
import { Input, Label, Select, Textarea } from '@/components/ui/primitives';

/** Small hook: runs an async action, shows errors/success, refreshes server data. */
function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<string | void>) {
    setBusy(true); setError(undefined); setOk(undefined);
    try { const msg = await fn(); if (msg) setOk(msg); router.refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const status = <>{error && <p role="alert" className="text-sm text-danger">{error}</p>}{ok && <p role="status" className="text-sm text-ok">{ok}</p>}</>;
  return { run, busy, status, router };
}

export function CreateProjectForm({ orgId }: { orgId: string }) {
  const { run, busy, status, router } = useAction();
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const form = e.currentTarget;
      run(async () => { const p = await call<{ id: string }>('POST', `/orgs/${orgId}/projects`, { name: f.get('name'), description: f.get('description') || undefined }); form.reset(); router.push(`/projects/${p.id}`); }); }}>
      <div><Label htmlFor="pname">Project name</Label><Input id="pname" name="name" required minLength={2} maxLength={80} className="w-56" /></div>
      <div><Label htmlFor="pdesc">Description</Label><Input id="pdesc" name="description" maxLength={500} className="w-72" /></div>
      <Button type="submit" disabled={busy}>Create project</Button>{status}
    </form>
  );
}

export function UploadSpecForm({ orgId, projectId }: { orgId: string; projectId: string }) {
  const { run, busy, status } = useAction();
  const [mode, setMode] = useState<'file' | 'paste' | 'url'>('file');
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const form = e.currentTarget;
      run(async () => {
        const label = (f.get('label') as string) || undefined;
        let res: { duplicate: boolean; version: { number: number }; warnings: string[] };
        if (mode === 'file') { const file = f.get('file') as File; if (!file?.size) throw new Error('Choose a file.'); const body = new FormData(); body.set('file', file); if (label) body.set('label', label); res = await call('POST', `/orgs/${orgId}/projects/${projectId}/versions`, body); }
        else if (mode === 'paste') res = await call('POST', `/orgs/${orgId}/projects/${projectId}/versions`, { content: f.get('content'), label });
        else res = await call('POST', `/orgs/${orgId}/projects/${projectId}/versions/import-url`, { url: f.get('url'), label });
        form.reset();
        return res.duplicate ? `Identical to existing version v${res.version.number}; nothing new was stored.` : `Stored version v${res.version.number}.${res.warnings.length ? ` ${res.warnings.length} warning(s).` : ''}`;
      }); }}>
      <div className="flex gap-2 text-sm">{(['file', 'paste', 'url'] as const).map((m) => <button key={m} type="button" onClick={() => setMode(m)} className={`rounded px-3 py-1 ${mode === m ? 'bg-panel-2 text-brand' : 'text-muted'}`}>{m === 'file' ? 'Upload file' : m === 'paste' ? 'Paste' : 'Import URL'}</button>)}</div>
      {mode === 'file' && <div><Label htmlFor="file">OpenAPI file (.yaml, .yml, .json — max 5 MB)</Label><input id="file" name="file" type="file" accept=".yaml,.yml,.json,application/json,text/yaml" className="text-sm" /></div>}
      {mode === 'paste' && <div><Label htmlFor="content">Specification</Label><Textarea id="content" name="content" rows={8} required /></div>}
      {mode === 'url' && <div><Label htmlFor="url">HTTPS URL (private and internal addresses are blocked)</Label><Input id="url" name="url" type="url" required placeholder="https://example.com/openapi.yaml" /></div>}
      <div className="flex items-end gap-3"><div><Label htmlFor="label">Label (optional)</Label><Input id="label" name="label" maxLength={60} className="w-48" placeholder="v2.1.0" /></div><Button type="submit" disabled={busy}>Add version</Button></div>
      {status}
    </form>
  );
}

export function CompareForm({ orgId, versions, policies }: { orgId: string; versions: Array<{ id: string; number: number; label: string; title: string }>; policies: Array<{ id: string; name: string; version: number }> }) {
  const { run, busy, status, router } = useAction();
  if (versions.length < 2) return <p className="text-sm text-muted">Add at least two versions to compare them.</p>;
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget);
      run(async () => { const c = await call<{ id: string }>('POST', `/orgs/${orgId}/comparisons`, { baseVersionId: f.get('base'), targetVersionId: f.get('target'), policyId: f.get('policy') || undefined }); router.push(`/comparisons/${c.id}`); }); }}>
      <div><Label htmlFor="base">Base (old)</Label><Select id="base" name="base" defaultValue={versions[1]?.id}>{versions.map((v) => <option key={v.id} value={v.id}>v{v.number} · {v.label}</option>)}</Select></div>
      <div><Label htmlFor="target">Target (new)</Label><Select id="target" name="target" defaultValue={versions[0]?.id}>{versions.map((v) => <option key={v.id} value={v.id}>v{v.number} · {v.label}</option>)}</Select></div>
      <div><Label htmlFor="policy">Policy</Label><Select id="policy" name="policy"><option value="">Project default</option>{policies.map((p) => <option key={p.id} value={p.id}>{p.name} (v{p.version})</option>)}</Select></div>
      <Button type="submit" disabled={busy}>Compare</Button>{status}
    </form>
  );
}

export function ExplainButton({ orgId, comparisonId, findingId }: { orgId: string; comparisonId: string; findingId: string }) {
  const [state, setState] = useState<{ explanation: string; migrationAdvice: string; source: string; rejectedReason?: string } | { error: string }>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); try { setState(await call('POST', `/orgs/${orgId}/comparisons/${comparisonId}/findings/${findingId}/explain`)); } catch (e) { setState({ error: (e as Error).message }); } finally { setBusy(false); } }}>Explain</Button>
      {state && ('error' in state ? <p role="alert" className="mt-2 text-sm text-danger">{state.error}</p> : (
        <div className="mt-2 rounded-md border border-line bg-bg p-3 text-sm">
          <p>{state.explanation}</p><p className="mt-2"><b>Migration:</b> {state.migrationAdvice}</p>
          <p className="mt-2 text-xs text-muted">Source: {state.source === 'llm' ? 'AI-assisted, validated against the finding’s evidence' : 'deterministic rule explanation'}{state.rejectedReason ? ` (AI answer rejected: ${state.rejectedReason})` : ''}</p>
        </div>))}
    </div>
  );
}

export function PolicyForm({ orgId, projects, rules }: { orgId: string; projects: Array<{ id: string; name: string }>; rules: Array<{ id: string; title: string }> }) {
  const { run, busy, status } = useAction();
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget);
      run(async () => {
        const failOn = f.getAll('failOn') as string[];
        const sup = (f.get('suppRule') as string) ? [{ ruleId: f.get('suppRule'), operationPrefix: (f.get('suppOp') as string) || undefined, reason: f.get('suppReason'), expiresAt: f.get('suppExpires') ? new Date(f.get('suppExpires') as string).toISOString() : undefined }] : [];
        const p = await call<{ version: number }>('POST', `/orgs/${orgId}/policies`, { name: f.get('name'), projectId: f.get('projectId') || undefined, policy: { profile: f.get('profile'), failOn, failOnWarnings: f.get('failOnWarnings') === 'on', suppressions: sup } });
        return `Saved as version ${p.version}.`;
      }); }}>
      <div className="flex flex-wrap gap-3">
        <div><Label htmlFor="name">Policy name</Label><Input id="name" name="name" required minLength={2} className="w-56" /></div>
        <div><Label htmlFor="projectId">Applies to</Label><Select id="projectId" name="projectId"><option value="">Whole organization</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
        <div><Label htmlFor="profile">Compatibility profile</Label><Select id="profile" name="profile" defaultValue="standard"><option>conservative</option><option>standard</option><option>permissive</option></Select></div>
      </div>
      <fieldset className="flex flex-wrap gap-4 text-sm"><legend className="mb-1 text-xs text-muted">Fail the check on</legend>
        {['BREAKING', 'POTENTIALLY_BREAKING'].map((c) => <label key={c} className="flex items-center gap-2"><input type="checkbox" name="failOn" value={c} defaultChecked={c === 'BREAKING'} />{c.replace('_', ' ').toLowerCase()}</label>)}
        <label className="flex items-center gap-2"><input type="checkbox" name="failOnWarnings" />treat warnings as failures</label></fieldset>
      <fieldset className="rounded-md border border-line p-3"><legend className="px-1 text-xs text-muted">Optional suppression (author is recorded from your session)</legend>
        <div className="flex flex-wrap gap-3">
          <div><Label htmlFor="suppRule">Rule</Label><Select id="suppRule" name="suppRule"><option value="">None</option>{rules.map((r) => <option key={r.id} value={r.id}>{r.id} · {r.title}</option>)}</Select></div>
          <div><Label htmlFor="suppOp">Operation prefix</Label><Input id="suppOp" name="suppOp" placeholder="GET /pets" className="w-40" /></div>
          <div><Label htmlFor="suppReason">Reason</Label><Input id="suppReason" name="suppReason" className="w-64" /></div>
          <div><Label htmlFor="suppExpires">Expires</Label><Input id="suppExpires" name="suppExpires" type="date" /></div>
        </div></fieldset>
      <Button type="submit" disabled={busy}>Save policy</Button>{status}
    </form>
  );
}

export function AddMemberForm({ orgId }: { orgId: string }) {
  const { run, busy, status } = useAction();
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const form = e.currentTarget;
      run(async () => { await call('POST', `/orgs/${orgId}/members`, { email: f.get('email'), role: f.get('role') }); form.reset(); return 'Member added.'; }); }}>
      <div><Label htmlFor="memail">Email of an existing user</Label><Input id="memail" name="email" type="email" required className="w-64" /></div>
      <div><Label htmlFor="mrole">Role</Label><Select id="mrole" name="role" defaultValue="MEMBER"><option>VIEWER</option><option>MEMBER</option><option>ADMIN</option><option>OWNER</option></Select></div>
      <Button type="submit" disabled={busy}>Add member</Button>{status}
    </form>
  );
}

export function MemberRow({ orgId, member, canManage }: { orgId: string; member: { userId: string; email: string; name: string; role: string }; canManage: boolean }) {
  const { run, status } = useAction();
  return (
    <tr className="border-t border-line"><td className="py-2">{member.name}</td><td className="text-muted">{member.email}</td>
      <td>{canManage ? <Select aria-label={`Role for ${member.email}`} defaultValue={member.role} onChange={(e) => run(async () => { await call('PATCH', `/orgs/${orgId}/members/${member.userId}`, { role: e.target.value }); })}><option>VIEWER</option><option>MEMBER</option><option>ADMIN</option><option>OWNER</option></Select> : member.role}</td>
      <td>{canManage && <Button size="sm" variant="ghost" onClick={() => run(async () => { await call('DELETE', `/orgs/${orgId}/members/${member.userId}`); })}>Remove</Button>}{status}</td></tr>
  );
}

export function GithubLinkForm({ orgId, projects }: { orgId: string; projects: Array<{ id: string; name: string }> }) {
  const { run, busy, status } = useAction();
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const form = e.currentTarget;
      run(async () => { await call('POST', `/orgs/${orgId}/integrations/github`, { projectId: f.get('projectId'), installationId: Number(f.get('installationId')), repo: f.get('repo'), specPath: f.get('specPath') }); form.reset(); return 'Repository linked.'; }); }}>
      <div><Label htmlFor="gproject">Project</Label><Select id="gproject" name="projectId" required>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
      <div><Label htmlFor="ginst">Installation ID</Label><Input id="ginst" name="installationId" type="number" min={1} required className="w-32" /></div>
      <div><Label htmlFor="grepo">Repository</Label><Input id="grepo" name="repo" placeholder="owner/name" required className="w-48" /></div>
      <div><Label htmlFor="gpath">Spec path</Label><Input id="gpath" name="specPath" defaultValue="openapi.yaml" required className="w-48" /></div>
      <Button type="submit" disabled={busy}>Link repository</Button>{status}
    </form>
  );
}

export function SimpleAction({ label, onRun, variant = 'outline' }: { label: string; onRun: () => Promise<unknown>; variant?: 'outline' | 'ghost' | 'destructive' }) {
  const { run, busy, status } = useAction();
  return <span><Button size="sm" variant={variant} disabled={busy} onClick={() => run(async () => { await onRun(); })}>{label}</Button>{status}</span>;
}
