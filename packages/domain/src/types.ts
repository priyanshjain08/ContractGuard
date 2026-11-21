import type { ComparisonResult, Finding, Policy } from '@contractguard/compatibility';

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
export type Plan = 'FREE' | 'PRO' | 'ENTERPRISE';
export type ComparisonStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface User { id: string; email: string; name: string; passwordHash: string; createdAt: Date }
export interface Org { id: string; name: string; slug: string; plan: Plan; createdAt: Date }
export interface Membership { orgId: string; userId: string; role: Role; createdAt: Date }
export interface Session { id: string; userId: string; tokenHash: string; expiresAt: Date; createdAt: Date }
export interface Project { id: string; orgId: string; name: string; slug: string; description?: string; createdAt: Date }
export interface Environment { id: string; orgId: string; projectId: string; name: string; createdAt: Date }

/** Immutable once created: the store interface deliberately has no update/delete for versions. */
export interface SpecVersion {
  id: string; orgId: string; projectId: string; environmentId?: string;
  number: number; label: string; checksum: string; sizeBytes: number;
  title: string; apiVersion: string; openapi: string;
  content: string; source: 'upload' | 'url' | 'github';
  createdBy: string; createdAt: Date;
}

export interface PolicyRecord {
  id: string; orgId: string; projectId?: string; name: string; version: number;
  policy: Policy; createdBy: string; createdAt: Date;
}

export interface ComparisonRecord {
  id: string; orgId: string; projectId: string;
  baseVersionId: string; targetVersionId: string; policyId?: string;
  status: ComparisonStatus; result?: ComparisonResult['result']; error?: string;
  engineVersion?: string; summary?: ComparisonResult['summary'];
  /** Full engine output (without findings, which live in their own rows). */
  report?: Omit<ComparisonResult, 'findings'>;
  requestedBy: string; createdAt: Date; startedAt?: Date; completedAt?: Date;
}

export interface FindingRecord extends Finding { comparisonId: string; orgId: string; baseLine?: number; targetLine?: number }

export interface AuditEntry {
  id: string; orgId: string; actorId?: string; action: string;
  targetType?: string; targetId?: string; metadata?: Record<string, unknown>; at: Date;
}
export interface Notification {
  id: string; orgId: string; userId: string; kind: string; title: string; body: string;
  link?: string; readAt?: Date; createdAt: Date;
}

export interface Actor { userId: string }
export interface Clock { now(): Date }
export interface JobQueue { enqueueComparison(job: { comparisonId: string; orgId: string }): Promise<void> }

export interface GithubLink {
  id: string; orgId: string; projectId: string; installationId: number; repo: string; specPath: string; createdBy: string; createdAt: Date;
}
