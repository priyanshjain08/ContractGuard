import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, evaluatePolicy, renderCsv, renderHtmlReport, renderJson, renderText, type Policy } from '@contractguard/compatibility';
import { baseSpec, clone, ir } from './helpers.ts';

const NOW = new Date('2026-06-01T00:00:00Z');

function breaking(policy?: Policy) {
  const t = clone(baseSpec());
  t.components.schemas.Pet.properties.id.type = 'integer'; // RES-013 BREAKING
  t.components.schemas.Pet.properties.kind.enum = ['dog', 'cat', 'fish']; // RES-014 POTENTIALLY
  t.components.schemas.Pet.properties.color = { type: 'string' }; // RES-018 NON_BREAKING
  return compare(ir(baseSpec()), ir(t), { policy, now: NOW });
}

test('default policy: breaking fails, potentially-breaking needs review', () => {
  const r = breaking();
  assert.equal(r.result, 'FAIL');
  assert.equal(r.findings.find((f) => f.ruleId === 'CG-RES-013')!.policyOutcome, 'FAIL');
  assert.equal(r.findings.find((f) => f.ruleId === 'CG-RES-014')!.policyOutcome, 'WARN');
  assert.equal(r.findings.find((f) => f.ruleId === 'CG-RES-018')!.policyOutcome, 'PASS');
});

test('only potentially-breaking findings -> NEEDS_REVIEW; failOnWarnings -> FAIL', () => {
  const t = clone(baseSpec()); t.components.schemas.Pet.properties.kind.enum = ['dog', 'cat', 'fish'];
  assert.equal(compare(ir(baseSpec()), ir(t), { now: NOW }).result, 'NEEDS_REVIEW');
  assert.equal(compare(ir(baseSpec()), ir(t), { policy: { profile: 'standard', failOnWarnings: true }, now: NOW }).result, 'FAIL');
});

test('profiles change classification of the same change', () => {
  const t = clone(baseSpec()); t.components.schemas.Pet.properties.color = { type: 'string' }; t.components.schemas.Pet.required.push('color');
  const cat = (profile: 'conservative' | 'standard' | 'permissive') => compare(ir(baseSpec()), ir(t), { policy: { profile }, now: NOW }).findings[0]!.category;
  assert.equal(cat('conservative'), 'POTENTIALLY_BREAKING');
  assert.equal(cat('standard'), 'NON_BREAKING');
});

test('rule override can downgrade a breaking rule and records the original category', () => {
  const r = breaking({ profile: 'standard', ruleOverrides: { 'CG-RES-013': { category: 'POTENTIALLY_BREAKING' } } });
  const f = r.findings.find((x) => x.ruleId === 'CG-RES-013')!;
  assert.equal(f.category, 'POTENTIALLY_BREAKING');
  assert.equal(f.originalCategory, 'BREAKING');
  assert.equal(r.result, 'NEEDS_REVIEW');
});

test('rule override fails:false stops a rule from failing the check', () => {
  const r = breaking({ profile: 'standard', ruleOverrides: { 'CG-RES-013': { fails: false } } });
  assert.equal(r.result, 'NEEDS_REVIEW');
});

test('suppression marks finding SUPPRESSED, keeps evidence, and can flip result to PASS', () => {
  const r = breaking({ profile: 'standard', suppressions: [
    { ruleId: 'CG-RES-013', reason: 'Coordinated with consumers', author: 'alice' },
    { ruleId: 'CG-RES-014', reason: 'Clients handle unknown enums', author: 'alice' },
  ] });
  assert.equal(r.result, 'PASS');
  // Each rule fires once per operation that returns Pet (3 operations x 2 rules).
  assert.equal(r.summary.suppressed, 6);
  assert.ok(r.findings.filter((x) => x.ruleId === 'CG-RES-013').every((x) => x.policyOutcome === 'SUPPRESSED'));
  const f = r.findings.find((x) => x.ruleId === 'CG-RES-013')!;
  assert.equal(f.policyOutcome, 'SUPPRESSED');
  assert.ok(f.evidence && f.suppression?.reason === 'Coordinated with consumers');
});

test('expired suppressions do not apply', () => {
  const r = breaking({ profile: 'standard', suppressions: [{ ruleId: 'CG-RES-013', reason: 'temp', author: 'bob', expiresAt: '2026-01-01T00:00:00Z' }] });
  assert.equal(r.result, 'FAIL');
  assert.equal(r.summary.suppressed, 0);
});

test('suppression requires at least one selector and operationPrefix scopes it', () => {
  assert.equal(breaking({ profile: 'standard', suppressions: [{ reason: 'all', author: 'x' }] }).result, 'FAIL');
  const scoped = breaking({ profile: 'standard', suppressions: [{ ruleId: 'CG-RES-013', operationPrefix: 'DELETE /nothing', reason: 'r', author: 'x' }] });
  assert.equal(scoped.result, 'FAIL');
});

test('evaluatePolicy is re-runnable on stored findings (reproducibility)', () => {
  const r = breaking();
  const again = evaluatePolicy(r.findings, r.policy, NOW);
  assert.deepEqual(again.findings, r.findings);
  assert.equal(again.result, r.result);
});

test('severityThreshold fails on high+ actionable findings', () => {
  const t = clone(baseSpec()); t.components.schemas.Pet.properties.kind.enum = ['dog', 'cat', 'fish']; // medium
  assert.equal(compare(ir(baseSpec()), ir(t), { policy: { profile: 'standard', severityThreshold: 'medium' }, now: NOW }).result, 'FAIL');
  assert.equal(compare(ir(baseSpec()), ir(t), { policy: { profile: 'standard', severityThreshold: 'high' }, now: NOW }).result, 'NEEDS_REVIEW');
});

// ---- reports ----------------------------------------------------------------------------------
function hostile() {
  const t = clone(baseSpec());
  t.paths['/<script>alert(1)</script>'] = { get: { operationId: '=HYPERLINK("http://evil","x")', responses: { '200': { description: 'ok' } } } };
  t.info.title = '<img src=x onerror=alert(1)>';
  return compare(ir(baseSpec()), ir(t), { now: NOW });
}

test('HTML report escapes all hostile content and ships no script', () => {
  const html = renderHtmlReport(hostile());
  assert.ok(!html.includes('<script'), 'no script element');
  assert.ok(!html.includes('<img src=x'), 'title escaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes("default-src 'none'"));
});

test('CSV neutralizes formula injection', () => {
  const t = clone(baseSpec());
  t.paths['/pets'].get.operationId = '=HYPERLINK("http://evil")';
  const csv = renderCsv(compare(ir(baseSpec()), ir(t), { now: NOW }));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`), csv);
  for (const line of csv.split('\r\n').slice(1)) for (const cell of line.split('","')) assert.ok(!/^"?[=+@]/.test(cell.replace(/^"/, '')));
});

test('JSON and text renderers work and include the verdict', () => {
  const r = breaking();
  assert.equal(JSON.parse(renderJson(r)).result, 'FAIL');
  assert.match(renderText(r), /Result: FAIL/);
});
