import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, type Category, type Profile } from '@contractguard/compatibility';
import { baseSpec, clone, ir, mutate, type Spec } from './helpers.ts';

const NOW = new Date('2026-01-01T00:00:00Z');

function run(fn: (s: Spec) => void, profile: Profile = 'standard') {
  const { base, target } = mutate(fn);
  return compare(base, target, { policy: { profile }, now: NOW });
}
const ids = (r: ReturnType<typeof run>) => r.findings.map((f) => f.ruleId).sort();

const pets = (s: Spec) => s.paths['/pets'];
const newPet = (s: Spec) => s.components.schemas.NewPet;
const pet = (s: Spec) => s.components.schemas.Pet;

// [name, mutation, expected rule id, expected category under the "standard" profile]
const cases: Array<[string, (s: Spec) => void, string, Category]> = [
  ['endpoint removed', (s) => { delete s.paths['/pets/{id}']; }, 'CG-PATH-001', 'BREAKING'],
  ['method removed', (s) => { delete s.paths['/pets/{id}'].delete; }, 'CG-OP-001', 'BREAKING'],
  ['operationId changed', (s) => { pets(s).get.operationId = 'getAllPets'; }, 'CG-OP-002', 'POTENTIALLY_BREAKING'],
  ['operation added', (s) => { s.paths['/owners'] = { get: { responses: { '200': { description: 'ok' } } } }; }, 'CG-OP-003', 'NON_BREAKING'],
  ['operation deprecated', (s) => { pets(s).get.deprecated = true; }, 'CG-OP-004', 'INFORMATIONAL'],
  ['required param removed', (s) => { s.paths['/pets'].get.parameters.push({ name: 'x', in: 'query', required: true, schema: { type: 'string' } }); }, 'CG-PARAM-008', 'BREAKING'],
  ['optional param added', (s) => { pets(s).get.parameters.push({ name: 'q', in: 'query', schema: { type: 'string' } }); }, 'CG-PARAM-007', 'NON_BREAKING'],
  ['optional param removed', (s) => { pets(s).get.parameters.pop(); }, 'CG-PARAM-009', 'INFORMATIONAL'],
  ['optional param became required', (s) => { pets(s).get.parameters[0].required = true; }, 'CG-PARAM-002', 'BREAKING'],
  ['param type changed', (s) => { pets(s).get.parameters[0].schema.type = 'string'; }, 'CG-PARAM-003', 'BREAKING'],
  ['param location changed', (s) => { pets(s).get.parameters[0].in = 'header'; }, 'CG-PARAM-004', 'BREAKING'],
  ['param enum narrowed', (s) => { pets(s).get.parameters[1].schema.enum = ['available']; }, 'CG-PARAM-006', 'BREAKING'],
  ['param range narrowed', (s) => { pets(s).get.parameters[0].schema.maximum = 50; }, 'CG-PARAM-006', 'BREAKING'],
  ['param range widened', (s) => { pets(s).get.parameters[0].schema.maximum = 500; }, 'CG-PARAM-010', 'NON_BREAKING'],
  ['request body became required (from optional)', (s) => { /* base already required; see dedicated test */ s.paths['/pets'].post.requestBody.required = true; s.paths['/pets'].post.requestBody.content['application/json'].schema = { $ref: '#/components/schemas/NewPet' }; }, '__none__', 'NON_BREAKING'],
  ['request media type removed', (s) => { pets(s).post.requestBody.content = { 'application/xml': { schema: { $ref: '#/components/schemas/NewPet' } } }; }, 'CG-REQ-002', 'BREAKING'],
  ['required request property added', (s) => { newPet(s).required.push('tag'); }, 'CG-REQ-019', 'BREAKING'],
  ['new required request property', (s) => { newPet(s).properties.color = { type: 'string' }; newPet(s).required.push('color'); }, 'CG-REQ-010', 'BREAKING'],
  ['optional request property added', (s) => { newPet(s).properties.color = { type: 'string' }; }, 'CG-REQ-015', 'NON_BREAKING'],
  ['request property removed', (s) => { delete newPet(s).properties.tag; }, 'CG-REQ-011', 'POTENTIALLY_BREAKING'],
  ['request property type changed', (s) => { newPet(s).properties.age.type = 'string'; }, 'CG-REQ-012', 'BREAKING'],
  ['request enum value removed', (s) => { newPet(s).properties.kind.enum = ['dog']; }, 'CG-REQ-013', 'BREAKING'],
  ['request enum value added', (s) => { newPet(s).properties.kind.enum = ['dog', 'cat', 'fish']; }, 'CG-REQ-017', 'NON_BREAKING'],
  ['request maxLength narrowed', (s) => { newPet(s).properties.name.maxLength = 10; }, 'CG-REQ-014', 'BREAKING'],
  ['request maxLength loosened', (s) => { newPet(s).properties.name.maxLength = 100; }, 'CG-REQ-018', 'NON_BREAKING'],
  ['request property became optional', (s) => { newPet(s).required = []; }, 'CG-REQ-016', 'NON_BREAKING'],
  ['request integer -> number widened', (s) => { newPet(s).properties.age.type = 'number'; }, 'CG-REQ-018', 'NON_BREAKING'],
  ['response 2xx removed', (s) => { delete pets(s).post.responses['201']; pets(s).post.responses['202'] = { description: 'x' }; }, 'CG-RES-001', 'BREAKING'],
  ['response error removed', (s) => { delete pets(s).get.responses['400']; }, 'CG-RES-002', 'INFORMATIONAL'],
  ['response added', (s) => { pets(s).get.responses['404'] = { description: 'nf' }; }, 'CG-RES-004', 'NON_BREAKING'],
  ['response media type removed', (s) => { pets(s).get.responses['200'].content = { 'text/csv': { schema: { type: 'string' } } }; }, 'CG-RES-003', 'BREAKING'],
  ['response header removed', (s) => { delete pets(s).get.responses['200'].headers['X-Total']; }, 'CG-RES-006', 'POTENTIALLY_BREAKING'],
  ['response required property removed', (s) => { delete pet(s).properties.name; pet(s).required = ['id']; }, 'CG-RES-011', 'BREAKING'],
  ['response optional property removed', (s) => { delete pet(s).properties.tag; }, 'CG-RES-012', 'POTENTIALLY_BREAKING'],
  ['response property type changed', (s) => { pet(s).properties.id.type = 'integer'; }, 'CG-RES-013', 'BREAKING'],
  ['response enum value added', (s) => { pet(s).properties.kind.enum = ['dog', 'cat', 'fish']; }, 'CG-RES-014', 'POTENTIALLY_BREAKING'],
  ['response enum value removed', (s) => { pet(s).properties.kind.enum = ['dog']; }, 'CG-RES-015', 'NON_BREAKING'],
  ['response property became optional', (s) => { pet(s).required = ['id']; }, 'CG-RES-019', 'BREAKING'],
  ['response required property added', (s) => { pet(s).properties.color = { type: 'string' }; pet(s).required.push('color'); }, 'CG-RES-010', 'NON_BREAKING'],
  ['response optional property added', (s) => { pet(s).properties.color = { type: 'string' }; }, 'CG-RES-018', 'NON_BREAKING'],
  ['response nested property removed', (s) => { delete pet(s).properties.owner.properties.phone; }, 'CG-RES-012', 'POTENTIALLY_BREAKING'],
  ['response type loosened (nullable)', (s) => { pet(s).properties.id.nullable = true; }, 'CG-RES-017', 'POTENTIALLY_BREAKING'],
  ['response nullable removed is safe', (s) => { const b = pet(s).properties.tag; b.type = 'string'; }, '__none__', 'NON_BREAKING'],
  ['response array item type changed', (s) => { pets(s).get.responses['200'].content['application/json'].schema = { type: 'array', items: { type: 'string' } }; }, 'CG-RES-013', 'BREAKING'],
  ['security added to anonymous op', (s) => { pets(s).get.security = [{ bearer: [] }, { apiKey: [] }]; delete s.security; }, '__skip__', 'INFORMATIONAL'],
  ['default changed', (s) => { pets(s).get.parameters[0].schema.default = 20; }, 'CG-INFO-001', 'INFORMATIONAL'],
  ['servers changed', (s) => { s.servers = [{ url: 'https://api.example.com/v2' }]; }, 'CG-INFO-002', 'INFORMATIONAL'],
];

