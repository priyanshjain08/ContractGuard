import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@contractguard/domain';
import { fixture, harness, newUser } from './helpers.ts';

test('vertical slice: login -> project -> two uploads -> queued comparison -> worker -> persisted findings -> export', async () => {
  const h = harness();
  const { email, org } = await newUser(h, 'Ada');
  const session = await h.svc.login({ email, password: 'correct-horse-battery' });
  const user = await h.svc.authenticate(session.token);
  const actor = { userId: user.id };
  assert.ok(!('passwordHash' in user));

  const project = await h.svc.createProject(actor, org.id, { name: 'Petstore API' });
  const v1 = await h.svc.uploadSpec(actor, org.id, project.id, { content: fixture('petstore-v1.yaml') });
  const v2 = await h.svc.uploadSpec(actor, org.id, project.id, { content: fixture('petstore-v2.yaml') });
  assert.deepEqual([v1.version.number, v2.version.number], [1, 2]);
  assert.ok(!('content' in v1.version));

  const queued = await h.svc.requestComparison(actor, org.id, { baseVersionId: v1.version.id, targetVersionId: v2.version.id });
  assert.equal(queued.status, 'QUEUED');
  assert.equal(h.queued.length, 1);
  assert.equal((await h.svc.getComparison(actor, org.id, queued.id)).status, 'QUEUED');

  await h.runQueue(); // what apps/worker does for each BullMQ job
  const done = await h.svc.getComparison(actor, org.id, queued.id);
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.result, 'FAIL');
  assert.equal(done.summary!.total, 28);
  assert.equal(done.summary!.byCategory.BREAKING, 14);
  assert.match(done.engineVersion!, /^\d+\.\d+\.\d+$/);

  const all = await h.svc.listFindings(actor, org.id, queued.id, { limit: 200 });
  assert.equal(all.total, 28);
  const breaking = await h.svc.listFindings(actor, org.id, queued.id, { category: 'BREAKING' });
  assert.equal(breaking.total, 14);
  assert.ok(breaking.items.every((f) => f.evidence && f.ruleId.startsWith('CG-')));
  assert.ok((await h.svc.listFindings(actor, org.id, queued.id, { q: 'stores' })).items.some((f) => f.ruleId === 'CG-PATH-001'));
  const withLines = all.items.filter((f) => f.targetLine || f.baseLine);
  assert.ok(withLines.length > 20, 'findings carry source line numbers');

  const json = await h.svc.exportReport(actor, org.id, queued.id, 'json');
  assert.equal(JSON.parse(json.body).findings.length, 28);
  assert.equal(json.contentType.startsWith('application/json'), true);
  const csv = await h.svc.exportReport(actor, org.id, queued.id, 'csv');
  assert.equal(csv.body.trim().split('\r\n').length, 29);
  const html = await h.svc.exportReport(actor, org.id, queued.id, 'html');
  assert.ok(html.body.includes('ContractGuard compatibility report') && !html.body.includes('<script'));

  const dash = await h.svc.getDashboard(actor, org.id);
  assert.equal(dash.totals.projects, 1);
  assert.equal(dash.last30Days.FAIL, 1);
  assert.equal(dash.openBreakingFindings, 14);
  assert.equal(dash.usage.used.versionsThisMonth, 2);
  assert.equal(dash.recentComparisons[0]!.projectName, 'Petstore API');

  const notes = await h.svc.listNotifications(actor, org.id);
  assert.equal(notes[0]!.kind, 'comparison.completed');
  const audit = await h.svc.listAudit(actor, org.id);
  const actions = audit.map((a) => a.action);
  for (const a of ['project.created', 'spec.uploaded', 'comparison.requested', 'comparison.completed', 'report.exported']) assert.ok(actions.includes(a), a);
});

test('worker is idempotent: re-delivering a finished job changes nothing', async () => {
  const h = harness();
  const { actor, org } = await newUser(h);
  const p = await h.svc.createProject(actor, org.id, { name: 'P1' });
  const a = await h.svc.uploadSpec(actor, org.id, p.id, { content: fixture('petstore-v1.yaml') });
  const b = await h.svc.uploadSpec(actor, org.id, p.id, { content: fixture('petstore-v2.yaml') });
  const c = await h.svc.requestComparison(actor, org.id, { baseVersionId: a.version.id, targetVersionId: b.version.id });
  await h.runQueue();
  await h.svc.processComparison(c.id);
  await h.svc.processComparison(c.id);
  assert.equal((await h.svc.listFindings(actor, org.id, c.id, { limit: 200 })).total, 28);
  assert.equal((await h.svc.listNotifications(actor, org.id)).filter((n) => n.kind === 'comparison.completed').length, 1);
});

