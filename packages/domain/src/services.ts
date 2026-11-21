import { randomUUID } from 'node:crypto';
import { parseOpenApi } from '@contractguard/openapi-parser';
import {
  compare, renderCsv, renderHtmlReport, renderJson, RULES, DEFAULT_POLICY,
  type Category, type ComparisonResult, type Finding, type Policy, type Profile, type Severity,
} from '@contractguard/compatibility';
import { explainFinding, type Explanation, type LlmClient } from './ai.ts';
import { buildCheckRun, type CheckRunOutput, type PullRequestEvent } from './github.ts';
import { assertCan, can, ROLE_RANK, type Permission } from './authz.ts';
import { AppError, notFound } from './errors.ts';
import { assertWithinLimit, PLAN_LIMITS, startOfMonthUtc } from './limits.ts';
import { hashPassword, newToken, sha256Hex, slugify, validateEmail, verifyPassword } from './security.ts';
import type { Store } from './store.ts';
import type {
  Actor, AuditEntry, Clock, ComparisonRecord, Environment, FindingRecord, JobQueue, Membership, Org, PolicyRecord,
  Project, Role, SpecVersion, User,
} from './types.ts';

export interface Deps { store: Store; queue: JobQueue; clock?: Clock }

/** Port for the GitHub App API. The real adapter (installation tokens, REST calls) lives in apps/worker. */
export interface GithubGateway {
  getFile(o: { installationId: number; owner: string; repo: string; ref: string; path: string }): Promise<string | undefined>;
  createCheckRun(o: { installationId: number; owner: string; repo: string; headSha: string; name: string; output: CheckRunOutput; detailsUrl?: string }): Promise<void>;
}