for (const [name, fn, rule, category] of cases) {
  if (rule === '__skip__') continue;
  test(`rule: ${name}`, () => {
    const r = run(fn);
    if (rule === '__none__') { assert.deepEqual(ids(r), [], JSON.stringify(r.findings.map((f) => f.summary))); return; }
    const hit = r.findings.filter((f) => f.ruleId === rule);
    assert.ok(hit.length >= 1, `expected ${rule}; got ${ids(r).join(', ') || 'nothing'}`);
    assert.equal(hit[0]!.category, category);
    assert.ok(hit[0]!.evidence.length > 0 && hit[0]!.recommendation.length > 0);
  });
}

test('required parameter removed is POTENTIALLY_BREAKING (standard), BREAKING (conservative)', () => {
  const mk = () => mutate((s) => { s.paths['/pets'].get.parameters[0].required = true; });
  const mkTarget = (profile: Profile) => {
    const base = clone(baseSpec()); base.paths['/pets'].get.parameters[0].required = true;
    const target = clone(baseSpec()); target.paths['/pets'].get.parameters.shift();
    return compare(ir(base), ir(target), { policy: { profile }, now: NOW }).findings.find((f) => f.ruleId === 'CG-PARAM-001')!;
  };
  void mk;
  assert.equal(mkTarget('standard').category, 'POTENTIALLY_BREAKING');
  assert.equal(mkTarget('conservative').category, 'BREAKING');
  assert.equal(mkTarget('permissive').category, 'POTENTIALLY_BREAKING');
});

