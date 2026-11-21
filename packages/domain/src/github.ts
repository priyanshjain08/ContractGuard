import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ComparisonResult, Finding } from '@contractguard/compatibility';
import { AppError } from './errors.ts';

/** Verifies `X-Hub-Signature-256` over the RAW request body using a constant-time comparison. */
export function verifyGithubSignature(secret: string, rawBody: string | Buffer, header: string | undefined): boolean {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let given: Buffer;
  try { given = Buffer.from(header.slice(7), 'hex'); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface PullRequestEvent { installationId: number; repo: string; owner: string; number: number; headSha: string; baseRef: string; action: string }

const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

/** Returns undefined for events we intentionally ignore; throws VALIDATION for malformed payloads we should act on. */
export function parsePullRequestEvent(eventName: string | undefined, payload: any): PullRequestEvent | undefined {
  if (eventName !== 'pull_request' || !PR_ACTIONS.has(payload?.action)) return undefined;
  const pr = payload.pull_request, repo = payload.repository, inst = payload.installation?.id;
  if (!pr?.head?.sha || !repo?.name || !repo?.owner?.login || !Number.isInteger(pr.number) || !Number.isInteger(inst)) throw new AppError('VALIDATION', 'Malformed pull_request payload.');
  if (!/^[0-9a-f]{40}$/i.test(pr.head.sha)) throw new AppError('VALIDATION', 'Invalid head sha.');
  return { installationId: inst, repo: repo.name, owner: repo.owner.login, number: pr.number, headSha: pr.head.sha, baseRef: String(pr.base?.ref ?? ''), action: payload.action };
}

/** Markdown-safe: spec-derived text must not be able to inject links, HTML, tables or mentions into a PR comment. */
export function mdEscape(s: unknown): string {
  return String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200b') // zero-width space defuses @mentions
    .replace(/[\\`*_{}\[\]()#+\-.!|~]/g, (c) => `\\${c}`);
}

export interface CheckRunOutput {
  conclusion: 'success' | 'failure' | 'neutral';
  title: string; summary: string;
  annotations: Array<{ path: string; start_line: number; end_line: number; annotation_level: 'failure' | 'warning' | 'notice'; title: string; message: string }>;
}

export function buildCheckRun(result: ComparisonResult, opts: { specPath: string; lineOf?: (f: Finding) => number | undefined; detailsUrl?: string }): CheckRunOutput {
  const c = result.summary.byCategory;
  const conclusion = result.result === 'FAIL' ? 'failure' : result.result === 'NEEDS_REVIEW' ? 'neutral' : 'success';
  const title = result.result === 'PASS' ? 'No breaking API changes' : result.result === 'FAIL' ? `${c.BREAKING} breaking API change(s)` : `${c.POTENTIALLY_BREAKING} change(s) need review`;
  const top = result.findings.filter((f) => f.policyOutcome === 'FAIL' || f.policyOutcome === 'WARN').slice(0, 15);
  const lines = [
    `**Result:** ${result.result} · profile \`${result.policy.profile}\``, '',
    `| Breaking | Potentially breaking | Non-breaking | Suppressed |`, `|---|---|---|---|`,
    `| ${c.BREAKING} | ${c.POTENTIALLY_BREAKING} | ${c.NON_BREAKING} | ${result.summary.suppressed} |`, '',
    ...top.map((f) => `- **${f.ruleId}** ${mdEscape([f.method, f.path].filter(Boolean).join(' '))}: ${mdEscape(f.summary)}`),
  ];
  if (opts.detailsUrl) lines.push('', `[Open full report](${opts.detailsUrl})`);
  const annotations = top.flatMap((f) => {
    const line = opts.lineOf?.(f);
    return line ? [{ path: opts.specPath, start_line: line, end_line: line, annotation_level: (f.policyOutcome === 'FAIL' ? 'failure' : 'warning') as 'failure' | 'warning', title: `${f.ruleId}: ${f.title}`.slice(0, 255), message: f.summary.slice(0, 2000) }] : [];
  }).slice(0, 50);
  return { conclusion, title, summary: lines.join('\n').slice(0, 60000), annotations };
}
