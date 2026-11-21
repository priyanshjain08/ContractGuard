import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, PLAN_LIMITS, type Role } from '@contractguard/domain';
import { fixture, harness, newUser } from './helpers.ts';

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

async function seeded() {
  const h = harness();
  const a = await newUser(h, 'Alice');
  const p = await h.svc.createProject(a.actor, a.org.id, { name: 'P1' });
  const v1 = await h.svc.uploadSpec(a.actor, a.org.id, p.id, { content: fixture('petstore-v1.yaml') });
  const v2 = await h.svc.uploadSpec(a.actor, a.org.id, p.id, { content: fixture('petstore-v2.yaml') });
  const cmp = await h.svc.requestComparison(a.actor, a.org.id, { baseVersionId: v1.version.id, targetVersionId: v2.version.id });
  await h.runQueue();
  return { h, a, p, v1, v2, cmp };
}

test('tenant isolation: another org gets NOT_FOUND for every resource, whichever org id it supplies', async () => {
  const { h, a, p, v1, v2, cmp } = await seeded();
  const b = await newUser(h, 'Bob');
  const f = (await h.svc.listFindings(a.actor, a.org.id, cmp.id)).items[0]!;
  const attempts: Array<() => Promise<unknown>> = [
    () => h.svc.getProject(b.actor, a.org.id, p.id), () => h.svc.listProjects(b.actor, a.org.id), () => h.svc.listVersions(b.actor, a.org.id, p.id),
    () => h.svc.getComparison(b.actor, a.org.id, cmp.id), () => h.svc.listFindings(b.actor, a.org.id, cmp.id), () => h.svc.exportReport(b.actor, a.org.id, cmp.id, 'json'),
    () => h.svc.getDashboard(b.actor, a.org.id), () => h.svc.listAudit(b.actor, a.org.id), () => h.svc.explain(b.actor, a.org.id, cmp.id, f.id),
    // attacker's own org + victim's resource ids
    () => h.svc.getProject(b.actor, b.org.id, p.id), () => h.svc.getComparison(b.actor, b.org.id, cmp.id), () => h.svc.listFindings(b.actor, b.org.id, cmp.id),
    () => h.svc.exportReport(b.actor, b.org.id, cmp.id, 'json'), () => h.svc.getVersionContent(b.actor, b.org.id, v1.version.id),
    () => h.svc.requestComparison(b.actor, b.org.id, { baseVersionId: v1.version.id, targetVersionId: v2.version.id }),
    () => h.svc.uploadSpec(b.actor, b.org.id, p.id, { content: fixture('petstore-v1.yaml') }),
    () => h.svc.deleteProject(b.actor, b.org.id, p.id),
  ];
  for (const [i, fn] of attempts.entries()) await assert.rejects(fn, code('NOT_FOUND'), `attempt ${i}`);
  assert.equal((await h.svc.listProjects(a.actor, a.org.id)).length, 1, 'victim data untouched');
});