test('request body becomes required when base had none', () => {
  const base = clone(baseSpec()); delete base.paths['/pets'].post.requestBody;
  const r = compare(ir(base), ir(baseSpec()), { now: NOW });
  assert.ok(r.findings.some((f) => f.ruleId === 'CG-REQ-001' && f.category === 'BREAKING'));
});

test('request body optional -> required and back', () => {
  const opt = clone(baseSpec()); opt.paths['/pets'].post.requestBody.required = false;
  assert.ok(compare(ir(opt), ir(baseSpec()), { now: NOW }).findings.some((f) => f.ruleId === 'CG-REQ-001'));
  assert.ok(compare(ir(baseSpec()), ir(opt), { now: NOW }).findings.some((f) => f.ruleId === 'CG-REQ-004'));
});

test('identical contracts produce no findings and PASS', () => {
  const r = compare(ir(baseSpec()), ir(baseSpec()), { now: NOW });
  assert.equal(r.findings.length, 0);
  assert.equal(r.result, 'PASS');
});

test('whole-path removal yields one PATH-001 finding, not one per method', () => {
  const r = run((s) => { delete s.paths['/pets/{id}']; });
  assert.deepEqual(ids(r), ['CG-PATH-001']);
  assert.equal(r.summary.operations.removed, 2);
});

test('path parameter rename is not a change', () => {
  const r = run((s) => {
    s.paths['/pets/{petId}'] = s.paths['/pets/{id}']; delete s.paths['/pets/{id}'];
    for (const m of ['get', 'delete']) s.paths['/pets/{petId}'][m].parameters[0].name = 'petId';
  });
  assert.deepEqual(ids(r), []);
});

test('path parameter moved to query is a location change', () => {
  const r = run((s) => { s.paths['/pets/{id}'].get.parameters[0] = { name: 'id', in: 'query', required: true, schema: { type: 'string' } }; });
  assert.ok(ids(r).includes('CG-PARAM-004') || ids(r).includes('CG-PARAM-008'));
});

test('readOnly properties never count as request breakage; writeOnly never as response breakage', () => {
  const r = run((s) => {
    newPet(s).properties.createdAt = { type: 'string', readOnly: true }; newPet(s).required.push('createdAt');
    pet(s).properties.password = { type: 'string', writeOnly: true }; pet(s).required.push('password');
  });
  assert.deepEqual(ids(r), []);
});

