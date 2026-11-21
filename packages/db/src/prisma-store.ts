// UNVERIFIED: depends on the generated Prisma client, which could not be generated in the authoring environment.
import { PrismaClient } from '@prisma/client';
import type { Store } from '@contractguard/domain';

/** Prisma returns `null` for empty columns; the domain model uses `undefined`. */
function un<T extends object>(row: T | null | undefined): any {
  if (!row) return undefined;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null ? undefined : v]));
}
const many = (rows: object[]) => rows.map(un);

export class PrismaStore implements Store {
  constructor(private db: PrismaClient) {}

  createUser = async (u: any) => un(await this.db.user.create({ data: u }));
  findUserByEmail = async (email: string) => un(await this.db.user.findUnique({ where: { email } }));
  getUser = async (id: string) => un(await this.db.user.findUnique({ where: { id } }));

  createOrg = async (o: any) => un(await this.db.org.create({ data: o }));
  getOrg = async (id: string) => un(await this.db.org.findUnique({ where: { id } }));
  findOrgBySlug = async (slug: string) => un(await this.db.org.findUnique({ where: { slug } }));
  setOrgPlan = async (id: string, plan: any) => { await this.db.org.update({ where: { id }, data: { plan } }); };

  addMember = async (m: any) => { await this.db.membership.create({ data: m }); };
  getMembership = async (orgId: string, userId: string) => un(await this.db.membership.findUnique({ where: { orgId_userId: { orgId, userId } } }));
  listMembers = async (orgId: string) =>
    (await this.db.membership.findMany({ where: { orgId }, include: { user: true }, orderBy: { createdAt: 'asc' } }))
      .map((m) => ({ orgId: m.orgId, userId: m.userId, role: m.role, createdAt: m.createdAt, email: m.user.email, name: m.user.name })) as any;
  listMembershipsForUser = async (userId: string) =>
    (await this.db.membership.findMany({ where: { userId }, include: { org: true } })).map((m) => ({ orgId: m.orgId, userId: m.userId, role: m.role, createdAt: m.createdAt, org: m.org })) as any;
  setMemberRole = async (orgId: string, userId: string, role: any) => { await this.db.membership.update({ where: { orgId_userId: { orgId, userId } }, data: { role } }); };
  removeMember = async (orgId: string, userId: string) => { await this.db.membership.deleteMany({ where: { orgId, userId } }); };

  createSession = async (s: any) => { await this.db.session.create({ data: s }); };
  getSessionByTokenHash = async (tokenHash: string) => un(await this.db.session.findUnique({ where: { tokenHash } }));
  deleteSession = async (id: string) => { await this.db.session.deleteMany({ where: { id } }); };
  recordLoginFailure = async (key: string, at: Date) => { await this.db.loginFailure.create({ data: { key, at } }); };
  countLoginFailures = async (key: string, since: Date) => this.db.loginFailure.count({ where: { key, at: { gte: since } } });
  clearLoginFailures = async (key: string) => { await this.db.loginFailure.deleteMany({ where: { key } }); };

