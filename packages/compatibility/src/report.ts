import type { ComparisonResult, Finding } from './types.ts';

export const REPORT_LIMITATIONS: readonly string[] = [
  'Analysis is based solely on the two OpenAPI documents. It cannot see runtime behavior, undocumented server tolerance, or consumer code.',
  'Supported: OpenAPI 3.0.x and 3.1.x with local $refs. External $refs are not fetched; Swagger 2.0 is not supported.',
  'oneOf/anyOf are matched by structural signature only; allOf is merged shallowly; not, discriminator, patternProperties, if/then/else, callbacks, links and webhooks are not analyzed.',
  'additionalProperties and regular-expression containment are not compared in depth; changed patterns are classified conservatively.',
  'Classifications follow the selected compatibility profile. "Potentially breaking" means the impact depends on how consumers are implemented.',
];

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Neutralizes spreadsheet formula injection (CSV injection) and quotes the cell. */
export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function renderJson(r: ComparisonResult): string {
  return JSON.stringify(r, null, 2) + '\n';
}

export function renderCsv(r: ComparisonResult): string {
  const header = ['id', 'ruleId', 'category', 'severity', 'outcome', 'method', 'path', 'location', 'schemaPath', 'title', 'summary', 'oldValue', 'newValue', 'recommendation', 'suppressionReason'];
  const rows = r.findings.map((f) => [f.id, f.ruleId, f.category, f.severity, f.policyOutcome, f.method, f.path, f.location, f.schemaPath, f.title, f.summary, f.oldValue, f.newValue, f.recommendation, f.suppression?.reason]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function renderText(r: ComparisonResult, locate?: { base?: (p: string) => number | undefined; target?: (p: string) => number | undefined }): string {
  const lines: string[] = [];
  lines.push(`ContractGuard: ${r.base.title} ${r.base.version}  ->  ${r.target.title} ${r.target.version}`);
  lines.push(`Result: ${r.result}   profile=${r.policy.profile}   engine=${r.engineVersion}`);
  const c = r.summary.byCategory;
  lines.push(`Findings: ${r.summary.total} (breaking ${c.BREAKING}, potentially breaking ${c.POTENTIALLY_BREAKING}, non-breaking ${c.NON_BREAKING}, informational ${c.INFORMATIONAL}, suppressed ${r.summary.suppressed})`);
  lines.push('');
  for (const f of r.findings) {
    const where = [f.method, f.path].filter(Boolean).join(' ') || '(api)';
    const bl = f.basePointer && locate?.base?.(f.basePointer);
    const tl = f.targetPointer && locate?.target?.(f.targetPointer);
    const loc = [bl ? `base:${bl}` : '', tl ? `target:${tl}` : ''].filter(Boolean).join(' ');
    lines.push(`[${f.policyOutcome}] ${f.category} ${f.ruleId} ${where}${f.schemaPath && f.schemaPath !== '$' ? ' ' + f.schemaPath : ''}${loc ? ' (' + loc + ')' : ''}`);
    const place = f.location !== 'operation' && f.location !== 'path' ? ` [${f.location}]` : '';
    lines.push(`    ${f.summary}${place}${f.suppression ? ` [suppressed: ${f.suppression.reason}]` : ''}`);
  }
  if (r.unsupported.length) {
    lines.push('', `Not analyzed (${r.unsupported.length}): ` + [...new Set(r.unsupported.map((u) => u.construct))].join(', '));
  }
  return lines.join('\n') + '\n';
}

const BADGE: Record<string, string> = { PASS: '#1a7f37', FAIL: '#cf222e', NEEDS_REVIEW: '#9a6700' };

function findingHtml(f: Finding): string {
  const where = [f.method, f.path].filter(Boolean).join(' ');
  const json = (v: unknown) => (v === undefined ? '' : `<code>${escapeHtml(JSON.stringify(v))}</code>`);
  return `<article class="f ${escapeHtml(f.category)}${f.policyOutcome === 'SUPPRESSED' ? ' sup' : ''}">
  <header><span class="tag">${escapeHtml(f.category.replace('_', ' '))}</span> <span class="rule">${escapeHtml(f.ruleId)}</span> <span class="sev">${escapeHtml(f.severity)}</span> <span class="out">${escapeHtml(f.policyOutcome)}</span></header>
  <h3>${escapeHtml(f.title)}${where ? ` <small>${escapeHtml(where)}</small>` : ''}</h3>
  <p>${escapeHtml(f.summary)}</p>
  <dl>
    <dt>Location</dt><dd>${escapeHtml(f.location)}${f.schemaPath && f.schemaPath !== '$' ? ' &middot; <code>' + escapeHtml(f.schemaPath) + '</code>' : ''}</dd>
    ${f.oldValue !== undefined ? `<dt>Before</dt><dd>${json(f.oldValue)}</dd>` : ''}
    ${f.newValue !== undefined ? `<dt>After</dt><dd>${json(f.newValue)}</dd>` : ''}
    <dt>Evidence</dt><dd>${escapeHtml(f.evidence)}</dd>
    <dt>Recommendation</dt><dd>${escapeHtml(f.recommendation)}</dd>
    ${f.basePointer ? `<dt>Base</dt><dd><code>${escapeHtml(f.basePointer)}</code></dd>` : ''}
    ${f.targetPointer ? `<dt>Target</dt><dd><code>${escapeHtml(f.targetPointer)}</code></dd>` : ''}
    ${f.suppression ? `<dt>Suppressed</dt><dd>${escapeHtml(f.suppression.reason)} (by ${escapeHtml(f.suppression.author)}${f.suppression.expiresAt ? ', until ' + escapeHtml(f.suppression.expiresAt) : ''})</dd>` : ''}
  </dl>
</article>`;
}

/** Self-contained HTML report. Every dynamic value is escaped; no scripts, no external resources. */
export function renderHtmlReport(r: ComparisonResult): string {
  const c = r.summary.byCategory;
  const sections = (['BREAKING', 'POTENTIALLY_BREAKING', 'NON_BREAKING', 'INFORMATIONAL'] as const).map((cat) => {
    const list = r.findings.filter((f) => f.category === cat);
    return list.length ? `<section><h2>${escapeHtml(cat.replace('_', ' '))} (${list.length})</h2>${list.map(findingHtml).join('\n')}</section>` : '';
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>ContractGuard report: ${escapeHtml(r.target.title)}</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--mut:#656d76;--card:#f6f8fa;--bd:#d0d7de;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8d96a0;--card:#161b22;--bd:#30363d}}
body{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);max-width:60rem;margin:0 auto;padding:1rem}
.badge{display:inline-block;padding:.2rem .7rem;border-radius:1rem;color:#fff;font-weight:600}
.stats{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}.stats div{background:var(--card);border:1px solid var(--bd);border-radius:.5rem;padding:.4rem .8rem}
.f{background:var(--card);border:1px solid var(--bd);border-left:4px solid var(--mut);border-radius:.5rem;padding:.6rem 1rem;margin:.7rem 0}
.f.BREAKING{border-left-color:#cf222e}.f.POTENTIALLY_BREAKING{border-left-color:#bf8700}.f.NON_BREAKING{border-left-color:#1a7f37}.f.sup{opacity:.65}
.f h3{margin:.3rem 0}.f small{color:var(--mut);font-weight:400}.tag,.rule,.sev,.out{font-size:.75rem;margin-right:.4rem;color:var(--mut)}.tag{font-weight:700}
dl{display:grid;grid-template-columns:8rem 1fr;gap:.2rem .8rem;margin:0}dt{color:var(--mut)}dd{margin:0;overflow-wrap:anywhere}
code{font:12px ui-monospace,monospace}ul{color:var(--mut)}
</style></head><body>
<h1>ContractGuard compatibility report</h1>
<p>${escapeHtml(r.base.title)} <b>${escapeHtml(r.base.version)}</b> &rarr; ${escapeHtml(r.target.title)} <b>${escapeHtml(r.target.version)}</b></p>
<p><span class="badge" style="background:${BADGE[r.result] ?? '#666'}">${escapeHtml(r.result)}</span>
 &nbsp;profile <b>${escapeHtml(r.policy.profile)}</b> &middot; engine ${escapeHtml(r.engineVersion)} &middot; ${escapeHtml(r.generatedAt)}</p>
<div class="stats"><div>Breaking <b>${c.BREAKING}</b></div><div>Potentially breaking <b>${c.POTENTIALLY_BREAKING}</b></div><div>Non-breaking <b>${c.NON_BREAKING}</b></div><div>Informational <b>${c.INFORMATIONAL}</b></div><div>Suppressed <b>${r.summary.suppressed}</b></div>
<div>Operations +${r.summary.operations.added} / -${r.summary.operations.removed}</div></div>
${sections || '<p>No differences found.</p>'}
${r.unsupported.length ? `<section><h2>Not analyzed</h2><ul>${[...new Map(r.unsupported.map((u) => [u.construct + u.pointer, u])).values()].slice(0, 50).map((u) => `<li>${escapeHtml(u.side)}: ${escapeHtml(u.construct)} at <code>${escapeHtml(u.pointer)}</code></li>`).join('')}</ul></section>` : ''}
<section><h2>Limitations</h2><ul>${REPORT_LIMITATIONS.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul></section>
</body></html>
`;
}
