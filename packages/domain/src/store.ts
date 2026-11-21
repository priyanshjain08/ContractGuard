import type {
  AuditEntry, ComparisonRecord, Environment, FindingRecord, GithubLink, Membership, Notification, Org, Plan, PolicyRecord,
  Project, Role, Session, SpecVersion, User,
} from './types.ts';

/**
 * Persistence port. Rules enforced by the contract (and by the test-suite against InMemoryStore):
 *  - every tenant-owned read takes `orgId`, so an ID from another tenant resolves to `undefined`;
 *  - spec versions are append-only: there is intentionally no update/delete method for them.
 * The Prisma adapter in apps/api implements this same interface.
 */
export interface Store {
  createUser(u: User): Promise<User>;
  findUserByEmail(email: string): Promise<User | undefined>;
  getUser(id: string): Promise<User | undefined>;

  createOrg(o: Org): Promise<Org>;
  getOrg(id: string): Promise<Org | undefined>;
  findOrgBySlug(slug: string): Promise<Org | undefined>;
  setOrgPlan(id: string, plan: Plan): Promise<void>;

  addMember(m: Membership): Promise<void>;
  getMembership(orgId: string, userId: string): Promise<Membership | undefined>;
  listMembers(orgId: string): Promise<Array<Membership & { email: string; name: string }>>;
  listMembershipsForUser(userId: string): Promise<Array<Membership & { org: Org }>>;
  setMemberRole(orgId: string, userId: string, role: Role): Promise<void>;
  removeMember(orgId: string, userId: string): Promise<void>;

  createSession(s: Session): Promise<void>;
  getSessionByTokenHash(hash: string): Promise<Session | undefined>;
  deleteSession(id: string): Promise<void>;
  recordLoginFailure(key: string, at: Date): Promise<void>;
  countLoginFailures(key: string, since: Date): Promise<number>;
  clearLoginFailures(key: string): Promise<void>;

  createProject(p: Project): Promise<Project>;
  getProject(orgId: string, id: string): Promise<Project | undefined>;
  listProjects(orgId: string): Promise<Project[]>;
  deleteProject(orgId: string, id: string): Promise<void>;
  createEnvironment(e: Environment): Promise<Environment>;
  listEnvironments(orgId: string, projectId: string): Promise<Environment[]>;

  createSpecVersion(v: SpecVersion): Promise<SpecVersion>;
  getSpecVersion(orgId: string, id: string): Promise<SpecVersion | undefined>;
  listSpecVersions(orgId: string, projectId: string): Promise<SpecVersion[]>;
  findSpecByChecksum(orgId: string, projectId: string, checksum: string): Promise<SpecVersion | undefined>;
  countSpecVersionsSince(orgId: string, since: Date): Promise<number>;

  createPolicy(p: PolicyRecord): Promise<PolicyRecord>;
  getPolicy(orgId: string, id: string): Promise<PolicyRecord | undefined>;
  listPolicies(orgId: string, projectId?: string): Promise<PolicyRecord[]>;

  createComparison(c: ComparisonRecord): Promise<ComparisonRecord>;
  getComparison(orgId: string, id: string): Promise<ComparisonRecord | undefined>;
  /** Used by the worker, which only knows the comparison id; the id is unguessable and never returned to clients without an org check. */
  getComparisonUnscoped(id: string): Promise<ComparisonRecord | undefined>;
  updateComparison(id: string, patch: Partial<ComparisonRecord>): Promise<void>;
  listComparisons(orgId: string, opts?: { projectId?: string; limit?: number }): Promise<ComparisonRecord[]>;
  countComparisonsSince(orgId: string, since: Date): Promise<number>;

  replaceFindings(comparisonId: string, orgId: string, findings: FindingRecord[]): Promise<void>;
  listFindings(orgId: string, comparisonId: string): Promise<FindingRecord[]>;

  appendAudit(e: AuditEntry): Promise<void>;
  listAudit(orgId: string, limit: number): Promise<AuditEntry[]>;

