import { createHash } from 'node:crypto';
import { LineCounter, isMap, isSeq, parseDocument, type Document } from 'yaml';
import {
  HTTP_METHODS, IR_VERSION, PARSER_VERSION,
  type ApiContractIR, type HttpMethod, type IRHeader, type IRMediaType, type IROperation, type IRParameter,
  type IRRequestBody, type IRResponse, type IRSchema, type IRSecurityAlternative, type IRSecurityScheme,
  type JsonType, type SchemaConstraints, type UnsupportedConstruct,
} from './ir.ts';

export interface ParseIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  pointer?: string;
  line?: number;
}

export interface ParseOptions {
  /** Maximum accepted source size in bytes. Default 5 MiB. */
  maxBytes?: number;
  /** Maximum $ref / nesting depth. Default 64. */
  maxDepth?: number;
}

export interface ParseResult {
  ok: boolean;
  checksum: string; // sha256 hex of the original source bytes
  sizeBytes: number;
  ir?: ApiContractIR;
  issues: ParseIssue[];
  /** Resolve a JSON pointer ("#/paths/...") to a 1-based line number in the source, if known. */
  locate: (pointer: string) => number | undefined;
}

const MAX_BYTES = 5 * 1024 * 1024;
const TYPE_ORDER: JsonType[] = ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'];
const KNOWN_TYPES = new Set<string>(TYPE_ORDER);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const escapePointer = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');
export const unescapePointer = (s: string): string => s.replace(/~1/g, '/').replace(/~0/g, '~');
const ptr = (base: string, ...parts: Array<string | number>): string =>
  base + parts.map((p) => '/' + escapePointer(String(p))).join('');

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable JSON: object keys sorted, used for sorting enums and signatures. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (isObj(v)) {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

export function parseOpenApi(source: string, options: ParseOptions = {}): ParseResult {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const maxDepth = options.maxDepth ?? 64;
  const sizeBytes = Buffer.byteLength(source, 'utf8');
  const checksum = sha256(source);
  const issues: ParseIssue[] = [];
  const noLocate = () => undefined;
  const fail = (code: string, message: string, pointer?: string): ParseResult => {
    issues.push({ severity: 'error', code, message, pointer });
    return { ok: false, checksum, sizeBytes, issues, locate: noLocate };
  };

  if (sizeBytes > maxBytes) return fail('TOO_LARGE', `Specification is ${sizeBytes} bytes; the limit is ${maxBytes}.`);
  if (source.trim() === '') return fail('EMPTY', 'The specification is empty.');
  if (source.includes('\u0000')) return fail('INVALID_CONTENT', 'The specification contains NUL bytes and does not look like text.');

  const lineCounter = new LineCounter();
  let doc: Document;
  try {
    // YAML is a superset of JSON, so one parser handles both. maxAliasCount blocks alias-expansion bombs.
    doc = parseDocument(source, { lineCounter, uniqueKeys: true, prettyErrors: false });
  } catch (e) {
    return fail('INVALID_SYNTAX', `Could not parse as JSON or YAML: ${(e as Error).message}`);
  }
  for (const err of doc.errors) {
    const line = err.linePos?.[0]?.line;
    issues.push({ severity: 'error', code: 'INVALID_SYNTAX', message: `${err.message.split('\n')[0]}`, line });
  }
  if (doc.errors.length > 0) return { ok: false, checksum, sizeBytes, issues, locate: noLocate };

  const locate = (pointer: string): number | undefined => {
    if (!pointer.startsWith('#')) return undefined;
    const parts = pointer.slice(1).split('/').slice(1).map(unescapePointer);
    const lineOf = (node: unknown): number | undefined => {
      const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
      return range ? lineCounter.linePos(range[0]).line : undefined;
    };
    // Walk as far as the pointer exists; fall back to the deepest existing ancestor.
    // Prefer the line of the KEY (where a human would look), not the first line of its value.
    for (let n = parts.length; n > 0; n--) {
      const parent = doc.getIn(parts.slice(0, n - 1), true);
      const last = parts[n - 1]!;
      if (isMap(parent)) {
        const pair = parent.items.find((it) => String((it.key as { value?: unknown } | null)?.value ?? it.key) === last);
        const line = lineOf(pair?.key);
        if (line !== undefined) return line;
      } else if (isSeq(parent)) {
        const line = lineOf(parent.items[Number(last)]);
        if (line !== undefined) return line;
      }
    }
    return 1;
  };
  const addIssue = (severity: 'error' | 'warning', code: string, message: string, pointer?: string) =>
    issues.push({ severity, code, message, pointer, line: pointer ? locate(pointer) : undefined });

  let root: unknown;
  try {
    root = doc.toJS({ maxAliasCount: 100 }); // blocks alias-expansion ("billion laughs") documents
  } catch (e) {
    addIssue('error', 'INVALID_CONTENT', `Rejected: ${(e as Error).message}`);
    return { ok: false, checksum, sizeBytes, issues, locate };
  }
  if (!isObj(root)) {
    addIssue('error', 'NOT_OPENAPI', 'The document root must be an object.');
    return { ok: false, checksum, sizeBytes, issues, locate };
  }

  // ---- version / structure validation -------------------------------------------------
  const version = root.openapi;
  if (typeof version !== 'string') {
    addIssue('error', root.swagger ? 'UNSUPPORTED_VERSION' : 'NOT_OPENAPI',
      root.swagger
        ? `Swagger ${String(root.swagger)} is not supported. Only OpenAPI 3.0.x and 3.1.x are supported.`
        : 'Missing required "openapi" version field. This does not look like an OpenAPI 3.x document.', '#/openapi');
    return { ok: false, checksum, sizeBytes, issues, locate };
  }
  const is31 = /^3\.1\.\d+/.test(version);
  const is30 = /^3\.0\.\d+/.test(version);
  if (!is30 && !is31) {
    addIssue('error', 'UNSUPPORTED_VERSION', `OpenAPI version "${version}" is not supported. Supported: 3.0.x, 3.1.x.`, '#/openapi');
    return { ok: false, checksum, sizeBytes, issues, locate };
  }
  const info = root.info;
  if (!isObj(info) || typeof info.title !== 'string' || typeof info.version !== 'string' && typeof info.version !== 'number') {
    addIssue('error', 'MISSING_INFO', 'The "info" object must contain a string "title" and a "version".', '#/info');
  }
  const paths = root.paths;
  if (paths !== undefined && !isObj(paths)) addIssue('error', 'INVALID_PATHS', '"paths" must be an object.', '#/paths');
  if (paths === undefined && !(is31 && (root.webhooks || root.components))) {
    addIssue('error', 'MISSING_PATHS', 'Missing required "paths" object.', '#/paths');
  }
  if (issues.some((i) => i.severity === 'error')) return { ok: false, checksum, sizeBytes, issues, locate };

  const unsupported: UnsupportedConstruct[] = [];
  const noteUnsupported = (construct: string, pointer: string, detail?: string) => {
    if (!unsupported.some((u) => u.construct === construct && u.pointer === pointer)) unsupported.push({ construct, pointer, detail });
  };
  if (root.webhooks) noteUnsupported('webhooks', '#/webhooks', 'Webhook operations are not compared.');

  // ---- $ref resolution (local only) -----------------------------------------------------
  const resolvePointer = (ref: string): { value: unknown; pointer: string } | undefined => {
    if (!ref.startsWith('#')) return undefined;
    let cur: unknown = root;
    const parts = ref.slice(1).split('/').slice(1).map(unescapePointer);
    for (const p of parts) {
      if (Array.isArray(cur)) cur = cur[Number(p)];
      else if (isObj(cur)) cur = Object.prototype.hasOwnProperty.call(cur, p) ? cur[p] : undefined;
      else return undefined;
      if (cur === undefined) return undefined;
    }
    return { value: cur, pointer: ref };
  };

  /** Follow a chain of $ref objects (non-schema contexts). Returns the final object and its pointer. */
  const deref = (node: unknown, pointer: string, seen: string[] = []): { value: Obj; pointer: string } | undefined => {
    if (!isObj(node)) return undefined;
    if (typeof node.$ref !== 'string') return { value: node, pointer };
    const ref = node.$ref;
    if (!ref.startsWith('#')) {
      noteUnsupported('external-ref', pointer, `External reference "${ref}" was not fetched or analyzed.`);
      addIssue('warning', 'EXTERNAL_REF_NOT_RESOLVED', `External $ref "${ref}" is not resolved (external references are disabled).`, pointer);
      return undefined;
    }
    if (seen.includes(ref) || seen.length > maxDepth) {
      addIssue('warning', 'CIRCULAR_REF', `Circular $ref chain at "${ref}".`, pointer);
      return undefined;
    }
    const target = resolvePointer(ref);
    if (!target) {
      addIssue('error', 'UNRESOLVED_REF', `Cannot resolve $ref "${ref}".`, pointer);
      return undefined;
    }
    return deref(target.value, target.pointer, [...seen, ref]);
  };

  // ---- schema normalization ---------------------------------------------------------------
  const UNSUPPORTED_SCHEMA_KEYS = ['not', 'discriminator', 'patternProperties', 'if', 'then', 'else', 'prefixItems', '$dynamicRef', 'dependentSchemas', 'unevaluatedProperties'];

  const normType = (raw: unknown, nullable: boolean): JsonType[] | undefined => {
    let list: string[] = [];
    if (typeof raw === 'string') list = [raw];
    else if (Array.isArray(raw)) list = raw.filter((x): x is string => typeof x === 'string');
    const types = new Set<JsonType>(list.filter((t): t is JsonType => KNOWN_TYPES.has(t)));
    if (nullable) types.add('null');
    if (types.size === 0) return undefined;
    return TYPE_ORDER.filter((t) => types.has(t));
  };

  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

  const normSchema = (node: unknown, pointer: string, stack: string[], depth: number): IRSchema | undefined => {
    if (depth > maxDepth) {
      addIssue('warning', 'MAX_DEPTH', `Schema nesting exceeds ${maxDepth}; deeper levels are not analyzed.`, pointer);
      noteUnsupported('max-depth', pointer);
      return undefined;
    }
    if (node === true || node === false) return { pointer, constraints: {} };
    if (!isObj(node)) return undefined;

    let refName: string | undefined;
    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (!ref.startsWith('#')) {
        noteUnsupported('external-ref', pointer, `External reference "${ref}" was not fetched or analyzed.`);
        addIssue('warning', 'EXTERNAL_REF_NOT_RESOLVED', `External $ref "${ref}" is not resolved (external references are disabled).`, pointer);
        return { pointer, constraints: {}, circularRef: `external:${ref}` };
      }
      if (stack.includes(ref)) return { pointer: ref, constraints: {}, circularRef: ref };
      const target = resolvePointer(ref);
      if (!target) {
        addIssue('error', 'UNRESOLVED_REF', `Cannot resolve $ref "${ref}".`, pointer);
        return undefined;
      }
      const resolved = normSchema(target.value, ref, [...stack, ref], depth + 1);
      if (resolved) resolved.refName = ref.split('/').pop();
      return resolved;
    }

    for (const k of UNSUPPORTED_SCHEMA_KEYS) if (k in node) noteUnsupported(`schema.${k}`, pointer, `"${k}" is present but not analyzed.`);

    const nullable = is30 && node.nullable === true;
    const out: IRSchema = { pointer, constraints: {}, refName };
    let types = normType(node.type, nullable);
    if (node.const !== undefined && node.enum === undefined) out.enum = [node.const];
    if (Array.isArray(node.enum)) out.enum = [...node.enum].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
    if (typeof node.format === 'string') out.format = node.format;
    if (node.default !== undefined) out.default = node.default;
    if (node.readOnly === true) out.readOnly = true;
    if (node.writeOnly === true) out.writeOnly = true;
    if (node.deprecated === true) out.deprecated = true;

    const c: SchemaConstraints = {};
    const set = <K extends keyof SchemaConstraints>(k: K, v: SchemaConstraints[K] | undefined) => { if (v !== undefined) c[k] = v; };
    set('minimum', num(node.minimum)); set('maximum', num(node.maximum));
    if (is30) {
      if (node.exclusiveMinimum === true) set('exclusiveMinimum', num(node.minimum));
      if (node.exclusiveMaximum === true) set('exclusiveMaximum', num(node.maximum));
      if (node.exclusiveMinimum === true) delete c.minimum;
      if (node.exclusiveMaximum === true) delete c.maximum;
    } else {
      set('exclusiveMinimum', num(node.exclusiveMinimum)); set('exclusiveMaximum', num(node.exclusiveMaximum));
    }
    set('minLength', num(node.minLength)); set('maxLength', num(node.maxLength));
    set('minItems', num(node.minItems)); set('maxItems', num(node.maxItems));
    set('minProperties', num(node.minProperties)); set('maxProperties', num(node.maxProperties));
    if (typeof node.pattern === 'string') c.pattern = node.pattern;
    if (node.uniqueItems === true) c.uniqueItems = true;
    out.constraints = c;

    const required = new Set<string>(Array.isArray(node.required) ? node.required.filter((x): x is string => typeof x === 'string') : []);
    const props: Record<string, IRSchema> = {};
    if (isObj(node.properties)) {
      for (const [name, sub] of Object.entries(node.properties)) {
        const s = normSchema(sub, ptr(pointer, 'properties', name), stack, depth + 1);
        if (s) props[name] = s;
      }
    }

    // allOf: merge into this node (properties/required union, later parts win on conflicts).
    if (Array.isArray(node.allOf)) {
      out.merged = true;
      node.allOf.forEach((part, i) => {
        const s = normSchema(part, ptr(pointer, 'allOf', i), stack, depth + 1);
        if (!s) return;
        if (s.circularRef && !s.properties) { out.circularRef = s.circularRef; return; }
        if (s.types) types = types ? TYPE_ORDER.filter((t) => types!.includes(t) || s.types!.includes(t)) : s.types;
        if (s.properties) Object.assign(props, { ...s.properties, ...props });
        s.required?.forEach((r) => required.add(r));
        if (s.enum && !out.enum) out.enum = s.enum;
        if (s.format && !out.format) out.format = s.format;
        if (s.items && !out.items) out.items = s.items;
        if (s.variants && !out.variants) out.variants = s.variants;
        out.constraints = { ...s.constraints, ...out.constraints };
        if (s.readOnly) out.readOnly = true;
        if (s.writeOnly) out.writeOnly = true;
      });
    }

    for (const kind of ['oneOf', 'anyOf'] as const) {
      const list = node[kind];
      if (Array.isArray(list)) {
        const items = list.map((v, i) => normSchema(v, ptr(pointer, kind, i), stack, depth + 1)).filter((x): x is IRSchema => !!x);
        out.variants = { kind, items };
      }
    }

    if (!types) {
      if (Object.keys(props).length > 0 || isObj(node.properties)) types = ['object'];
      else if (node.items !== undefined) types = ['array'];
    }
    if (types) out.types = types;
    if (Object.keys(props).length > 0) out.properties = props;
    if (required.size > 0) out.required = [...required].sort();
    if (node.items !== undefined) {
      const items = normSchema(node.items, ptr(pointer, 'items'), stack, depth + 1);
      if (items) out.items = items;
    }
    if (typeof node.additionalProperties === 'boolean') out.additionalProperties = node.additionalProperties;
    else if (isObj(node.additionalProperties)) out.additionalProperties = true;
    return out;
  };

  // ---- operations ------------------------------------------------------------------------
  const normMediaType = (mt: string) => mt.split(';')[0]!.trim().toLowerCase();

  const normContent = (content: unknown, pointer: string): Record<string, IRMediaType> => {
    const out: Record<string, IRMediaType> = {};
    if (!isObj(content)) return out;
    for (const [mt, body] of Object.entries(content).sort(([a], [b]) => a.localeCompare(b))) {
      const bp = ptr(pointer, mt);
      const schemaNode = isObj(body) ? body.schema : undefined;
      const key = normMediaType(mt);
      out[key] = { mediaType: key, pointer: bp, schema: schemaNode === undefined ? undefined : normSchema(schemaNode, ptr(bp, 'schema'), [], 0) };
    }
    return out;
  };

  const normParam = (raw: unknown, pointer: string, templateParams: string[]): IRParameter | undefined => {
    const d = deref(raw, pointer);
    if (!d) return undefined;
    const p = d.value;
    const loc = p.in;
    if (typeof p.name !== 'string' || (loc !== 'query' && loc !== 'header' && loc !== 'path' && loc !== 'cookie')) {
      addIssue('warning', 'INVALID_PARAMETER', 'Parameter is missing a valid "name" or "in" and was ignored.', d.pointer);
      return undefined;
    }
    const idx = templateParams.indexOf(p.name);
    const key = loc === 'path' && idx >= 0 ? `path:#${idx}` : `${loc}:${loc === 'header' ? p.name.toLowerCase() : p.name}`;
    const style = typeof p.style === 'string' ? p.style : loc === 'query' || loc === 'cookie' ? 'form' : 'simple';
    const explode = typeof p.explode === 'boolean' ? p.explode : style === 'form';
    let schema: IRSchema | undefined;
    if (p.schema !== undefined) schema = normSchema(p.schema, ptr(d.pointer, 'schema'), [], 0);
    else if (isObj(p.content)) {
      noteUnsupported('parameter.content', d.pointer, 'Parameters described via "content" are analyzed by their first media type schema only.');
      const first = Object.entries(p.content)[0];
      if (first && isObj(first[1])) schema = normSchema(first[1].schema, ptr(d.pointer, 'content', first[0], 'schema'), [], 0);
    }
    return {
      key, name: p.name, in: loc, required: loc === 'path' ? true : p.required === true,
      deprecated: p.deprecated === true, style, explode, schema, pointer: d.pointer,
    };
  };

  const normResponse = (status: string, raw: unknown, pointer: string): IRResponse | undefined => {
    const d = deref(raw, pointer);
    if (!d) return undefined;
    const headers: Record<string, IRHeader> = {};
    if (isObj(d.value.headers)) {
      for (const [name, h] of Object.entries(d.value.headers)) {
        const hd = deref(h, ptr(d.pointer, 'headers', name));
        if (!hd) continue;
        const lower = name.toLowerCase();
        if (lower === 'content-type') continue; // governed by media types
        headers[lower] = {
          name, required: hd.value.required === true, pointer: hd.pointer,
          schema: hd.value.schema === undefined ? undefined : normSchema(hd.value.schema, ptr(hd.pointer, 'schema'), [], 0),
        };
      }
    }
    if (isObj(d.value.links)) noteUnsupported('response.links', d.pointer, 'Links are not compared.');
    return { status: status.toUpperCase(), content: normContent(d.value.content, ptr(d.pointer, 'content')), headers, pointer: d.pointer };
  };

  const normSecurity = (raw: unknown): IRSecurityAlternative[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    return raw.filter(isObj).map((alt) => {
      const o: IRSecurityAlternative = {};
      for (const name of Object.keys(alt).sort()) {
        const scopes = alt[name];
        o[name] = Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string').sort() : [];
      }
      return o;
    }).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  };
  const globalSecurity = normSecurity(root.security) ?? [];

  const operations: Record<string, IROperation> = {};
  const seenOperationIds = new Map<string, string>();
  const pathItems = isObj(paths) ? paths : {};
  for (const path of Object.keys(pathItems).sort()) {
    const pp = ptr('#/paths', path);
    if (!path.startsWith('/')) addIssue('error', 'INVALID_PATH', `Path "${path}" must start with "/".`, pp);
    const item = deref(pathItems[path], pp);
    if (!item) continue;
    const templateParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    const normalizedPath = path.replace(/\{[^}]+\}/g, '{}');
    const sharedParams = Array.isArray(item.value.parameters) ? item.value.parameters : [];
    for (const method of HTTP_METHODS) {
      const rawOp = item.value[method];
      if (rawOp === undefined) continue;
      const opPtr = ptr(item.pointer, method);
      if (!isObj(rawOp)) { addIssue('error', 'INVALID_OPERATION', `Operation ${method.toUpperCase()} ${path} must be an object.`, opPtr); continue; }

      const parameters: Record<string, IRParameter> = {};
      sharedParams.forEach((p, i) => {
        const np = normParam(p, ptr(item.pointer, 'parameters', i), templateParams);
        if (np) parameters[np.key] = np;
      });
      if (Array.isArray(rawOp.parameters)) {
        rawOp.parameters.forEach((p, i) => {
          const np = normParam(p, ptr(opPtr, 'parameters', i), templateParams);
          if (np) parameters[np.key] = np; // operation-level overrides path-level
        });
      }
      for (const name of templateParams) {
        if (!Object.values(parameters).some((p) => p.in === 'path' && p.name === name)) {
          addIssue('warning', 'MISSING_PATH_PARAMETER', `Path "${path}" uses {${name}} but ${method.toUpperCase()} declares no matching path parameter.`, opPtr);
        }
      }

      let requestBody: IRRequestBody | undefined;
      if (rawOp.requestBody !== undefined) {
        const rb = deref(rawOp.requestBody, ptr(opPtr, 'requestBody'));
        if (rb) requestBody = { required: rb.value.required === true, content: normContent(rb.value.content, ptr(rb.pointer, 'content')), pointer: rb.pointer };
      }

      const responses: Record<string, IRResponse> = {};
      if (isObj(rawOp.responses)) {
        for (const [status, r] of Object.entries(rawOp.responses).sort(([a], [b]) => a.localeCompare(b))) {
          const nr = normResponse(status, r, ptr(opPtr, 'responses', status));
          if (nr) responses[nr.status] = nr;
        }
      }
      if (rawOp.callbacks) noteUnsupported('operation.callbacks', opPtr, 'Callbacks are not compared.');

      const operationId = typeof rawOp.operationId === 'string' ? rawOp.operationId : undefined;
      if (operationId) {
        const prev = seenOperationIds.get(operationId);
        if (prev) addIssue('warning', 'DUPLICATE_OPERATION_ID', `operationId "${operationId}" is also used at ${prev}.`, opPtr);
        else seenOperationIds.set(operationId, opPtr);
      }

      const key = `${method.toUpperCase()} ${normalizedPath}`;
      if (operations[key]) addIssue('warning', 'AMBIGUOUS_PATH', `"${method.toUpperCase()} ${path}" is equivalent to another templated path; only the first is analyzed.`, opPtr);
      else operations[key] = {
        key, method: method as HttpMethod, path, normalizedPath, operationId,
        summary: typeof rawOp.summary === 'string' ? rawOp.summary : undefined,
        description: typeof rawOp.description === 'string' ? rawOp.description : undefined,
        deprecated: rawOp.deprecated === true,
        parameters, requestBody, responses,
        security: normSecurity(rawOp.security) ?? globalSecurity,
        pointer: opPtr,
      };
    }
  }

  const securitySchemes: Record<string, IRSecurityScheme> = {};
  const compSchemes = isObj(root.components) && isObj(root.components.securitySchemes) ? root.components.securitySchemes : {};
  for (const name of Object.keys(compSchemes).sort()) {
    const d = deref(compSchemes[name], ptr('#/components/securitySchemes', name));
    if (!d || typeof d.value.type !== 'string') continue;
    securitySchemes[name] = {
      name, type: d.value.type, pointer: d.pointer,
      scheme: typeof d.value.scheme === 'string' ? d.value.scheme.toLowerCase() : undefined,
      bearerFormat: typeof d.value.bearerFormat === 'string' ? d.value.bearerFormat : undefined,
      in: typeof d.value.in === 'string' ? d.value.in : undefined,
      paramName: typeof d.value.name === 'string' ? d.value.name : undefined,
    };
  }

  const servers = Array.isArray(root.servers)
    ? root.servers.filter(isObj).map((s) => String(s.url ?? '')).filter(Boolean).sort() : [];

  if (issues.some((i) => i.severity === 'error')) return { ok: false, checksum, sizeBytes, issues, locate };

  const infoObj = info as Obj;
  const ir: ApiContractIR = {
    irVersion: IR_VERSION, parserVersion: PARSER_VERSION, openapi: version,
    info: { title: String(infoObj.title), version: String(infoObj.version), description: typeof infoObj.description === 'string' ? infoObj.description : undefined },
    servers, operations, securitySchemes, unsupported,
  };
  return { ok: true, checksum, sizeBytes, ir, issues, locate };
}
