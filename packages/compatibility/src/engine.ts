import { createHash } from 'node:crypto';
import { IR_VERSION, stableStringify, type ApiContractIR, type IROperation, type IRParameter, type IRSchema, type IRSecurityAlternative } from '@contractguard/openapi-parser';
import { evaluatePolicy, DEFAULT_POLICY } from './policy.ts';
import { CATEGORY_RANK, RULES } from './rules.ts';
import { ENGINE_VERSION, type Category, type ComparisonResult, type Finding, type Policy, type Profile } from './types.ts';

export interface CompareOptions {
  policy?: Policy;
  /** Injected clock so results are reproducible. Defaults to the current time. */
  now?: Date;
}

type Dir = 'request' | 'response' | 'param';

interface Ctx {
  op?: IROperation;
  location: string;
  dir: Dir;
}

interface EmitExtra {
  schemaPath?: string;
  basePointer?: string;
  targetPointer?: string;
  oldValue?: unknown;
  newValue?: unknown;
  evidence: string;
  summary: string;
  /** Distinguishes multiple findings of the same rule at the same place (used in the stable ID). */
  discriminator?: string;
}

class Collector {
  readonly findings: Finding[] = [];
  constructor(private profile: Profile) {}

  emit(ruleId: string, ctx: { op?: IROperation; location: string }, x: EmitExtra, opOverride?: Partial<Pick<Finding, 'method' | 'path' | 'operationId'>>): void {
    const rule = RULES[ruleId];
    if (!rule) throw new Error(`Unknown rule ${ruleId}`);
    const schemaPath = x.schemaPath ?? '';
    const opKey = ctx.op?.key ?? opOverride?.path ?? '';
    const id = createHash('sha256')
      .update([ruleId, opKey, ctx.location, schemaPath, x.discriminator ?? ''].join('|'))
      .digest('hex').slice(0, 16);
    this.findings.push({
      id, ruleId, category: rule.categories[this.profile], severity: rule.severity,
      title: rule.title, summary: x.summary,
      method: ctx.op?.method.toUpperCase() ?? opOverride?.method,
      path: ctx.op?.path ?? opOverride?.path,
      operationId: ctx.op?.operationId ?? opOverride?.operationId,
      location: ctx.location, schemaPath,
      basePointer: x.basePointer, targetPointer: x.targetPointer,
      oldValue: x.oldValue, newValue: x.newValue,
      evidence: x.evidence, recommendation: rule.recommendation,
      policyOutcome: 'PASS',
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Schema comparison
// ---------------------------------------------------------------------------------------------

type JT = NonNullable<IRSchema['types']>[number];
const covers = (set: readonly JT[], t: JT): boolean => set.includes(t) || (t === 'integer' && set.includes('number'));

const RULEMAP: Record<Dir, Record<string, string>> = {
  request: { typeChange: 'CG-REQ-012', narrowed: 'CG-REQ-014', loosened: 'CG-REQ-018', enumRemoved: 'CG-REQ-013', enumAdded: 'CG-REQ-017', variants: 'CG-REQ-020' },
  param: { typeChange: 'CG-PARAM-003', narrowed: 'CG-PARAM-006', loosened: 'CG-PARAM-010', enumRemoved: 'CG-PARAM-006', enumAdded: 'CG-PARAM-010', variants: 'CG-REQ-020' },
  response: { typeChange: 'CG-RES-013', narrowed: 'CG-RES-016', loosened: 'CG-RES-017', enumRemoved: 'CG-RES-015', enumAdded: 'CG-RES-014', variants: 'CG-RES-020' },
};

const LOWER_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'] as const;
const UPPER_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'] as const;

/** Structural signature of a schema (no pointers) used to match oneOf/anyOf alternatives. */
function signature(s: IRSchema, depth = 0): string {
  if (s.circularRef) return `ref:${s.circularRef}`;
  if (depth > 6) return 'deep';
  const props = s.properties
    ? Object.fromEntries(Object.keys(s.properties).sort().map((k) => [k, signature(s.properties![k]!, depth + 1)])) : undefined;
  return stableStringify({
    t: s.types, f: s.format, e: s.enum, r: s.required, p: props, c: s.constraints,
    i: s.items ? signature(s.items, depth + 1) : undefined,
  });
}

function diffSchema(col: Collector, ctx: Ctx, b: IRSchema, t: IRSchema, path: string): void {
  if (b.circularRef || t.circularRef) return; // recursion cut-off: not analyzed further
  const R = RULEMAP[ctx.dir];
  const ptrs = { basePointer: b.pointer, targetPointer: t.pointer };
  const at = path === '$' ? 'the schema' : `"${path}"`;
  const req = ctx.dir !== 'response';

  // ---- types
  const bt = b.types, tt = t.types;
  const typeSame = stableStringify(bt) === stableStringify(tt);
  let incompatibleType = false;
  if (!typeSame) {
    let widened: boolean, narrowed: boolean;
    if (!bt) { widened = false; narrowed = true; }
    else if (!tt) { widened = true; narrowed = false; }
    else {
      widened = bt.every((x) => covers(tt, x));
      narrowed = tt.every((x) => covers(bt, x));
    }
    const what = `types ${JSON.stringify(bt ?? 'any')} -> ${JSON.stringify(tt ?? 'any')}`;
    if (widened && !narrowed) {
      col.emit(req ? R.loosened! : 'CG-RES-017', ctx, { schemaPath: path, ...ptrs, oldValue: bt, newValue: tt, discriminator: 'type',
        summary: `Type of ${at} was widened (${what}).`, evidence: `Base accepts/returns ${JSON.stringify(bt ?? 'any')}; target ${JSON.stringify(tt ?? 'any')}.` });
    } else if (narrowed && !widened) {
      if (req && bt) col.emit(R.typeChange!, ctx, { schemaPath: path, ...ptrs, oldValue: bt, newValue: tt, discriminator: 'type',
        summary: `Type of ${at} was narrowed (${what}); previously valid input is rejected.`, evidence: `Base accepted ${JSON.stringify(bt)}; target accepts ${JSON.stringify(tt)}.` });
      else col.emit(R.narrowed!, ctx, { schemaPath: path, ...ptrs, oldValue: bt, newValue: tt, discriminator: 'type',
        summary: `Type of ${at} was narrowed (${what}).`, evidence: `Base: ${JSON.stringify(bt ?? 'any')}; target: ${JSON.stringify(tt)}.` });
    } else {
      col.emit(R.typeChange!, ctx, { schemaPath: path, ...ptrs, oldValue: bt, newValue: tt, discriminator: 'type',
        summary: `Type of ${at} changed (${what}).`, evidence: `Base type ${JSON.stringify(bt)} is not compatible with target type ${JSON.stringify(tt)}.` });
    }
  }

  // ---- format
  if (b.format !== t.format) {
    if (b.format && t.format) {
      col.emit(R.typeChange!, ctx, { schemaPath: path, ...ptrs, oldValue: b.format, newValue: t.format, discriminator: 'format',
        summary: `Format of ${at} changed from "${b.format}" to "${t.format}".`, evidence: `format: ${b.format} -> ${t.format}` });
    } else if (t.format) {
      col.emit(R.narrowed!, ctx, { schemaPath: path, ...ptrs, oldValue: undefined, newValue: t.format, discriminator: 'format',
        summary: `Format "${t.format}" was added to ${at}.`, evidence: `format: (none) -> ${t.format}` });
    } else {
      col.emit(req ? R.loosened! : 'CG-RES-017', ctx, { schemaPath: path, ...ptrs, oldValue: b.format, newValue: undefined, discriminator: 'format',
        summary: `Format "${b.format}" was removed from ${at}.`, evidence: `format: ${b.format} -> (none)` });
    }
  }

  // ---- enum
  if (b.enum || t.enum) {
    if (b.enum && t.enum) {
      const bs = new Map(b.enum.map((v) => [stableStringify(v), v]));
      const ts = new Map(t.enum.map((v) => [stableStringify(v), v]));
      const removed = [...bs].filter(([k]) => !ts.has(k)).map(([, v]) => v);
      const added = [...ts].filter(([k]) => !bs.has(k)).map(([, v]) => v);
      if (removed.length) col.emit(R.enumRemoved!, ctx, { schemaPath: path, ...ptrs, oldValue: b.enum, newValue: t.enum, discriminator: 'enum-removed',
        summary: `Enum value(s) ${JSON.stringify(removed)} removed from ${at}.`, evidence: `Removed: ${JSON.stringify(removed)}. Remaining: ${JSON.stringify(t.enum)}.` });
      if (added.length) col.emit(R.enumAdded!, ctx, { schemaPath: path, ...ptrs, oldValue: b.enum, newValue: t.enum, discriminator: 'enum-added',
        summary: `Enum value(s) ${JSON.stringify(added)} added to ${at}.`, evidence: `Added: ${JSON.stringify(added)}. Full set: ${JSON.stringify(t.enum)}.` });
    } else if (b.enum) {
      col.emit(req ? R.loosened! : 'CG-RES-017', ctx, { schemaPath: path, ...ptrs, oldValue: b.enum, newValue: undefined, discriminator: 'enum',
        summary: `Enum restriction ${JSON.stringify(b.enum)} was removed from ${at}.`, evidence: 'Target schema no longer enumerates allowed values.' });
    } else {
      col.emit(R.narrowed!, ctx, { schemaPath: path, ...ptrs, oldValue: undefined, newValue: t.enum, discriminator: 'enum',
        summary: `Enum restriction ${JSON.stringify(t.enum)} was added to ${at}.`, evidence: 'Target schema now restricts values to a fixed set.' });
    }
  }

  // ---- constraints (type-specific, so meaningless once the type itself changed incompatibly)
  const narrowedC: Record<string, [unknown, unknown]> = {};
  const loosenedC: Record<string, [unknown, unknown]> = {};
  for (const k of LOWER_BOUNDS) {
    const bv = b.constraints[k], tv = t.constraints[k];
    if (bv === tv) continue;
    if (bv === undefined) narrowedC[k] = [bv, tv];
    else if (tv === undefined || tv < bv) loosenedC[k] = [bv, tv];
    else narrowedC[k] = [bv, tv];
  }
  for (const k of UPPER_BOUNDS) {
    const bv = b.constraints[k], tv = t.constraints[k];
    if (bv === tv) continue;
    if (bv === undefined) narrowedC[k] = [bv, tv];
    else if (tv === undefined || tv > bv) loosenedC[k] = [bv, tv];
    else narrowedC[k] = [bv, tv];
  }
  if (b.constraints.pattern !== t.constraints.pattern) {
    const [bv, tv] = [b.constraints.pattern, t.constraints.pattern];
    if (!bv) narrowedC.pattern = [bv, tv];
    else if (!tv) loosenedC.pattern = [bv, tv];
    else (req ? narrowedC : loosenedC).pattern = [bv, tv]; // cannot prove regex containment; assume the unsafe direction
  }
  if (!!b.constraints.uniqueItems !== !!t.constraints.uniqueItems) {
    (t.constraints.uniqueItems ? narrowedC : loosenedC).uniqueItems = [b.constraints.uniqueItems, t.constraints.uniqueItems];
  }
  const emitConstraints = (rec: Record<string, [unknown, unknown]>, rule: string, verb: string, tag: string) => {
    const keys = Object.keys(rec).sort();
    if (!keys.length) return;
    col.emit(rule, ctx, {
      schemaPath: path, ...ptrs, discriminator: tag,
      oldValue: Object.fromEntries(keys.map((k) => [k, rec[k]![0]])), newValue: Object.fromEntries(keys.map((k) => [k, rec[k]![1]])),
      summary: `Constraints on ${at} were ${verb}: ${keys.join(', ')}.`,
      evidence: keys.map((k) => `${k}: ${JSON.stringify(rec[k]![0])} -> ${JSON.stringify(rec[k]![1])}`).join('; '),
    });
  };
  // For requests, narrowing is dangerous; for responses, loosening is.
  if (!incompatibleType) {
    emitConstraints(narrowedC, R.narrowed!, 'narrowed', 'c-narrow');
    emitConstraints(loosenedC, R.loosened!, 'loosened', 'c-loose');
  }

  // ---- default
  if (b.default !== undefined || t.default !== undefined) {
    if (stableStringify(b.default) !== stableStringify(t.default)) {
      col.emit('CG-INFO-001', ctx, { schemaPath: path, ...ptrs, oldValue: b.default, newValue: t.default, discriminator: 'default',
        summary: `Default of ${at} changed from ${JSON.stringify(b.default)} to ${JSON.stringify(t.default)}.`, evidence: `default: ${JSON.stringify(b.default)} -> ${JSON.stringify(t.default)}` });
    }
  }

  // ---- properties
  if (b.properties || t.properties) {
    const bp = b.properties ?? {}, tp = t.properties ?? {};
    const bReq = new Set(b.required ?? []), tReq = new Set(t.required ?? []);
    for (const name of [...new Set([...Object.keys(bp), ...Object.keys(tp)])].sort()) {
      const child = path === '$' ? `$.${name}` : `${path}.${name}`;
      const bs = bp[name], ts = tp[name];
      if (bs && !ts) {
        if (req && bs.readOnly) continue;
        if (!req && bs.writeOnly) continue;
        if (req) col.emit('CG-REQ-011', ctx, { schemaPath: child, basePointer: bs.pointer, oldValue: describe(bs), discriminator: 'removed',
          summary: `Property "${child}" was removed from the request schema.`, evidence: `Present in base (${bReq.has(name) ? 'required' : 'optional'}), absent in target.` });
        else col.emit(bReq.has(name) ? 'CG-RES-011' : 'CG-RES-012', ctx, { schemaPath: child, basePointer: bs.pointer, oldValue: describe(bs), discriminator: 'removed',
          summary: `Property "${child}" was removed from the response schema.`, evidence: `Present in base (${bReq.has(name) ? 'required' : 'optional'}), absent in target.` });
      } else if (!bs && ts) {
        if (req && ts.readOnly) continue;
        if (!req && ts.writeOnly) continue;
        const isReq = tReq.has(name);
        if (req) col.emit(isReq ? 'CG-REQ-010' : 'CG-REQ-015', ctx, { schemaPath: child, targetPointer: ts.pointer, newValue: describe(ts), discriminator: 'added',
          summary: `${isReq ? 'Required' : 'Optional'} property "${child}" was added to the request schema.`, evidence: `Absent in base, ${isReq ? 'required' : 'optional'} in target.` });
        else col.emit(isReq ? 'CG-RES-010' : 'CG-RES-018', ctx, { schemaPath: child, targetPointer: ts.pointer, newValue: describe(ts), discriminator: 'added',
          summary: `${isReq ? 'Required' : 'Optional'} property "${child}" was added to the response schema.`, evidence: `Absent in base, ${isReq ? 'required' : 'optional'} in target.` });
      } else if (bs && ts) {
        const wasReq = bReq.has(name), isReq = tReq.has(name);
        const skipReqChange = (req && (bs.readOnly || ts.readOnly)) || (!req && (bs.writeOnly || ts.writeOnly));
        if (wasReq !== isReq && !skipReqChange) {
          const rule = req ? (isReq ? 'CG-REQ-019' : 'CG-REQ-016') : (isReq ? 'CG-RES-021' : 'CG-RES-019');
          col.emit(rule, ctx, { schemaPath: child, basePointer: bs.pointer, targetPointer: ts.pointer, oldValue: wasReq ? 'required' : 'optional', newValue: isReq ? 'required' : 'optional', discriminator: 'required-flag',
            summary: `Property "${child}" changed from ${wasReq ? 'required' : 'optional'} to ${isReq ? 'required' : 'optional'}.`, evidence: `required: ${wasReq} -> ${isReq}` });
        }
        diffSchema(col, ctx, bs, ts, child);
      }
    }
  }

  // ---- array items
  if (b.items && t.items) diffSchema(col, ctx, b.items, t.items, `${path}[]`);

  // ---- oneOf / anyOf (signature-level only)
  if (b.variants && t.variants) {
    const bs = new Map(b.variants.items.map((s) => [signature(s), s]));
    const ts = new Map(t.variants.items.map((s) => [signature(s), s]));
    const removed = [...bs].filter(([k]) => !ts.has(k)).map(([, s]) => s);
    const added = [...ts].filter(([k]) => !bs.has(k)).map(([, s]) => s);
    const label = (s: IRSchema) => s.refName ?? (s.types ? s.types.join('|') : 'schema');
    if (removed.length) col.emit(req ? R.variants! : 'CG-RES-016', ctx, { schemaPath: path, ...ptrs, discriminator: 'variants-removed',
      oldValue: removed.map(label), summary: `Alternative(s) ${removed.map(label).join(', ')} removed from ${at}.`, evidence: `${removed.length} ${b.variants.kind} alternative(s) no longer present (matched structurally).` });
    if (added.length) col.emit(req ? 'CG-REQ-018' : R.variants!, ctx, { schemaPath: path, ...ptrs, discriminator: 'variants-added',
      newValue: added.map(label), summary: `Alternative(s) ${added.map(label).join(', ')} added to ${at}.`, evidence: `${added.length} ${t.variants.kind} alternative(s) added (matched structurally).` });
  }
}

function describe(s: IRSchema): unknown {
  return { types: s.types, format: s.format, enum: s.enum, refName: s.refName };
}

// ---------------------------------------------------------------------------------------------
// Operation comparison
// ---------------------------------------------------------------------------------------------

function diffParameters(col: Collector, op: IROperation, bOp: IROperation, tOp: IROperation): void {
  const bp = bOp.parameters, tp = tOp.parameters;
  const removed = Object.keys(bp).filter((k) => !tp[k]).sort();
  const added = Object.keys(tp).filter((k) => !bp[k]).sort();
  const moved = new Set<string>();

  for (const rk of removed) {
    const rp = bp[rk]!;
    const match = added.find((ak) => !moved.has(ak) && tp[ak]!.name.toLowerCase() === rp.name.toLowerCase() && tp[ak]!.in !== rp.in);
    if (match) {
      moved.add(match); moved.add(rk);
      const ap = tp[match]!;
      col.emit('CG-PARAM-004', { op, location: `parameter[${rp.in}:${rp.name}]` }, { basePointer: rp.pointer, targetPointer: ap.pointer,
        oldValue: rp.in, newValue: ap.in, discriminator: `${rp.in}->${ap.in}:${rp.name}`,
        summary: `Parameter "${rp.name}" moved from ${rp.in} to ${ap.in}.`, evidence: `in: ${rp.in} -> ${ap.in}` });
    }
  }
  for (const rk of removed) {
    if (moved.has(rk)) continue;
    const rp = bp[rk]!;
    col.emit(rp.required ? 'CG-PARAM-001' : 'CG-PARAM-009', { op, location: `parameter[${rp.in}:${rp.name}]` }, { basePointer: rp.pointer,
      oldValue: { in: rp.in, required: rp.required }, discriminator: 'removed',
      summary: `${rp.required ? 'Required' : 'Optional'} ${rp.in} parameter "${rp.name}" was removed.`, evidence: `Present in base, absent in target.` });
  }
  for (const ak of added) {
    if (moved.has(ak)) continue;
    const ap = tp[ak]!;
    col.emit(ap.required ? 'CG-PARAM-008' : 'CG-PARAM-007', { op, location: `parameter[${ap.in}:${ap.name}]` }, { targetPointer: ap.pointer,
      newValue: { in: ap.in, required: ap.required }, discriminator: 'added',
      summary: `${ap.required ? 'Required' : 'Optional'} ${ap.in} parameter "${ap.name}" was added.`, evidence: `Absent in base, ${ap.required ? 'required' : 'optional'} in target.` });
  }
  for (const k of Object.keys(bp).filter((k) => tp[k]).sort()) {
    const b = bp[k]!, t = tp[k]!;
    const loc = `parameter[${t.in}:${t.name}]`;
    if (b.required !== t.required) {
      col.emit(t.required ? 'CG-PARAM-002' : 'CG-PARAM-011', { op, location: loc }, { basePointer: b.pointer, targetPointer: t.pointer,
        oldValue: b.required ? 'required' : 'optional', newValue: t.required ? 'required' : 'optional', discriminator: 'required-flag',
        summary: `Parameter "${t.name}" changed from ${b.required ? 'required' : 'optional'} to ${t.required ? 'required' : 'optional'}.`, evidence: `required: ${b.required} -> ${t.required}` });
    }
    if ((b.style !== t.style || b.explode !== t.explode) && serializationMatters(b, t)) {
      col.emit('CG-PARAM-005', { op, location: loc }, { basePointer: b.pointer, targetPointer: t.pointer,
        oldValue: { style: b.style, explode: b.explode }, newValue: { style: t.style, explode: t.explode }, discriminator: 'serialization',
        summary: `Serialization of parameter "${t.name}" changed (style ${b.style}->${t.style}, explode ${b.explode}->${t.explode}).`, evidence: `style: ${b.style} -> ${t.style}; explode: ${b.explode} -> ${t.explode}` });
    }
    if (b.schema && t.schema) diffSchema(col, { op, location: loc, dir: 'param' }, b.schema, t.schema, '$');
  }
}

function serializationMatters(b: IRParameter, t: IRParameter): boolean {
  const composite = (p: IRParameter) => !p.schema || !p.schema.types || p.schema.types.some((x) => x === 'array' || x === 'object');
  return composite(b) || composite(t);
}

function diffRequestBody(col: Collector, op: IROperation, bOp: IROperation, tOp: IROperation): void {
  const b = bOp.requestBody, t = tOp.requestBody;
  if (!b && !t) return;
  const loc = 'request.body';
  if (!b && t) {
    if (t.required) col.emit('CG-REQ-001', { op, location: loc }, { targetPointer: t.pointer, oldValue: 'none', newValue: 'required', discriminator: 'introduced',
      summary: 'A required request body was introduced.', evidence: 'Base operation has no request body; target requires one.' });
    else for (const mt of Object.keys(t.content)) col.emit('CG-REQ-003', { op, location: `${loc}[${mt}]` }, { targetPointer: t.content[mt]!.pointer, newValue: mt, discriminator: 'added',
      summary: `Optional request media type "${mt}" was added.`, evidence: 'Absent in base, present in target.' });
    return;
  }
  const bc = b?.content ?? {}, tc = t?.content ?? {};
  if (b && t && b.required !== t.required) {
    col.emit(t.required ? 'CG-REQ-001' : 'CG-REQ-004', { op, location: loc }, { basePointer: b.pointer, targetPointer: t.pointer,
      oldValue: b.required ? 'required' : 'optional', newValue: t.required ? 'required' : 'optional', discriminator: 'required-flag',
      summary: `Request body changed from ${b.required ? 'required' : 'optional'} to ${t.required ? 'required' : 'optional'}.`, evidence: `required: ${b.required} -> ${t.required}` });
  }
  for (const mt of [...new Set([...Object.keys(bc), ...Object.keys(tc)])].sort()) {
    const bm = bc[mt], tm = tc[mt];
    const mtLoc = `${loc}[${mt}]`;
    if (bm && !tm) col.emit('CG-REQ-002', { op, location: mtLoc }, { basePointer: bm.pointer, oldValue: mt, discriminator: 'removed',
      summary: `Request media type "${mt}" was removed.`, evidence: 'Present in base, absent in target.' });
    else if (!bm && tm && b) col.emit('CG-REQ-003', { op, location: mtLoc }, { targetPointer: tm.pointer, newValue: mt, discriminator: 'added',
      summary: `Request media type "${mt}" was added.`, evidence: 'Absent in base, present in target.' });
    else if (bm && tm && bm.schema && tm.schema) diffSchema(col, { op, location: mtLoc, dir: 'request' }, bm.schema, tm.schema, '$');
  }
}

const isSuccess = (s: string) => /^2/.test(s);
const covered = (status: string, target: IROperation['responses']) => /^\dXX$/.test(status) ? false : !!target[`${status[0]}XX`];

function diffResponses(col: Collector, op: IROperation, bOp: IROperation, tOp: IROperation): void {
  const br = bOp.responses, tr = tOp.responses;
  for (const status of [...new Set([...Object.keys(br), ...Object.keys(tr)])].sort()) {
    const b = br[status], t = tr[status];
    const loc = `response[${status}]`;
    if (b && !t) {
      if (covered(status, tr)) continue; // now documented via a range such as 2XX
      col.emit(isSuccess(status) ? 'CG-RES-001' : 'CG-RES-002', { op, location: loc }, { basePointer: b.pointer, oldValue: status, discriminator: 'removed',
        summary: `Response ${status} is no longer documented.`, evidence: 'Present in base, absent in target.' });
      continue;
    }
    if (!b && t) {
      col.emit('CG-RES-004', { op, location: loc }, { targetPointer: t.pointer, newValue: status, discriminator: 'added',
        summary: `New response ${status} was added.`, evidence: 'Absent in base, present in target.' });
      continue;
    }
    if (!b || !t) continue;
    for (const mt of [...new Set([...Object.keys(b.content), ...Object.keys(t.content)])].sort()) {
      const bm = b.content[mt], tm = t.content[mt];
      const mtLoc = `${loc}.body[${mt}]`;
      if (bm && !tm) col.emit('CG-RES-003', { op, location: mtLoc }, { basePointer: bm.pointer, oldValue: mt, discriminator: 'removed',
        summary: `Response ${status} media type "${mt}" was removed.`, evidence: 'Present in base, absent in target.' });
      else if (!bm && tm) col.emit('CG-RES-005', { op, location: mtLoc }, { targetPointer: tm.pointer, newValue: mt, discriminator: 'added',
        summary: `Response ${status} media type "${mt}" was added.`, evidence: 'Absent in base, present in target.' });
      else if (bm && tm && bm.schema && tm.schema) diffSchema(col, { op, location: mtLoc, dir: 'response' }, bm.schema, tm.schema, '$');
    }
    for (const h of [...new Set([...Object.keys(b.headers), ...Object.keys(t.headers)])].sort()) {
      const bh = b.headers[h], th = t.headers[h];
      const hLoc = `${loc}.header[${h}]`;
      if (bh && !th) col.emit('CG-RES-006', { op, location: hLoc }, { basePointer: bh.pointer, oldValue: { required: bh.required }, discriminator: 'removed',
        summary: `Response ${status} header "${bh.name}" was removed.`, evidence: 'Present in base, absent in target.' });
      else if (bh && th && bh.schema && th.schema) diffSchema(col, { op, location: hLoc, dir: 'response' }, bh.schema, th.schema, '$');
    }
  }
}

// ---- security ---------------------------------------------------------------------------------

const altSig = (a: IRSecurityAlternative) => stableStringify(a);
const normAlts = (alts: IRSecurityAlternative[]): IRSecurityAlternative[] => (alts.length === 0 ? [{}] : alts);
/** A client holding credentials `have` can satisfy requirement `need`. */
function satisfies(have: IRSecurityAlternative, need: IRSecurityAlternative): boolean {
  return Object.keys(need).every((s) => have[s] && need[s]!.every((sc) => have[s]!.includes(sc)));
}

function diffSecurity(col: Collector, op: IROperation, bOp: IROperation, tOp: IROperation): void {
  const bAlts = normAlts(bOp.security), tAlts = normAlts(tOp.security);
  if (stableStringify(bAlts.map(altSig).sort()) === stableStringify(tAlts.map(altSig).sort())) return;
  const unsatisfied = bAlts.filter((b) => !tAlts.some((t) => satisfies(b, t)));
  const loc = 'security';
  const old = bOp.security, nu = tOp.security;
  if (unsatisfied.length === 0) {
    col.emit('CG-SEC-002', { op, location: loc }, { basePointer: bOp.pointer, targetPointer: tOp.pointer, oldValue: old, newValue: nu, discriminator: 'relaxed',
      summary: 'Security requirements were removed or relaxed.', evidence: `Base: ${JSON.stringify(old)}; target: ${JSON.stringify(nu)}.` });
    return;
  }
  const names = (alts: IRSecurityAlternative[]) => new Set(alts.flatMap((a) => Object.keys(a)));
  const bn = names(bAlts), tn = names(tAlts);
  const disjoint = bn.size > 0 && tn.size > 0 && [...bn].every((n) => !tn.has(n));
  col.emit(disjoint && unsatisfied.length === bAlts.length ? 'CG-SEC-003' : 'CG-SEC-001', { op, location: loc }, { basePointer: bOp.pointer, targetPointer: tOp.pointer, oldValue: old, newValue: nu, discriminator: 'stricter',
    summary: disjoint ? 'The authentication scheme changed.' : 'A new or stricter security requirement was introduced.',
    evidence: `Base: ${JSON.stringify(old)}; target: ${JSON.stringify(nu)}. ${unsatisfied.length} base alternative(s) can no longer authenticate.` });
}

function diffSecuritySchemes(col: Collector, base: ApiContractIR, target: ApiContractIR): void {
  const used = new Set(Object.values(base.operations).flatMap((o) => o.security.flatMap((a) => Object.keys(a))));
  for (const name of [...used].sort()) {
    const b = base.securitySchemes[name], t = target.securitySchemes[name];
    if (!b || !t) continue;
    const bs = [b.type, b.scheme, b.in, b.paramName].join('|'), ts = [t.type, t.scheme, t.in, t.paramName].join('|');
    if (bs !== ts) col.emit('CG-SEC-003', { location: `components.securitySchemes[${name}]` }, { basePointer: b.pointer, targetPointer: t.pointer,
      oldValue: { type: b.type, scheme: b.scheme, in: b.in, name: b.paramName }, newValue: { type: t.type, scheme: t.scheme, in: t.in, name: t.paramName }, discriminator: name,
      summary: `Security scheme "${name}" changed definition.`, evidence: `${bs} -> ${ts}` }, { path: `components.securitySchemes.${name}` });
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export function compare(base: ApiContractIR, target: ApiContractIR, options: CompareOptions = {}): ComparisonResult {
  const policy: Policy = { ...DEFAULT_POLICY, ...options.policy };
  const col = new Collector(policy.profile);

  const group = (ir: ApiContractIR) => {
    const m = new Map<string, IROperation[]>();
    for (const op of Object.values(ir.operations)) (m.get(op.normalizedPath) ?? m.set(op.normalizedPath, []).get(op.normalizedPath)!).push(op);
    return m;
  };
  const bPaths = group(base), tPaths = group(target);
  let removedOps = 0, addedOps = 0;

  for (const [np, bOps] of [...bPaths].sort(([a], [b]) => a.localeCompare(b))) {
    if (!tPaths.has(np)) {
      removedOps += bOps.length;
      const first = bOps[0]!;
      col.emit('CG-PATH-001', { location: 'path' }, { basePointer: first.pointer.replace(/\/[^/]+$/, ''), oldValue: bOps.map((o) => o.method.toUpperCase()), discriminator: np,
        summary: `Endpoint ${first.path} was removed (${bOps.map((o) => o.method.toUpperCase()).join(', ')}).`, evidence: `Path ${first.path} exists in base but no operations exist for it in target.` },
        { path: first.path });
    }
  }
  for (const key of [...new Set([...Object.keys(base.operations), ...Object.keys(target.operations)])].sort()) {
    const b = base.operations[key], t = target.operations[key];
    if (b && !t) {
      if (tPaths.has(b.normalizedPath)) {
        removedOps++;
        col.emit('CG-OP-001', { op: b, location: 'operation' }, { basePointer: b.pointer, oldValue: key, discriminator: 'removed',
          summary: `${b.method.toUpperCase()} ${b.path} was removed.`, evidence: `Path still exists in target, but not with method ${b.method.toUpperCase()}.` });
      }
      continue;
    }
    if (!b && t) {
      addedOps++;
      col.emit('CG-OP-003', { op: t, location: 'operation' }, { targetPointer: t.pointer, newValue: key, discriminator: 'added',
        summary: `${t.method.toUpperCase()} ${t.path} was added.`, evidence: 'Absent in base, present in target.' });
      continue;
    }
    if (!b || !t) continue;
    const op = t;
    if (b.operationId !== t.operationId && b.operationId) {
      col.emit('CG-OP-002', { op, location: 'operation' }, { basePointer: b.pointer, targetPointer: t.pointer, oldValue: b.operationId, newValue: t.operationId, discriminator: 'operationId',
        summary: `operationId changed from "${b.operationId}" to "${t.operationId ?? '(none)'}".`, evidence: `operationId: ${b.operationId} -> ${t.operationId ?? '(none)'}` });
    }
    if (b.deprecated !== t.deprecated) {
      col.emit(t.deprecated ? 'CG-OP-004' : 'CG-OP-005', { op, location: 'operation' }, { basePointer: b.pointer, targetPointer: t.pointer, oldValue: b.deprecated, newValue: t.deprecated, discriminator: 'deprecated',
        summary: t.deprecated ? `${t.method.toUpperCase()} ${t.path} is now deprecated.` : `${t.method.toUpperCase()} ${t.path} is no longer deprecated.`, evidence: `deprecated: ${b.deprecated} -> ${t.deprecated}` });
    }
    diffParameters(col, op, b, t);
    diffRequestBody(col, op, b, t);
    diffResponses(col, op, b, t);
    diffSecurity(col, op, b, t);
  }
  diffSecuritySchemes(col, base, target);

  if (stableStringify(base.servers) !== stableStringify(target.servers)) {
    col.emit('CG-INFO-002', { location: 'servers' }, { oldValue: base.servers, newValue: target.servers, discriminator: 'servers',
      summary: 'Server URLs changed.', evidence: `Base: ${JSON.stringify(base.servers)}; target: ${JSON.stringify(target.servers)}.` }, { path: 'servers' });
  }

  // Deterministic ordering and de-duplication by ID.
  const seen = new Set<string>();
  const sorted = col.findings
    .filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)))
    .sort((a, b) =>
      CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]
      || (a.path ?? '').localeCompare(b.path ?? '') || (a.method ?? '').localeCompare(b.method ?? '')
      || a.location.localeCompare(b.location) || a.schemaPath.localeCompare(b.schemaPath)
      || a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id));

  const now = options.now ?? new Date();
  const { findings, result, summary } = evaluatePolicy(sorted, policy, now);
  summary.operations = { base: Object.keys(base.operations).length, target: Object.keys(target.operations).length, added: addedOps, removed: removedOps };

  return {
    engineVersion: ENGINE_VERSION, irVersion: IR_VERSION, generatedAt: now.toISOString(),
    base: { title: base.info.title, version: base.info.version, openapi: base.openapi },
    target: { title: target.info.title, version: target.info.version, openapi: target.openapi },
    policy, result, summary, findings,
    unsupported: [
      ...base.unsupported.map((u) => ({ side: 'base' as const, ...u })),
      ...target.unsupported.map((u) => ({ side: 'target' as const, ...u })),
    ],
  };
}

export type { Category };