  createGithubLink(l: GithubLink): Promise<GithubLink>;
  findGithubLink(installationId: number, repo: string): Promise<GithubLink | undefined>;
  listGithubLinks(orgId: string): Promise<GithubLink[]>;
  deleteGithubLink(orgId: string, id: string): Promise<void>;

  createNotification(n: Notification): Promise<void>;
  listNotifications(orgId: string, userId: string, limit: number): Promise<Notification[]>;
  markNotificationRead(orgId: string, userId: string, id: string, at: Date): Promise<boolean>;
}

export class InMemoryStore implements Store {
  private users = new Map<string, User>();
  private orgs = new Map<string, Org>();
  private members: Membership[] = [];
  private sessions = new Map<string, Session>();
  private failures = new Map<string, Date[]>();
  private projects = new Map<string, Project>();
  private envs = new Map<string, Environment>();
  private specs = new Map<string, SpecVersion>();
  private policies = new Map<string, PolicyRecord>();
  private comparisons = new Map<string, ComparisonRecord>();
  private findings = new Map<string, FindingRecord[]>();
  private audit: AuditEntry[] = [];
  private notifications: Notification[] = [];
  private ghLinks: GithubLink[] = [];

  async createUser(u: User) { this.users.set(u.id, u); return u; }
  async findUserByEmail(email: string) { return [...this.users.values()].find((u) => u.email === email); }
  async getUser(id: string) { return this.users.get(id); }

  async createOrg(o: Org) { this.orgs.set(o.id, o); return o; }
  async getOrg(id: string) { return this.orgs.get(id); }
  async findOrgBySlug(slug: string) { return [...this.orgs.values()].find((o) => o.slug === slug); }
  async setOrgPlan(id: string, plan: Plan) { const o = this.orgs.get(id); if (o) o.plan = plan; }

  async addMember(m: Membership) { this.members.push(m); }
  async getMembership(orgId: string, userId: string) { return this.members.find((m) => m.orgId === orgId && m.userId === userId); }
  async listMembers(orgId: string) {
    return this.members.filter((m) => m.orgId === orgId).map((m) => ({ ...m, email: this.users.get(m.userId)!.email, name: this.users.get(m.userId)!.name }));
  }
  async listMembershipsForUser(userId: string) {
    return this.members.filter((m) => m.userId === userId).map((m) => ({ ...m, org: this.orgs.get(m.orgId)! }));
  }
  async setMemberRole(orgId: string, userId: string, role: Role) { const m = await this.getMembership(orgId, userId); if (m) m.role = role; }
  async removeMember(orgId: string, userId: string) { this.members = this.members.filter((m) => !(m.orgId === orgId && m.userId === userId)); }

  async createSession(s: Session) { this.sessions.set(s.id, s); }
  async getSessionByTokenHash(hash: string) { return [...this.sessions.values()].find((s) => s.tokenHash === hash); }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async recordLoginFailure(key: string, at: Date) { this.failures.set(key, [...(this.failures.get(key) ?? []), at]); }
  async countLoginFailures(key: string, since: Date) { return (this.failures.get(key) ?? []).filter((d) => d >= since).length; }
  async clearLoginFailures(key: string) { this.failures.delete(key); }