const SESSION_MS = 7 * 24 * 3600 * 1000;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MAX = 5;
const PROFILES: Profile[] = ['conservative', 'standard', 'permissive'];
const CATEGORIES: Category[] = ['BREAKING', 'POTENTIALLY_BREAKING', 'NON_BREAKING', 'INFORMATIONAL'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const str = (v: unknown, field: string, min: number, max: number): string => {
  if (typeof v !== 'string') throw new AppError('VALIDATION', `"${field}" must be a string.`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new AppError('VALIDATION', `"${field}" must be between ${min} and ${max} characters.`);
  return t;
};

export class ContractGuardService {
  private store: Store;
  private queue: JobQueue;
  private clock: Clock;
  /** Hash used to equalize login timing for unknown emails. */
  private dummyHash?: Promise<string>;

  constructor(deps: Deps) {
    this.store = deps.store;
    this.queue = deps.queue;
    this.clock = deps.clock ?? { now: () => new Date() };
  }

  private now() { return this.clock.now(); }

  // ------------------------------------------------------------------ audit & access
  private async audit(orgId: string, actorId: string | undefined, action: string, targetType?: string, targetId?: string, metadata?: Record<string, unknown>) {
    const e: AuditEntry = { id: randomUUID(), orgId, actorId, action, targetType, targetId, metadata, at: this.now() };
    await this.store.appendAudit(e);
  }

  /** Resolves the actor's membership. A non-member gets NOT_FOUND so tenant existence is not leaked. */
  async requireAccess(orgId: string, actor: Actor, permission: Permission): Promise<{ org: Org; membership: Membership }> {
    const membership = await this.store.getMembership(orgId, actor.userId);
    const org = membership ? await this.store.getOrg(orgId) : undefined;
    if (!membership || !org) throw notFound('Organization');
    assertCan(membership.role, permission);
    return { org, membership };
  }

  // ------------------------------------------------------------------ auth
  async signup(input: { email: string; password: string; name: string }): Promise<{ user: Omit<User, 'passwordHash'>; org: Org }> {
    const email = validateEmail(String(input.email ?? ''));
    if (!email) throw new AppError('VALIDATION', 'A valid email address is required.');
    const name = str(input.name, 'name', 1, 80);
    const pw = String(input.password ?? '');
    if (pw.length < 10 || pw.length > 128) throw new AppError('VALIDATION', 'Password must be 10 to 128 characters.');
    if (pw.toLowerCase() === email) throw new AppError('VALIDATION', 'Password must not equal your email.');
    if (await this.store.findUserByEmail(email)) throw new AppError('CONFLICT', 'An account with this email already exists.');

    const user = await this.store.createUser({ id: randomUUID(), email, name, passwordHash: await hashPassword(pw), createdAt: this.now() });
    const org = await this.createOrgInternal(user.id, `${name}'s workspace`);
    const { passwordHash: _omit, ...safe } = user;
    return { user: safe, org };
  }

  async login(input: { email: string; password: string }): Promise<{ token: string; expiresAt: Date; user: Omit<User, 'passwordHash'> }> {
    const email = (validateEmail(String(input.email ?? '')) ?? String(input.email ?? '').toLowerCase()).slice(0, 254);
    const since = new Date(this.now().getTime() - LOCKOUT_WINDOW_MS);
    if ((await this.store.countLoginFailures(email, since)) >= LOCKOUT_MAX) {
      throw new AppError('RATE_LIMITED', 'Too many failed attempts. Try again in a few minutes.');
    }
    const user = await this.store.findUserByEmail(email);
    this.dummyHash ??= hashPassword('dummy-password-for-timing');
    const ok = await verifyPassword(String(input.password ?? ''), user?.passwordHash ?? (await this.dummyHash));
    if (!user || !ok) {
      await this.store.recordLoginFailure(email, this.now());
      throw new AppError('UNAUTHENTICATED', 'Invalid email or password.');
    }
    await this.store.clearLoginFailures(email);
    const token = newToken();
    const expiresAt = new Date(this.now().getTime() + SESSION_MS);
    await this.store.createSession({ id: randomUUID(), userId: user.id, tokenHash: sha256Hex(token), expiresAt, createdAt: this.now() });
    const { passwordHash: _omit, ...safe } = user;
    return { token, expiresAt, user: safe };
  }

  async authenticate(token: string | undefined): Promise<Omit<User, 'passwordHash'>> {
    if (!token) throw new AppError('UNAUTHENTICATED', 'Authentication required.');
    const session = await this.store.getSessionByTokenHash(sha256Hex(token));
    if (!session) throw new AppError('UNAUTHENTICATED', 'Invalid session.');
    if (session.expiresAt <= this.now()) {
      await this.store.deleteSession(session.id);
      throw new AppError('UNAUTHENTICATED', 'Session expired.');
    }
    const user = await this.store.getUser(session.userId);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Invalid session.');
    const { passwordHash: _omit, ...safe } = user;
    return safe;
  }

  async logout(token: string): Promise<void> {
    const s = await this.store.getSessionByTokenHash(sha256Hex(token));
    if (s) await this.store.deleteSession(s.id);
  }

  // ------------------------------------------------------------------ organizations & members
  private async createOrgInternal(userId: string, name: string): Promise<Org> {
    let slug = slugify(name);
    if (await this.store.findOrgBySlug(slug)) slug = `${slug}-${randomUUID().slice(0, 6)}`;
    const org = await this.store.createOrg({ id: randomUUID(), name, slug, plan: 'FREE', createdAt: this.now() });
    await this.store.addMember({ orgId: org.id, userId, role: 'OWNER', createdAt: this.now() });
    await this.audit(org.id, userId, 'org.created', 'org', org.id);
    return org;
  }

  async createOrg(actor: Actor, name: string): Promise<Org> {
    return this.createOrgInternal(actor.userId, str(name, 'name', 2, 80));
  }

  async listMyOrgs(actor: Actor) {
    return (await this.store.listMembershipsForUser(actor.userId)).map((m) => ({ id: m.org.id, name: m.org.name, slug: m.org.slug, plan: m.org.plan, role: m.role }));
  }

  async listMembers(actor: Actor, orgId: string) {
    await this.requireAccess(orgId, actor, 'members:read');
    return (await this.store.listMembers(orgId)).map((m) => ({ userId: m.userId, email: m.email, name: m.name, role: m.role }));
  }

  /** Direct add of an existing user. (Email invitations need a mail provider and are out of scope.) */
  async addMember(actor: Actor, orgId: string, email: string, role: Role) {
    const { org, membership } = await this.requireAccess(orgId, actor, 'members:manage');
    if (role === 'OWNER' && membership.role !== 'OWNER') throw new AppError('FORBIDDEN', 'Only owners can add owners.');
    const user = await this.store.findUserByEmail(validateEmail(email) ?? '');
    if (!user) throw notFound('User (they must sign up first)');
    if (await this.store.getMembership(orgId, user.id)) throw new AppError('CONFLICT', 'User is already a member.');
    assertWithinLimit(org.plan, 'members', (await this.store.listMembers(orgId)).length);
    await this.store.addMember({ orgId, userId: user.id, role, createdAt: this.now() });
    await this.audit(orgId, actor.userId, 'member.added', 'user', user.id, { role });
  }

  async changeMemberRole(actor: Actor, orgId: string, userId: string, role: Role) {
    const { membership } = await this.requireAccess(orgId, actor, 'members:manage');
    const target = await this.store.getMembership(orgId, userId);
    if (!target) throw notFound('Member');
    if ((target.role === 'OWNER' || role === 'OWNER') && membership.role !== 'OWNER') throw new AppError('FORBIDDEN', 'Only owners can change owner roles.');
    if (target.role === 'OWNER' && role !== 'OWNER') await this.assertNotLastOwner(orgId);
    await this.store.setMemberRole(orgId, userId, role);
    await this.audit(orgId, actor.userId, 'member.role_changed', 'user', userId, { from: target.role, to: role });
  }

  async removeMember(actor: Actor, orgId: string, userId: string) {
    const self = userId === actor.userId;
    const { membership } = await this.requireAccess(orgId, actor, self ? 'org:read' : 'members:manage');
    const target = await this.store.getMembership(orgId, userId);
    if (!target) throw notFound('Member');
    if (!self && ROLE_RANK[target.role] > ROLE_RANK[membership.role]) throw new AppError('FORBIDDEN', 'You cannot remove a member with a higher role.');
    if (target.role === 'OWNER') await this.assertNotLastOwner(orgId);
    await this.store.removeMember(orgId, userId);
    await this.audit(orgId, actor.userId, 'member.removed', 'user', userId);
  }

  private async assertNotLastOwner(orgId: string) {
    const owners = (await this.store.listMembers(orgId)).filter((m) => m.role === 'OWNER');
    if (owners.length <= 1) throw new AppError('CONFLICT', 'An organization must keep at least one owner.');
  }

  // ------------------------------------------------------------------ projects
  async createProject(actor: Actor, orgId: string, input: { name: string; description?: string }): Promise<Project> {
    const { org } = await this.requireAccess(orgId, actor, 'project:create');
    const name = str(input.name, 'name', 2, 80);
    const description = input.description === undefined ? undefined : str(input.description, 'description', 0, 500);
    const existing = await this.store.listProjects(orgId);
    assertWithinLimit(org.plan, 'projects', existing.length);
    let slug = slugify(name);
    if (existing.some((p) => p.slug === slug)) throw new AppError('CONFLICT', 'A project with this name already exists.');
    const project = await this.store.createProject({ id: randomUUID(), orgId, name, slug, description, createdAt: this.now() });
    for (const env of ['production', 'staging']) await this.store.createEnvironment({ id: randomUUID(), orgId, projectId: project.id, name: env, createdAt: this.now() });
    await this.audit(orgId, actor.userId, 'project.created', 'project', project.id, { name });
    return project;
  }

  async listProjects(actor: Actor, orgId: string) { await this.requireAccess(orgId, actor, 'project:read'); return this.store.listProjects(orgId); }

  async getProject(actor: Actor, orgId: string, projectId: string) {
    await this.requireAccess(orgId, actor, 'project:read');
    const p = await this.store.getProject(orgId, projectId);
    if (!p) throw notFound('Project');
    return { ...p, environments: await this.store.listEnvironments(orgId, projectId) };
  }

  async deleteProject(actor: Actor, orgId: string, projectId: string) {
    await this.requireAccess(orgId, actor, 'project:delete');
    if (!(await this.store.getProject(orgId, projectId))) throw notFound('Project');
    await this.store.deleteProject(orgId, projectId);
    await this.audit(orgId, actor.userId, 'project.deleted', 'project', projectId);
  }

  async createEnvironment(actor: Actor, orgId: string, projectId: string, name: string): Promise<Environment> {
    await this.requireAccess(orgId, actor, 'project:create');
    if (!(await this.store.getProject(orgId, projectId))) throw notFound('Project');
    const n = str(name, 'name', 2, 40).toLowerCase();
    if ((await this.store.listEnvironments(orgId, projectId)).some((e) => e.name === n)) throw new AppError('CONFLICT', 'Environment already exists.');
    return this.store.createEnvironment({ id: randomUUID(), orgId, projectId, name: n, createdAt: this.now() });
  }

  // ------------------------------------------------------------------ spec registry (immutable)
  async uploadSpec(actor: Actor, orgId: string, projectId: string, input: { content: string; label?: string; environmentId?: string; source?: SpecVersion['source'] }): Promise<{ version: Omit<SpecVersion, 'content'>; duplicate: boolean; warnings: string[] }> {
    const { org } = await this.requireAccess(orgId, actor, 'spec:upload');
    if (!(await this.store.getProject(orgId, projectId))) throw notFound('Project');
    if (typeof input.content !== 'string') throw new AppError('VALIDATION', '"content" must be the specification text.');
    const maxBytes = PLAN_LIMITS[org.plan].maxSpecBytes;
    if (Buffer.byteLength(input.content, 'utf8') > maxBytes) throw new AppError('VALIDATION', `Specification exceeds the ${maxBytes} byte limit for your plan.`);
    if (input.environmentId && !(await this.store.listEnvironments(orgId, projectId)).some((e) => e.id === input.environmentId)) throw notFound('Environment');

    const parsed = parseOpenApi(input.content, { maxBytes });
    if (!parsed.ok || !parsed.ir) throw new AppError('INVALID_SPEC', 'The specification is not valid or not supported.', parsed.issues.filter((i) => i.severity === 'error'));
    const warnings = parsed.issues.filter((i) => i.severity === 'warning').map((i) => `${i.code}: ${i.message}`);

    const strip = ({ content: _c, ...rest }: SpecVersion) => rest;
    const dup = await this.store.findSpecByChecksum(orgId, projectId, parsed.checksum);
    if (dup) return { version: strip(dup), duplicate: true, warnings };

    assertWithinLimit(org.plan, 'versionsPerMonth', await this.store.countSpecVersionsSince(orgId, startOfMonthUtc(this.now())));
    const existing = await this.store.listSpecVersions(orgId, projectId);
    const number = (existing[0]?.number ?? 0) + 1;
    const label = input.label === undefined ? `v${number}` : str(input.label, 'label', 1, 60);
    const version = await this.store.createSpecVersion({
      id: randomUUID(), orgId, projectId, environmentId: input.environmentId, number, label,
      checksum: parsed.checksum, sizeBytes: parsed.sizeBytes, title: parsed.ir.info.title, apiVersion: parsed.ir.info.version, openapi: parsed.ir.openapi,
      content: input.content, source: input.source ?? 'upload', createdBy: actor.userId, createdAt: this.now(),
    });
    await this.audit(orgId, actor.userId, 'spec.uploaded', 'spec_version', version.id, { projectId, number, checksum: version.checksum });
    return { version: strip(version), duplicate: false, warnings };
  }

  async listVersions(actor: Actor, orgId: string, projectId: string) {
    await this.requireAccess(orgId, actor, 'spec:read');
    if (!(await this.store.getProject(orgId, projectId))) throw notFound('Project');
    return (await this.store.listSpecVersions(orgId, projectId)).map(({ content: _c, ...v }) => v);
  }

  async getVersionContent(actor: Actor, orgId: string, versionId: string) {
    await this.requireAccess(orgId, actor, 'spec:read');
    const v = await this.store.getSpecVersion(orgId, versionId);
    if (!v) throw notFound('Version');
    return v;
  }

  // ------------------------------------------------------------------ policies
  private sanitizePolicy(input: unknown, actor: { email: string }): Policy {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new AppError('VALIDATION', 'Policy must be an object.');
    const p = input as Record<string, any>;
    const profile = (p.profile ?? 'standard') as Profile;
    if (!PROFILES.includes(profile)) throw new AppError('VALIDATION', `profile must be one of ${PROFILES.join(', ')}.`);
    const failOn = (p.failOn ?? ['BREAKING']) as Category[];
    if (!Array.isArray(failOn) || failOn.some((c) => !CATEGORIES.includes(c))) throw new AppError('VALIDATION', 'failOn contains an unknown category.');
    if (p.severityThreshold !== undefined && !SEVERITIES.includes(p.severityThreshold)) throw new AppError('VALIDATION', 'Unknown severityThreshold.');
    const ruleOverrides: NonNullable<Policy['ruleOverrides']> = {};
    for (const [id, ov] of Object.entries(p.ruleOverrides ?? {}) as Array<[string, any]>) {
      if (!RULES[id]) throw new AppError('VALIDATION', `Unknown rule "${id}".`);
      if (ov?.category !== undefined && !CATEGORIES.includes(ov.category)) throw new AppError('VALIDATION', `Invalid category override for ${id}.`);
      if (ov?.severity !== undefined && !SEVERITIES.includes(ov.severity)) throw new AppError('VALIDATION', `Invalid severity override for ${id}.`);
      ruleOverrides[id] = { category: ov?.category, severity: ov?.severity, fails: typeof ov?.fails === 'boolean' ? ov.fails : undefined };
    }
    const suppressions = (Array.isArray(p.suppressions) ? p.suppressions : []).map((s: any) => {
      if (!s?.ruleId && !s?.findingId && !s?.operationPrefix) throw new AppError('VALIDATION', 'Each suppression needs ruleId, findingId or operationPrefix.');
      if (s.ruleId && !RULES[s.ruleId]) throw new AppError('VALIDATION', `Unknown rule "${s.ruleId}" in suppression.`);
      if (s.expiresAt !== undefined && Number.isNaN(Date.parse(s.expiresAt))) throw new AppError('VALIDATION', 'Invalid suppression expiresAt.');
      return {
        ruleId: s.ruleId, findingId: s.findingId, operationPrefix: s.operationPrefix,
        reason: str(s.reason, 'suppression reason', 3, 500), author: actor.email, expiresAt: s.expiresAt,
      };
    });
    return { profile, failOn, failOnWarnings: !!p.failOnWarnings, severityThreshold: p.severityThreshold, ruleOverrides, suppressions };
  }

  /** Policies are versioned: saving never edits history, it appends a new version under the same name. */
  async savePolicy(actor: Actor, orgId: string, input: { name: string; projectId?: string; policy: unknown }): Promise<PolicyRecord> {
    await this.requireAccess(orgId, actor, 'policy:write');
    const user = await this.store.getUser(actor.userId);
    if (input.projectId && !(await this.store.getProject(orgId, input.projectId))) throw notFound('Project');
    const name = str(input.name, 'name', 2, 80);
    const policy = this.sanitizePolicy(input.policy, { email: user!.email });
    const prior = (await this.store.listPolicies(orgId, input.projectId)).filter((p) => p.name === name);
    const rec = await this.store.createPolicy({ id: randomUUID(), orgId, projectId: input.projectId, name, version: (prior[0]?.version ?? 0) + 1, policy, createdBy: actor.userId, createdAt: this.now() });
    await this.audit(orgId, actor.userId, 'policy.saved', 'policy', rec.id, { name, version: rec.version });
    return rec;
  }

  async listPolicies(actor: Actor, orgId: string, projectId?: string) { await this.requireAccess(orgId, actor, 'policy:read'); return this.store.listPolicies(orgId, projectId); }

  // ------------------------------------------------------------------ comparisons
  private async createComparisonRecord(actor: Actor, orgId: string, input: { baseVersionId: string; targetVersionId: string; policyId?: string }): Promise<ComparisonRecord> {
    const { org } = await this.requireAccess(orgId, actor, 'comparison:run');
    if (input.baseVersionId === input.targetVersionId) throw new AppError('VALIDATION', 'Choose two different versions.');
    const base = await this.store.getSpecVersion(orgId, input.baseVersionId);
    const target = await this.store.getSpecVersion(orgId, input.targetVersionId);
    if (!base || !target) throw notFound('Version');
    if (base.projectId !== target.projectId) throw new AppError('VALIDATION', 'Both versions must belong to the same project.');
    if (input.policyId && !(await this.store.getPolicy(orgId, input.policyId))) throw notFound('Policy');
    assertWithinLimit(org.plan, 'comparisonsPerMonth', await this.store.countComparisonsSince(orgId, startOfMonthUtc(this.now())));
    const c = await this.store.createComparison({
      id: randomUUID(), orgId, projectId: base.projectId, baseVersionId: base.id, targetVersionId: target.id, policyId: input.policyId,
      status: 'QUEUED', requestedBy: actor.userId, createdAt: this.now(),
    });
    await this.audit(orgId, actor.userId, 'comparison.requested', 'comparison', c.id);
    return c;
  }

  async requestComparison(actor: Actor, orgId: string, input: { baseVersionId: string; targetVersionId: string; policyId?: string }): Promise<ComparisonRecord> {
    const c = await this.createComparisonRecord(actor, orgId, input);
    try {
      await this.queue.enqueueComparison({ comparisonId: c.id, orgId });
    } catch {
      await this.store.updateComparison(c.id, { status: 'FAILED', error: 'Could not enqueue the job.', completedAt: this.now() });
      throw new AppError('INTERNAL', 'The analysis queue is unavailable. Please retry.');
    }
    return c;
  }

  /** Worker entry point. Idempotent: re-delivery of a finished job is a no-op. */
  async processComparison(comparisonId: string): Promise<ComparisonRecord> {
    const c = await this.store.getComparisonUnscoped(comparisonId);
    if (!c) throw notFound('Comparison');
    if (c.status === 'COMPLETED') return c;
    await this.store.updateComparison(c.id, { status: 'RUNNING', startedAt: this.now(), error: undefined });
    try {
      const [baseV, targetV] = await Promise.all([this.store.getSpecVersion(c.orgId, c.baseVersionId), this.store.getSpecVersion(c.orgId, c.targetVersionId)]);
      if (!baseV || !targetV) throw new Error('A compared version no longer exists.');
      const base = parseOpenApi(baseV.content), target = parseOpenApi(targetV.content);
      if (!base.ok || !base.ir || !target.ok || !target.ir) throw new Error('Stored specification could not be re-parsed.');

      const rec = c.policyId ? await this.store.getPolicy(c.orgId, c.policyId) : (await this.store.listPolicies(c.orgId, c.projectId))[0];
      const policy: Policy = rec?.policy ?? DEFAULT_POLICY;
      const result = compare(base.ir, target.ir, { policy, now: this.now() });

      const rows: FindingRecord[] = result.findings.map((f) => ({
        ...f, comparisonId: c.id, orgId: c.orgId,
        baseLine: f.basePointer ? base.locate(f.basePointer) : undefined, targetLine: f.targetPointer ? target.locate(f.targetPointer) : undefined,
      }));
      await this.store.replaceFindings(c.id, c.orgId, rows);
      const { findings: _f, ...report } = result;
      await this.store.updateComparison(c.id, { status: 'COMPLETED', result: result.result, summary: result.summary, report, engineVersion: result.engineVersion, completedAt: this.now() });
      await this.notify(c.orgId, c.requestedBy, 'comparison.completed', `Comparison ${result.result}`, `${result.summary.total} findings (${result.summary.byCategory.BREAKING} breaking).`, `/comparisons/${c.id}`);
      await this.audit(c.orgId, undefined, 'comparison.completed', 'comparison', c.id, { result: result.result });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      await this.store.updateComparison(c.id, { status: 'FAILED', error: message.slice(0, 500), completedAt: this.now() });
      await this.notify(c.orgId, c.requestedBy, 'comparison.failed', 'Comparison failed', message.slice(0, 200), `/comparisons/${c.id}`);
    }
    return (await this.store.getComparisonUnscoped(c.id))!;
  }

  private async notify(orgId: string, userId: string, kind: string, title: string, body: string, link?: string) {
    await this.store.createNotification({ id: randomUUID(), orgId, userId, kind, title, body, link, createdAt: this.now() });
  }

  async getComparison(actor: Actor, orgId: string, id: string) {
    await this.requireAccess(orgId, actor, 'comparison:read');
    const c = await this.store.getComparison(orgId, id);
    if (!c) throw notFound('Comparison');
    return c;
  }

  async listComparisons(actor: Actor, orgId: string, projectId?: string) {
    await this.requireAccess(orgId, actor, 'comparison:read');
    return this.store.listComparisons(orgId, { projectId, limit: 100 });
  }

  async listFindings(actor: Actor, orgId: string, comparisonId: string, f: { category?: Category; severity?: Severity; outcome?: string; q?: string; limit?: number; offset?: number } = {}) {
    await this.requireAccess(orgId, actor, 'comparison:read');
    if (!(await this.store.getComparison(orgId, comparisonId))) throw notFound('Comparison');
    const q = f.q?.toLowerCase();
    const all = (await this.store.listFindings(orgId, comparisonId)).filter((x) =>
      (!f.category || x.category === f.category) && (!f.severity || x.severity === f.severity) && (!f.outcome || x.policyOutcome === f.outcome)
      && (!q || `${x.ruleId} ${x.title} ${x.summary} ${x.method ?? ''} ${x.path ?? ''} ${x.schemaPath}`.toLowerCase().includes(q)));
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200), offset = Math.max(f.offset ?? 0, 0);
    return { total: all.length, items: all.slice(offset, offset + limit) };
  }

  async getFinding(actor: Actor, orgId: string, comparisonId: string, findingId: string): Promise<FindingRecord> {
    await this.requireAccess(orgId, actor, 'comparison:read');
    const f = (await this.store.listFindings(orgId, comparisonId)).find((x) => x.id === findingId);
    if (!f) throw notFound('Finding');
    return f;
  }

  async explain(actor: Actor, orgId: string, comparisonId: string, findingId: string, llm?: LlmClient): Promise<Explanation> {
    await this.requireAccess(orgId, actor, 'ai:explain');
    const f = await this.getFinding(actor, orgId, comparisonId, findingId);
    const out = await explainFinding(f, llm);
    await this.audit(orgId, actor.userId, 'ai.explained', 'finding', findingId, { source: out.source, rejected: out.rejectedReason });
    return out;
  }

  // ------------------------------------------------------------------ reports
  async exportReport(actor: Actor, orgId: string, comparisonId: string, format: 'json' | 'csv' | 'html'): Promise<{ filename: string; contentType: string; body: string }> {
    await this.requireAccess(orgId, actor, 'report:export');
    const c = await this.store.getComparison(orgId, comparisonId);
    if (!c) throw notFound('Comparison');
    if (c.status !== 'COMPLETED' || !c.report) throw new AppError('CONFLICT', 'The comparison has not completed yet.');
    const findings: Finding[] = (await this.store.listFindings(orgId, comparisonId)).map(({ comparisonId: _c, orgId: _o, baseLine: _b, targetLine: _t, ...f }) => f);
    const full: ComparisonResult = { ...c.report, findings };
    await this.audit(orgId, actor.userId, 'report.exported', 'comparison', comparisonId, { format });
    const base = `contractguard-${comparisonId}`;
    if (format === 'json') return { filename: `${base}.json`, contentType: 'application/json; charset=utf-8', body: renderJson(full) };
    if (format === 'csv') return { filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8', body: renderCsv(full) };
    if (format === 'html') return { filename: `${base}.html`, contentType: 'text/html; charset=utf-8', body: renderHtmlReport(full) };
    throw new AppError('VALIDATION', 'format must be json, csv or html.');
  }

  // ------------------------------------------------------------------ GitHub integration
  async linkGithubRepo(actor: Actor, orgId: string, input: { projectId: string; installationId: number; repo: string; specPath: string }) {
    await this.requireAccess(orgId, actor, 'integration:manage');
    if (!(await this.store.getProject(orgId, input.projectId))) throw notFound('Project');
    if (!Number.isInteger(input.installationId) || input.installationId <= 0) throw new AppError('VALIDATION', 'installationId must be a positive integer.');
    const repo = str(input.repo, 'repo', 3, 140);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new AppError('VALIDATION', 'repo must look like "owner/name".');
    const specPath = str(input.specPath, 'specPath', 1, 200);
    if (specPath.startsWith('/') || specPath.split('/').includes('..') || /[\u0000-\u001f\\]/.test(specPath)) throw new AppError('VALIDATION', 'specPath must be a relative path inside the repository.');
    if (await this.store.findGithubLink(input.installationId, repo)) throw new AppError('CONFLICT', 'This repository is already linked.');
    const link = await this.store.createGithubLink({ id: randomUUID(), orgId, projectId: input.projectId, installationId: input.installationId, repo, specPath, createdBy: actor.userId, createdAt: this.now() });
    await this.audit(orgId, actor.userId, 'github.linked', 'github_link', link.id, { repo });
    return link;
  }
  async listGithubLinks(actor: Actor, orgId: string) { await this.requireAccess(orgId, actor, 'integration:manage'); return this.store.listGithubLinks(orgId); }
  async unlinkGithubRepo(actor: Actor, orgId: string, id: string) {
    await this.requireAccess(orgId, actor, 'integration:manage');
    await this.store.deleteGithubLink(orgId, id);
    await this.audit(orgId, actor.userId, 'github.unlinked', 'github_link', id);
  }

  /**
   * Worker-side handling of a verified pull_request webhook: fetch base and head specs, register them as immutable versions,
   * compare, and publish a check run. The linking user's current permissions are re-checked, so revoked access stops checks.
   */
  async runPullRequestCheck(ev: PullRequestEvent, gh: GithubGateway, opts: { webBaseUrl?: string } = {}): Promise<{ status: 'skipped' | 'completed' | 'failed'; reason?: string; comparisonId?: string }> {
    const link = await this.store.findGithubLink(ev.installationId, `${ev.owner}/${ev.repo}`);
    if (!link) return { status: 'skipped', reason: 'Repository is not linked to a ContractGuard project.' };
    const actor = { userId: link.createdBy };
    const fail = async (reason: string) => {
      await gh.createCheckRun({ installationId: ev.installationId, owner: ev.owner, repo: ev.repo, headSha: ev.headSha, name: 'ContractGuard',
        output: { conclusion: 'neutral', title: 'ContractGuard could not analyze this change', summary: reason.slice(0, 1000), annotations: [] } });
      return { status: 'failed' as const, reason };
    };
    try {
      const where = { installationId: ev.installationId, owner: ev.owner, repo: ev.repo, path: link.specPath };
      const [baseText, headText] = await Promise.all([gh.getFile({ ...where, ref: ev.baseRef }), gh.getFile({ ...where, ref: ev.headSha })]);
      if (!headText) return fail(`The specification file "${link.specPath}" was not found in this pull request.`);
      if (!baseText) return { status: 'skipped', reason: 'No specification on the base branch yet; nothing to compare against.' };
      const base = await this.uploadSpec(actor, link.orgId, link.projectId, { content: baseText, label: `${ev.baseRef}`, source: 'github' });
      const head = await this.uploadSpec(actor, link.orgId, link.projectId, { content: headText, label: `PR #${ev.number} ${ev.headSha.slice(0, 7)}`, source: 'github' });
      if (base.version.id === head.version.id) {
        await gh.createCheckRun({ installationId: ev.installationId, owner: ev.owner, repo: ev.repo, headSha: ev.headSha, name: 'ContractGuard',
          output: { conclusion: 'success', title: 'API specification unchanged', summary: 'The specification is identical to the base branch.', annotations: [] } });
        return { status: 'completed' };
      }
      const created = await this.createComparisonRecord(actor, link.orgId, { baseVersionId: base.version.id, targetVersionId: head.version.id });
      const done = await this.processComparison(created.id);
      if (done.status !== 'COMPLETED' || !done.report) return fail(done.error ?? 'Analysis failed.');
      const rows = await this.store.listFindings(link.orgId, done.id);
      const lines = new Map(rows.map((r) => [r.id, r.targetLine]));
      const output = buildCheckRun({ ...done.report, findings: rows }, { specPath: link.specPath, lineOf: (f) => lines.get(f.id), detailsUrl: opts.webBaseUrl ? `${opts.webBaseUrl}/comparisons/${done.id}` : undefined });
      await gh.createCheckRun({ installationId: ev.installationId, owner: ev.owner, repo: ev.repo, headSha: ev.headSha, name: 'ContractGuard', output });
      return { status: 'completed', comparisonId: done.id };
    } catch (e) {
      return fail(e instanceof AppError ? e.message : 'Unexpected error while analyzing this pull request.');
    }
  }

  // ------------------------------------------------------------------ dashboard, notifications, audit
  async getDashboard(actor: Actor, orgId: string) {
    const { org } = await this.requireAccess(orgId, actor, 'org:read');
    const [projects, members, comparisons] = await Promise.all([this.store.listProjects(orgId), this.store.listMembers(orgId), this.store.listComparisons(orgId, { limit: 1000 })]);
    const monthStart = startOfMonthUtc(this.now());
    const since30 = new Date(this.now().getTime() - 30 * 24 * 3600 * 1000);
    const recent = comparisons.filter((c) => c.createdAt >= since30);
    const byResult = { PASS: 0, FAIL: 0, NEEDS_REVIEW: 0, pending: 0, failed: 0 };
    for (const c of recent) {
      if (c.status === 'COMPLETED' && c.result) byResult[c.result]++;
      else if (c.status === 'FAILED') byResult.failed++;
      else byResult.pending++;
    }
    const latestByProject = new Map<string, ComparisonRecord>();
    for (const c of comparisons) if (c.status === 'COMPLETED' && !latestByProject.has(c.projectId)) latestByProject.set(c.projectId, c);
    let openBreaking = 0;
    for (const c of latestByProject.values()) openBreaking += (await this.store.listFindings(orgId, c.id)).filter((f) => f.category === 'BREAKING' && f.policyOutcome !== 'SUPPRESSED').length;
    const names = new Map(projects.map((p) => [p.id, p.name]));
    return {
      org: { id: org.id, name: org.name, plan: org.plan },
      totals: { projects: projects.length, members: members.length, comparisons: comparisons.length },
      last30Days: { comparisons: recent.length, ...byResult },
      openBreakingFindings: openBreaking,
      recentComparisons: comparisons.slice(0, 8).map((c) => ({ id: c.id, projectId: c.projectId, projectName: names.get(c.projectId) ?? 'Deleted project', status: c.status, result: c.result, createdAt: c.createdAt })),
      usage: {
        plan: org.plan, limits: PLAN_LIMITS[org.plan],
        used: { projects: projects.length, members: members.length, versionsThisMonth: await this.store.countSpecVersionsSince(orgId, monthStart), comparisonsThisMonth: await this.store.countComparisonsSince(orgId, monthStart) },
      },
    };
  }

  async listNotifications(actor: Actor, orgId: string) { await this.requireAccess(orgId, actor, 'org:read'); return this.store.listNotifications(orgId, actor.userId, 50); }
  async markNotificationRead(actor: Actor, orgId: string, id: string) {
    await this.requireAccess(orgId, actor, 'org:read');
    if (!(await this.store.markNotificationRead(orgId, actor.userId, id, this.now()))) throw notFound('Notification');
  }
  async listAudit(actor: Actor, orgId: string, limit = 100) { await this.requireAccess(orgId, actor, 'audit:read'); return this.store.listAudit(orgId, Math.min(limit, 500)); }

  /** Billing-ready: plan changes come from a billing webhook adapter, never from user input. */
  async setPlanFromBilling(orgId: string, plan: 'FREE' | 'PRO' | 'ENTERPRISE') {
    await this.store.setOrgPlan(orgId, plan);
    await this.audit(orgId, undefined, 'billing.plan_changed', 'org', orgId, { plan });
  }

  can = can;
}