test('role matrix: viewer reads only; member works; admin manages; owner is special', async () => {
  const { h, a, p, v1, v2 } = await seeded();
  await h.svc.setPlanFromBilling(a.org.id, 'PRO'); // FREE caps members at 3
  const roles: Role[] = ['VIEWER', 'MEMBER', 'ADMIN'];
  const users = {} as Record<Role, Awaited<ReturnType<typeof newUser>>>;
  for (const r of roles) { users[r] = await newUser(h, r); await h.svc.addMember(a.actor, a.org.id, users[r].email, r); }

  const v = users.VIEWER.actor, m = users.MEMBER.actor, ad = users.ADMIN.actor;
  await h.svc.listProjects(v, a.org.id);
  await assert.rejects(() => h.svc.createProject(v, a.org.id, { name: 'X1' }), code('FORBIDDEN'));
  await assert.rejects(() => h.svc.uploadSpec(v, a.org.id, p.id, { content: fixture('petstore-v1.yaml') }), code('FORBIDDEN'));
  await assert.rejects(() => h.svc.requestComparison(v, a.org.id, { baseVersionId: v1.version.id, targetVersionId: v2.version.id }), code('FORBIDDEN'));
  await h.svc.exportReport(v, a.org.id, (await h.svc.listComparisons(v, a.org.id))[0]!.id, 'csv'); // viewers may export

  await h.svc.createProject(m, a.org.id, { name: 'Member project' });
  await h.svc.requestComparison(m, a.org.id, { baseVersionId: v1.version.id, targetVersionId: v2.version.id });
  await assert.rejects(() => h.svc.savePolicy(m, a.org.id, { name: 'P', policy: {} }), code('FORBIDDEN'));
  await assert.rejects(() => h.svc.listAudit(m, a.org.id), code('FORBIDDEN'));
  await assert.rejects(() => h.svc.addMember(m, a.org.id, 'x@example.com', 'VIEWER'), code('FORBIDDEN'));
  await assert.rejects(() => h.svc.deleteProject(m, a.org.id, p.id), code('FORBIDDEN'));

  await h.svc.savePolicy(ad, a.org.id, { name: 'Admin policy', policy: {} });
  await h.svc.listAudit(ad, a.org.id);
  await assert.rejects(() => h.svc.addMember(ad, a.org.id, users.VIEWER.email, 'VIEWER'), code('CONFLICT'), 'already member check');
  const extra = await newUser(h, 'Extra');
  await assert.rejects(() => h.svc.addMember(ad, a.org.id, extra.email, 'OWNER'), code('FORBIDDEN'), 'admin cannot mint owners');
  await assert.rejects(() => h.svc.changeMemberRole(ad, a.org.id, a.user.id, 'VIEWER'), code('FORBIDDEN'), 'admin cannot demote owner');
  await assert.rejects(() => h.svc.removeMember(ad, a.org.id, a.user.id), code('FORBIDDEN'), 'admin cannot remove owner');
  await h.svc.removeMember(m, a.org.id, m.userId); // anyone may leave
});

test('an organization always keeps at least one owner', async () => {
  const { h, a } = await seeded();
  await assert.rejects(() => h.svc.changeMemberRole(a.actor, a.org.id, a.user.id, 'ADMIN'), code('CONFLICT'));
  await assert.rejects(() => h.svc.removeMember(a.actor, a.org.id, a.user.id), code('CONFLICT'));
  const b = await newUser(h, 'Bob');
  await h.svc.addMember(a.actor, a.org.id, b.email, 'OWNER');
  await h.svc.changeMemberRole(a.actor, a.org.id, a.user.id, 'ADMIN');
});

test('spec registry is immutable, deduplicated and validated', async () => {
  const { h, a, p, v1 } = await seeded();
  assert.equal(typeof (h.store as any).updateSpecVersion, 'undefined');
  assert.equal(typeof (h.store as any).deleteSpecVersion, 'undefined');
  const again = await h.svc.uploadSpec(a.actor, a.org.id, p.id, { content: fixture('petstore-v1.yaml') });
  assert.equal(again.duplicate, true);
  assert.equal(again.version.id, v1.version.id);
  assert.equal((await h.svc.listVersions(a.actor, a.org.id, p.id)).length, 2);
  const stored = await h.svc.getVersionContent(a.actor, a.org.id, v1.version.id);
  assert.throws(() => { (stored as any).content = 'tampered'; }, TypeError);
  await assert.rejects(() => h.svc.uploadSpec(a.actor, a.org.id, p.id, { content: 'swagger: "2.0"' }), code('INVALID_SPEC'));
  await assert.rejects(() => h.svc.uploadSpec(a.actor, a.org.id, p.id, { content: 'x'.repeat(PLAN_LIMITS.FREE.maxSpecBytes + 1) }), code('VALIDATION'));
  await assert.rejects(() => h.svc.uploadSpec(a.actor, a.org.id, p.id, { content: 42 as any }), code('VALIDATION'));
});

test('comparison inputs: distinct versions, same project, existing policy', async () => {
  const { h, a, v1, v2 } = await seeded();
  const p2 = await h.svc.createProject(a.actor, a.org.id, { name: 'Other' });
  const other = await h.svc.uploadSpec(a.actor, a.org.id, p2.id, { content: fixture('petstore-v1.yaml') });
  await assert.rejects(() => h.svc.requestComparison(a.actor, a.org.id, { baseVersionId: v1.version.id, targetVersionId: v1.version.id }), code('VALIDATION'));
  await assert.rejects(() => h.svc.requestComparison(a.actor, a.org.id, { baseVersionId: v1.version.id, targetVersionId: other.version.id }), code('VALIDATION'));
  await assert.rejects(() => h.svc.requestComparison(a.actor, a.org.id, { baseVersionId: v1.version.id, targetVersionId: v2.version.id, policyId: 'nope' }), code('NOT_FOUND'));
});