  createProject = async (p: any) => un(await this.db.project.create({ data: p }));
  getProject = async (orgId: string, id: string) => un(await this.db.project.findFirst({ where: { id, orgId } }));
  listProjects = async (orgId: string) => many(await this.db.project.findMany({ where: { orgId }, orderBy: { name: 'asc' } }));
  deleteProject = async (orgId: string, id: string) => {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('contractguard.allow_version_delete', 'on', true)`;
      await tx.comparison.deleteMany({ where: { orgId, projectId: id } });
      await tx.project.deleteMany({ where: { id, orgId } });
    });
  };
  createEnvironment = async (e: any) => un(await this.db.environment.create({ data: e }));
  listEnvironments = async (orgId: string, projectId: string) => many(await this.db.environment.findMany({ where: { orgId, projectId } }));

  createSpecVersion = async (v: any) => un(await this.db.specVersion.create({ data: v }));
  getSpecVersion = async (orgId: string, id: string) => un(await this.db.specVersion.findFirst({ where: { id, orgId } }));
  listSpecVersions = async (orgId: string, projectId: string) => many(await this.db.specVersion.findMany({ where: { orgId, projectId }, orderBy: { number: 'desc' } }));
  findSpecByChecksum = async (orgId: string, projectId: string, checksum: string) => un(await this.db.specVersion.findFirst({ where: { orgId, projectId, checksum } }));
  countSpecVersionsSince = async (orgId: string, since: Date) => this.db.specVersion.count({ where: { orgId, createdAt: { gte: since } } });

  createPolicy = async (p: any) => un(await this.db.policy.create({ data: p }));
  getPolicy = async (orgId: string, id: string) => un(await this.db.policy.findFirst({ where: { id, orgId } }));
  listPolicies = async (orgId: string, projectId?: string) =>
    many(await this.db.policy.findMany({ where: { orgId, ...(projectId === undefined ? {} : { projectId }) }, orderBy: [{ createdAt: 'desc' }, { version: 'desc' }] }));

  createComparison = async (c: any) => un(await this.db.comparison.create({ data: c }));
  getComparison = async (orgId: string, id: string) => un(await this.db.comparison.findFirst({ where: { id, orgId } }));
  getComparisonUnscoped = async (id: string) => un(await this.db.comparison.findUnique({ where: { id } }));
  updateComparison = async (id: string, patch: any) => {
    const data: any = { ...patch };
    if ('error' in patch && patch.error === undefined) data.error = null;
    await this.db.comparison.update({ where: { id }, data });
  };
  listComparisons = async (orgId: string, opts: { projectId?: string; limit?: number } = {}) =>
    many(await this.db.comparison.findMany({ where: { orgId, ...(opts.projectId ? { projectId: opts.projectId } : {}) }, orderBy: { createdAt: 'desc' }, take: opts.limit ?? 50 }));
  countComparisonsSince = async (orgId: string, since: Date) => this.db.comparison.count({ where: { orgId, createdAt: { gte: since } } });

  replaceFindings = async (comparisonId: string, orgId: string, findings: any[]) => {
    await this.db.$transaction([
      this.db.finding.deleteMany({ where: { comparisonId } }),
      this.db.finding.createMany({
        data: findings.map((f) => ({
          comparisonId, orgId, findingKey: f.id, ruleId: f.ruleId, category: f.category, severity: f.severity, outcome: f.policyOutcome,
          method: f.method ?? null, path: f.path ?? null, data: JSON.parse(JSON.stringify(f)),
        })),
      }),
    ]);
  };
  listFindings = async (orgId: string, comparisonId: string) =>
    (await this.db.finding.findMany({ where: { orgId, comparisonId }, orderBy: { id: 'asc' } })).map((r) => r.data as any);

  appendAudit = async (e: any) => { await this.db.auditLog.create({ data: { ...e, metadata: e.metadata ?? undefined } }); };
  listAudit = async (orgId: string, limit: number) => many(await this.db.auditLog.findMany({ where: { orgId }, orderBy: { at: 'desc' }, take: limit }));

  createGithubLink = async (l: any) => un(await this.db.githubLink.create({ data: l }));
  findGithubLink = async (installationId: number, repo: string) => un(await this.db.githubLink.findFirst({ where: { installationId, repo: { equals: repo, mode: 'insensitive' } } }));
  listGithubLinks = async (orgId: string) => many(await this.db.githubLink.findMany({ where: { orgId } }));
  deleteGithubLink = async (orgId: string, id: string) => { await this.db.githubLink.deleteMany({ where: { orgId, id } }); };

  createNotification = async (n: any) => { await this.db.notification.create({ data: n }); };
  listNotifications = async (orgId: string, userId: string, limit: number) => many(await this.db.notification.findMany({ where: { orgId, userId }, orderBy: { createdAt: 'desc' }, take: limit }));
  markNotificationRead = async (orgId: string, userId: string, id: string, at: Date) => (await this.db.notification.updateMany({ where: { id, orgId, userId }, data: { readAt: at } })).count > 0;
}