test('queue outage marks the comparison FAILED and surfaces an error instead of hanging', async () => {
  const h = harness();
  const { actor, org } = await newUser(h);
  const p = await h.svc.createProject(actor, org.id, { name: 'P1' });
  const a = await h.svc.uploadSpec(actor, org.id, p.id, { content: fixture('petstore-v1.yaml') });
  const b = await h.svc.uploadSpec(actor, org.id, p.id, { content: fixture('petstore-v2.yaml') });
  h.failQueue = true;
  await assert.rejects(() => h.svc.requestComparison(actor, org.id, { baseVersionId: a.version.id, targetVersionId: b.version.id }), (e: AppError) => e.code === 'INTERNAL');
  const list = await h.svc.listComparisons(actor, org.id);
  assert.equal(list[0]!.status, 'FAILED');
});

test('policy with suppressions is applied by the worker and flips the verdict', async () => {
  const h = harness();
  const { actor, org, email } = await newUser(h);
  const p = await h.svc.createProject(actor, org.id, { name: 'P1' });
  const a = await h.svc.uploadSpec(actor, org.id, p.id, { content: fixture('petstore-v1.yaml') });
  const b = await h.svc.uploadSpec(actor, org.id, p.id, { content: fixture('petstore-v2.yaml') });
  const rules = ['CG-PARAM-006', 'CG-PARAM-008', 'CG-RES-013', 'CG-RES-019', 'CG-REQ-012', 'CG-REQ-014', 'CG-REQ-010', 'CG-OP-001', 'CG-PATH-001'];
  const pol = await h.svc.savePolicy(actor, org.id, { name: 'Release train', projectId: p.id, policy: { profile: 'standard', suppressions: rules.map((ruleId) => ({ ruleId, reason: 'Planned v2 migration', author: 'spoofed@evil.test' })) } });
  assert.equal(pol.policy.suppressions![0]!.author, email, 'author is taken from the session, not the request');
  const c = await h.svc.requestComparison(actor, org.id, { baseVersionId: a.version.id, targetVersionId: b.version.id, policyId: pol.id });
  await h.runQueue();
  const done = await h.svc.getComparison(actor, org.id, c.id);
  assert.equal(done.result, 'NEEDS_REVIEW');
  assert.equal(done.summary!.suppressed, 14);
  const sup = (await h.svc.listFindings(actor, org.id, c.id, { outcome: 'SUPPRESSED', limit: 200 })).items;
  assert.equal(sup.length, 14);
  assert.ok(sup.every((f) => f.evidence && f.suppression?.reason === 'Planned v2 migration'));
});

test('policy versions are appended, never edited; invalid policies are rejected', async () => {
  const h = harness();
  const { actor, org } = await newUser(h);
  const v1 = await h.svc.savePolicy(actor, org.id, { name: 'Default', policy: { profile: 'standard' } });
  const v2 = await h.svc.savePolicy(actor, org.id, { name: 'Default', policy: { profile: 'conservative' } });
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  assert.equal((await h.svc.listPolicies(actor, org.id)).length, 2);
  for (const bad of [{ profile: 'wild' }, { failOn: ['NOPE'] }, { ruleOverrides: { 'CG-FAKE-1': {} } }, { suppressions: [{ reason: 'x y z' }] }, { suppressions: [{ ruleId: 'CG-OP-001', reason: 'no' }] }, 'str']) {
    await assert.rejects(() => h.svc.savePolicy(actor, org.id, { name: 'Bad', policy: bad }), (e: AppError) => e.code === 'VALIDATION');
  }
});

test('explain: grounded by default, audited, finding must belong to the tenant', async () => {
  const h = harness();
  const { actor, org } = await newUser(h);
  const p = await h.svc.createProject(actor, org.id, { name: 'P1' });
  const a = await h.svc.uploadSpec(actor, org.id, p.id, { content: fixture('petstore-v1.yaml') });
  const b = await h.svc.uploadSpec(actor, org.id, p.id, { content: fixture('petstore-v2.yaml') });
  const c = await h.svc.requestComparison(actor, org.id, { baseVersionId: a.version.id, targetVersionId: b.version.id });
  await h.runQueue();
  const f = (await h.svc.listFindings(actor, org.id, c.id)).items[0]!;
  const e = await h.svc.explain(actor, org.id, c.id, f.id);
  assert.equal(e.source, 'rules');
  assert.ok(e.explanation.includes(f.summary));
  const other = await newUser(h);
  await assert.rejects(() => h.svc.explain(other.actor, org.id, c.id, f.id), (err: AppError) => err.code === 'NOT_FOUND');
});