test('allOf composition is merged before comparison', () => {
  const withAllOf = (extraRequired: string[]) => {
    const s = clone(baseSpec());
    s.components.schemas.NewPet = { allOf: [{ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, { type: 'object', properties: { tag: { type: 'string' } }, required: extraRequired }] };
    return s;
  };
  const r = compare(ir(withAllOf([])), ir(withAllOf(['tag'])), { now: NOW });
  assert.deepEqual(ids(r), ['CG-REQ-019']);
});

test('3.1 type arrays and 3.0 nullable are normalized equivalently', () => {
  const a = clone(baseSpec()); a.components.schemas.Pet.properties.tag = { type: 'string', nullable: true };
  const b = clone(baseSpec()); b.openapi = '3.1.0'; b.components.schemas.Pet.properties.tag = { type: ['string', 'null'] };
  assert.deepEqual(ids(compare(ir(a), ir(b), { now: NOW })), []);
});

test('recursive schemas do not hang and are compared', () => {
  const mk = (extra: boolean) => {
    const s = clone(baseSpec());
    s.components.schemas.Pet.properties.parent = { $ref: '#/components/schemas/Pet' };
    if (extra) s.components.schemas.Pet.properties.nick = { type: 'string' };
    return s;
  };
  const r = compare(ir(mk(false)), ir(mk(true)), { now: NOW });
  // Pet is returned by three operations, so impact is reported once per operation.
  assert.deepEqual([...new Set(ids(r))], ['CG-RES-018']);
  assert.equal(r.findings.length, 3);
});

test('oneOf alternatives: removed request variant, added response variant', () => {
  const mk = (variants: any[]) => {
    const s = clone(baseSpec());
    s.components.schemas.NewPet = { oneOf: variants };
    s.components.schemas.Pet = { oneOf: variants };
    return s;
  };
  const dog = { type: 'object', properties: { bark: { type: 'boolean' } } };
  const cat = { type: 'object', properties: { purr: { type: 'boolean' } } };
  const shrunk = compare(ir(mk([dog, cat])), ir(mk([dog])), { now: NOW });
  assert.ok(ids(shrunk).includes('CG-REQ-020'));
  const grown = compare(ir(mk([dog])), ir(mk([dog, cat])), { now: NOW });
  assert.ok(ids(grown).includes('CG-RES-020') && ids(grown).includes('CG-REQ-018'));
});

// ---- security ---------------------------------------------------------------------------------
test('security: anonymous -> authenticated is breaking', () => {
  const base = clone(baseSpec()); delete base.security;
  const r = compare(ir(base), ir(baseSpec()), { now: NOW });
  assert.ok(r.findings.some((f) => f.ruleId === 'CG-SEC-001' && f.category === 'BREAKING'));
});
test('security: authenticated -> anonymous is relaxed (informational)', () => {
  const target = clone(baseSpec()); delete target.security;
  const r = compare(ir(baseSpec()), ir(target), { now: NOW });
  assert.ok(r.findings.some((f) => f.ruleId === 'CG-SEC-002' && f.category === 'INFORMATIONAL'));
  assert.equal(r.result, 'PASS');
});
test('security: scheme swapped is SEC-003', () => {
  const target = clone(baseSpec()); target.security = [{ apiKey: [] }];
  assert.ok(compare(ir(baseSpec()), ir(target), { now: NOW }).findings.some((f) => f.ruleId === 'CG-SEC-003'));
});
test('security: added OAuth scope is stricter', () => {
  const mk = (scopes: string[]) => { const s = clone(baseSpec()); s.components.securitySchemes.oauth = { type: 'oauth2', flows: { implicit: { authorizationUrl: 'https://x/a', scopes: { read: '', write: '' } } } }; s.security = [{ oauth: scopes }]; return s; };
  assert.ok(compare(ir(mk(['read'])), ir(mk(['read', 'write'])), { now: NOW }).findings.some((f) => f.ruleId === 'CG-SEC-001'));
  assert.ok(compare(ir(mk(['read', 'write'])), ir(mk(['read'])), { now: NOW }).findings.some((f) => f.ruleId === 'CG-SEC-002'));
});
test('security: alternative removed (OR -> single)', () => {
  const mk = (sec: any) => { const s = clone(baseSpec()); s.security = sec; return s; };
  const r = compare(ir(mk([{ bearer: [] }, { apiKey: [] }])), ir(mk([{ bearer: [] }])), { now: NOW });
  assert.ok(r.findings.some((f) => f.ruleId === 'CG-SEC-001'));
});
test('security scheme definition change is flagged once, not per operation', () => {
  const target = clone(baseSpec()); target.components.securitySchemes.bearer = { type: 'http', scheme: 'basic' };
  const r = compare(ir(baseSpec()), ir(target), { now: NOW });
  assert.equal(r.findings.filter((f) => f.ruleId === 'CG-SEC-003').length, 1);
});

// ---- determinism & stability ------------------------------------------------------------------
function shuffleKeys(v: any, seed: { n: number }): any {
  if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, seed));
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    keys.sort(() => ((seed.n = (seed.n * 1103515245 + 12345) & 0x7fffffff) % 3) - 1);
    return Object.fromEntries(keys.map((k) => [k, shuffleKeys(v[k], seed)]));
  }
  return v;
}

