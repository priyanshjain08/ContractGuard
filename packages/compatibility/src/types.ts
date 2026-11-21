export const ENGINE_VERSION = '0.1.0';

export type Category = 'BREAKING' | 'POTENTIALLY_BREAKING' | 'NON_BREAKING' | 'INFORMATIONAL';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Profile = 'conservative' | 'standard' | 'permissive';
export type PolicyOutcome = 'FAIL' | 'WARN' | 'PASS' | 'SUPPRESSED';
export type CheckResult = 'PASS' | 'FAIL' | 'NEEDS_REVIEW';

export interface Finding {
  /** Deterministic: same inputs -> same ID. Database primary keys are separate. */
  id: string;
  ruleId: string;
  category: Category;
  severity: Severity;
  title: string;
  summary: string;
  method?: string;
  path?: string;
  operationId?: string;
  /** Where in the operation the change occurred, e.g. "request.body[application/json]" or "response[200]". */
  location: string;
  /** Property path inside a schema, e.g. "$.address.zip" (empty for non-schema changes). */
  schemaPath: string;
  /** JSON pointers into the original base / target source documents. */
  basePointer?: string;
  targetPointer?: string;
  oldValue?: unknown;
  newValue?: unknown;
  evidence: string;
  recommendation: string;
  /** Set when a policy rule override changed the category from the profile default. */
  originalCategory?: Category;
  policyOutcome: PolicyOutcome;
  /** Present when policyOutcome is SUPPRESSED. */
  suppression?: { reason: string; author: string; expiresAt?: string };
}

export interface Suppression {
  ruleId?: string;
  findingId?: string;
  /** Matches operations as "METHOD /path" prefix, e.g. "GET /pets". */
  operationPrefix?: string;
  reason: string;
  author: string;
  /** ISO timestamp. Expired suppressions stop applying. */
  expiresAt?: string;
}

export interface RuleOverride {
  category?: Category;
  severity?: Severity;
  /** Force this rule to fail (true) or never fail (false) the check. */
  fails?: boolean;
}

export interface Policy {
  profile: Profile;
  /** Categories that fail the check. Default: ['BREAKING']. */
  failOn?: Category[];
  /** Fail when the finding severity is at or above this threshold (in addition to failOn). */
  severityThreshold?: Severity;
  /** Treat POTENTIALLY_BREAKING findings as failing ("new warnings fail CI"). */
  failOnWarnings?: boolean;
  ruleOverrides?: Record<string, RuleOverride>;
  suppressions?: Suppression[];
}

export interface ComparisonSummary {
  total: number;
  byCategory: Record<Category, number>;
  bySeverity: Record<Severity, number>;
  byRule: Record<string, number>;
  suppressed: number;
  operations: { base: number; target: number; added: number; removed: number };
}

export interface ComparisonResult {
  engineVersion: string;
  irVersion: string;
  generatedAt: string;
  base: { title: string; version: string; openapi: string };
  target: { title: string; version: string; openapi: string };
  policy: Policy;
  result: CheckResult;
  summary: ComparisonSummary;
  findings: Finding[];
  /** Constructs present in either contract that were NOT analyzed. */
  unsupported: Array<{ side: 'base' | 'target'; construct: string; pointer: string; detail?: string }>;
}