test('plan limits are enforced and lifted by a billing plan change', async () => {
  const h = harness();
  const a = await newUser(h);
  for (let i = 0; i < PLAN_LIMITS.FREE.projects; i++) await h.svc.createProject(a.actor, a.org.id, { name: `Project ${i}` });
  await assert.rejects(() => h.svc.createProject(a.actor, a.org.id, { name: 'One too many' }), code('LIMIT_EXCEEDED'));
  await h.svc.setPlanFromBilling(a.org.id, 'PRO');
  await h.svc.createProject(a.actor, a.org.id, { name: 'One too many' });
  assert.equal((await h.svc.getDashboard(a.actor, a.org.id)).usage.plan, 'PRO');
});

test('monthly comparison quota resets with the calendar month', async () => {
  const { h, a, v1, v2 } = await seeded();
  const spy = h.store.countComparisonsSince.bind(h.store);
  h.store.countComparisonsSince = async (...args) => (args[1].getTime() === Date.UTC(2026, 2, 1) ? PLAN_LIMITS.FREE.comparisonsPerMonth : spy(...args));
  await assert.rejects(() => h.svc.requestComparison(a.actor, a.org.id, { baseVersionId: v1.version.id, targetVersionId: v2.version.id }), code('LIMIT_EXCEEDED'));
  h.clock.t = new Date('2026-04-02T00:00:00Z');
  await h.svc.requestComparison(a.actor, a.org.id, { baseVersionId: v1.version.id, targetVersionId: v2.version.id });
});

test('auth: validation, duplicate emails, lockout, expiry, logout', async () => {
  const h = harness();
  await assert.rejects(() => h.svc.signup({ email: 'nope', password: 'correct-horse-battery', name: 'A' }), code('VALIDATION'));
  await assert.rejects(() => h.svc.signup({ email: 'a@example.com', password: 'short', name: 'A' }), code('VALIDATION'));
  const { email } = await newUser(h);
  await assert.rejects(() => h.svc.signup({ email: email.toUpperCase(), password: 'correct-horse-battery', name: 'A' }), code('CONFLICT'));

  for (let i = 0; i < 5; i++) await assert.rejects(() => h.svc.login({ email, password: 'wrong-password-123' }), code('UNAUTHENTICATED'));
  await assert.rejects(() => h.svc.login({ email, password: 'correct-horse-battery' }), code('RATE_LIMITED'), 'locked out even with the right password');
  h.clock.advance(16 * 60 * 1000);
  const s = await h.svc.login({ email, password: 'correct-horse-battery' });
  await h.svc.authenticate(s.token);
  await assert.rejects(() => h.svc.login({ email: 'ghost@example.com', password: 'whatever-password' }), (e: AppError) => e.code === 'UNAUTHENTICATED' && e.message === 'Invalid email or password.');

  h.clock.advance(8 * 24 * 3600 * 1000);
  await assert.rejects(() => h.svc.authenticate(s.token), code('UNAUTHENTICATED'));
  const s2 = await h.svc.login({ email, password: 'correct-horse-battery' });
  await h.svc.logout(s2.token);
  await assert.rejects(() => h.svc.authenticate(s2.token), code('UNAUTHENTICATED'));
  await assert.rejects(() => h.svc.authenticate(undefined), code('UNAUTHENTICATED'));
  await assert.rejects(() => h.svc.authenticate('garbage'), code('UNAUTHENTICATED'));
});

test('sessions are stored hashed, passwords are scrypt-hashed', async () => {
  const h = harness();
  const { email } = await newUser(h);
  const s = await h.svc.login({ email, password: 'correct-horse-battery' });
  const stored = await h.store.getSessionByTokenHash(s.token);
  assert.equal(stored, undefined, 'raw token is never a lookup key');
  const u = await h.store.findUserByEmail(email);
  assert.match(u!.passwordHash, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!u!.passwordHash.includes('correct-horse'));
});