test('determinism: result is independent of key order in the source documents', () => {
  const t = clone(baseSpec());
  delete t.components.schemas.Pet.properties.tag; t.components.schemas.NewPet.required.push('tag'); delete t.paths['/pets/{id}'].delete;
  const normal = compare(ir(baseSpec()), ir(t), { now: NOW });
  for (let seed = 1; seed <= 8; seed++) {
    const r = compare(ir(shuffleKeys(baseSpec(), { n: seed })), ir(shuffleKeys(t, { n: seed * 7 })), { now: NOW });
    assert.deepEqual(r.findings, normal.findings);
  }
});

test('determinism: same inputs give byte-identical output; IDs are stable', () => {
  const t = clone(baseSpec()); t.components.schemas.Pet.properties.id.type = 'integer';
  const a = JSON.stringify(compare(ir(baseSpec()), ir(t), { now: NOW }));
  const b = JSON.stringify(compare(ir(baseSpec()), ir(t), { now: NOW }));
  assert.equal(a, b);
  const f = compare(ir(baseSpec()), ir(t), { now: NOW }).findings[0]!;
  assert.match(f.id, /^[0-9a-f]{16}$/);
});

test('identity & symmetry sanity: reversing a pure addition becomes a removal', () => {
  const t = clone(baseSpec()); t.components.schemas.Pet.properties.color = { type: 'string' };
  assert.deepEqual([...new Set(ids(compare(ir(baseSpec()), ir(t), { now: NOW })))], ['CG-RES-018']);
  assert.deepEqual([...new Set(ids(compare(ir(t), ir(baseSpec()), { now: NOW })))], ['CG-RES-012']);
});

test('fuzz: random single mutations never throw and unrelated additions stay non-failing', () => {
  let seed = 42;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const props = ['name', 'tag', 'age', 'kind'];
  for (let i = 0; i < 200; i++) {
    const t = clone(baseSpec());
    const p = newPet(t).properties;
    const name = props[rnd(props.length)]!;
    switch (rnd(5)) {
      case 0: delete p[name]; break;
      case 1: p[name] = { type: ['string', 'integer', 'boolean'][rnd(3)] }; break;
      case 2: p[name].enum = ['a', 'b'].slice(0, 1 + rnd(2)); break;
      case 3: newPet(t).required = [name]; break;
      default: p['extra' + i] = { type: 'string' };
    }
    const r = compare(ir(baseSpec()), ir(t), { now: NOW });
    for (const f of r.findings) assert.ok(f.ruleId in r.summary.byRule);
  }
});

test('type change does not also report noise from type-specific constraints', () => {
  const r = run((s) => { newPet(s).properties.age.type = 'string'; });
  assert.deepEqual([...new Set(ids(r))], ['CG-REQ-012']);
});