  async createProject(p: Project) { this.projects.set(p.id, p); return p; }
  async getProject(orgId: string, id: string) { const p = this.projects.get(id); return p && p.orgId === orgId ? p : undefined; }
  async listProjects(orgId: string) { return [...this.projects.values()].filter((p) => p.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name)); }
  async deleteProject(orgId: string, id: string) {
    if (!(await this.getProject(orgId, id))) return;
    this.projects.delete(id);
    for (const [k, v] of this.envs) if (v.projectId === id) this.envs.delete(k);
    for (const [k, v] of this.specs) if (v.projectId === id) this.specs.delete(k); // cascade on project deletion only
    for (const [k, v] of this.comparisons) if (v.projectId === id) { this.comparisons.delete(k); this.findings.delete(k); }
  }
  async createEnvironment(e: Environment) { this.envs.set(e.id, e); return e; }
  async listEnvironments(orgId: string, projectId: string) { return [...this.envs.values()].filter((e) => e.orgId === orgId && e.projectId === projectId); }

  async createSpecVersion(v: SpecVersion) { this.specs.set(v.id, Object.freeze({ ...v })); return v; }
  async getSpecVersion(orgId: string, id: string) { const v = this.specs.get(id); return v && v.orgId === orgId ? v : undefined; }
  async listSpecVersions(orgId: string, projectId: string) {
    return [...this.specs.values()].filter((v) => v.orgId === orgId && v.projectId === projectId).sort((a, b) => b.number - a.number);
  }
  async findSpecByChecksum(orgId: string, projectId: string, checksum: string) {
    return [...this.specs.values()].find((v) => v.orgId === orgId && v.projectId === projectId && v.checksum === checksum);
  }
  async countSpecVersionsSince(orgId: string, since: Date) { return [...this.specs.values()].filter((v) => v.orgId === orgId && v.createdAt >= since).length; }

  async createPolicy(p: PolicyRecord) { this.policies.set(p.id, p); return p; }
  async getPolicy(orgId: string, id: string) { const p = this.policies.get(id); return p && p.orgId === orgId ? p : undefined; }
  async listPolicies(orgId: string, projectId?: string) {
    return [...this.policies.values()].filter((p) => p.orgId === orgId && (projectId === undefined || p.projectId === projectId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.version - a.version);
  }

  async createComparison(c: ComparisonRecord) { this.comparisons.set(c.id, { ...c }); return c; }
  async getComparison(orgId: string, id: string) { const c = this.comparisons.get(id); return c && c.orgId === orgId ? { ...c } : undefined; }
  async getComparisonUnscoped(id: string) { const c = this.comparisons.get(id); return c ? { ...c } : undefined; }
  async updateComparison(id: string, patch: Partial<ComparisonRecord>) { const c = this.comparisons.get(id); if (c) Object.assign(c, patch); }
  async listComparisons(orgId: string, opts: { projectId?: string; limit?: number } = {}) {
    return [...this.comparisons.values()].filter((c) => c.orgId === orgId && (!opts.projectId || c.projectId === opts.projectId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, opts.limit ?? 50).map((c) => ({ ...c }));
  }
  async countComparisonsSince(orgId: string, since: Date) { return [...this.comparisons.values()].filter((c) => c.orgId === orgId && c.createdAt >= since).length; }

  async replaceFindings(comparisonId: string, _orgId: string, findings: FindingRecord[]) { this.findings.set(comparisonId, findings); }
  async listFindings(orgId: string, comparisonId: string) { return (this.findings.get(comparisonId) ?? []).filter((f) => f.orgId === orgId); }

  async appendAudit(e: AuditEntry) { this.audit.push(e); }
  async listAudit(orgId: string, limit: number) { return this.audit.filter((e) => e.orgId === orgId).slice(-limit).reverse(); }

  async createGithubLink(l: GithubLink) { this.ghLinks.push(l); return l; }
  async findGithubLink(installationId: number, repo: string) { return this.ghLinks.find((l) => l.installationId === installationId && l.repo.toLowerCase() === repo.toLowerCase()); }
  async listGithubLinks(orgId: string) { return this.ghLinks.filter((l) => l.orgId === orgId); }
  async deleteGithubLink(orgId: string, id: string) { this.ghLinks = this.ghLinks.filter((l) => !(l.orgId === orgId && l.id === id)); }

  async createNotification(n: Notification) { this.notifications.push(n); }
  async listNotifications(orgId: string, userId: string, limit: number) {
    return this.notifications.filter((n) => n.orgId === orgId && n.userId === userId).slice(-limit).reverse();
  }
  async markNotificationRead(orgId: string, userId: string, id: string, at: Date) {
    const n = this.notifications.find((x) => x.id === id && x.orgId === orgId && x.userId === userId);
    if (!n) return false;
    n.readAt = at;
    return true;
  }
}
