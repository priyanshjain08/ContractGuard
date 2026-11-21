import { CATEGORY_RANK, SEVERITY_RANK } from './rules.ts';
import type { Category, CheckResult, ComparisonSummary, Finding, Policy, Severity, Suppression } from './types.ts';

export const DEFAULT_POLICY: Policy = { profile: 'standard', failOn: ['BREAKING'], failOnWarnings: false, ruleOverrides: {}, suppressions: [] };

const CATEGORIES: Category[] = ['BREAKING', 'POTENTIALLY_BREAKING', 'NON_BREAKING', 'INFORMATIONAL'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function isSuppressionActive(s: Suppression, now: Date): boolean {
  if (!s.expiresAt) return true;
  const t = Date.parse(s.expiresAt);
  return Number.isFinite(t) && t > now.getTime();
}

function matches(s: Suppression, f: Finding): boolean {
  if (!s.ruleId && !s.findingId && !s.operationPrefix) return false; // a suppression must target something
  if (s.ruleId && s.ruleId !== f.ruleId) return false;
  if (s.findingId && s.findingId !== f.id) return false;
  if (s.operationPrefix) {
    const op = f.method && f.path ? `${f.method} ${f.path}` : f.path ?? '';
    if (!op.startsWith(s.operationPrefix)) return false;
  }
  return true;
}

/**
 * Applies a policy to raw findings. Pure and deterministic given (findings, policy, now), which makes
 * a check reproducible from stored versions + engine version + policy snapshot. Suppressed findings are
 * never removed; they are marked SUPPRESSED and keep their evidence.
 */
export function evaluatePolicy(findings: Finding[], policy: Policy, now: Date): { findings: Finding[]; result: CheckResult; summary: ComparisonSummary } {
  const failOn = new Set<Category>(policy.failOn ?? ['BREAKING']);
  const overrides = policy.ruleOverrides ?? {};
  const suppressions = (policy.suppressions ?? []).filter((s) => isSuppressionActive(s, now));

  const out = findings.map((orig): Finding => {
    const f: Finding = { ...orig };
    delete f.suppression;
    const ov = overrides[f.ruleId];
    if (ov?.category && ov.category !== f.category) { f.originalCategory = f.category; f.category = ov.category; }
    if (ov?.severity) f.severity = ov.severity;

    const sup = suppressions.find((s) => matches(s, f));
    if (sup) {
      f.policyOutcome = 'SUPPRESSED';
      f.suppression = { reason: sup.reason, author: sup.author, expiresAt: sup.expiresAt };
      return f;
    }
    const actionable = f.category === 'BREAKING' || f.category === 'POTENTIALLY_BREAKING';
    let fails = failOn.has(f.category)
      || (!!policy.failOnWarnings && f.category === 'POTENTIALLY_BREAKING')
      || (!!policy.severityThreshold && actionable && SEVERITY_RANK[f.severity] <= SEVERITY_RANK[policy.severityThreshold]);
    if (ov?.fails !== undefined) fails = ov.fails;
    f.policyOutcome = fails ? 'FAIL' : actionable ? 'WARN' : 'PASS';
    return f;
  });

  const result: CheckResult = out.some((f) => f.policyOutcome === 'FAIL') ? 'FAIL' : out.some((f) => f.policyOutcome === 'WARN') ? 'NEEDS_REVIEW' : 'PASS';

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byRule: Record<string, number> = {};
  let suppressed = 0;
  for (const f of out) {
    byCategory[f.category]++; bySeverity[f.severity]++; byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
    if (f.policyOutcome === 'SUPPRESSED') suppressed++;
  }
  void CATEGORY_RANK;
  return { findings: out, result, summary: { total: out.length, byCategory, bySeverity, byRule, suppressed, operations: { base: 0, target: 0, added: 0, removed: 0 } } };
}
