/**
 * Normalized intermediate representation (IR) of an API contract.
 * Everything here is plain JSON-serializable data. `pointer` fields are JSON
 * Pointers (RFC 6901 fragments, e.g. "#/paths/~1pets/get") into the ORIGINAL
 * source document, so findings can be traced back to the specification.
 */
export const IR_VERSION = '1';
export const PARSER_VERSION = '0.1.0';

export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';
export const HTTP_METHODS: readonly HttpMethod[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export interface SchemaConstraints {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  maxProperties?: number;
  pattern?: string;
  uniqueItems?: boolean;
}

export interface IRSchema {
  pointer: string;
  /** Sorted set of types. `null` is included for nullable schemas. Undefined = unconstrained/unknown. */
  types?: JsonType[];
  format?: string;
  enum?: unknown[];
  default?: unknown;
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  constraints: SchemaConstraints;
  properties?: Record<string, IRSchema>;
  /** Sorted names of required properties (after allOf merge). */
  required?: string[];
  items?: IRSchema;
  /** True when additionalProperties is true or a schema; false when explicitly false. Not deeply compared. */
  additionalProperties?: boolean;
  /** oneOf/anyOf alternatives. Compared by canonical signature only. */
  variants?: { kind: 'oneOf' | 'anyOf'; items: IRSchema[] };
  /** Set when this node is a cut-off reference to a recursive schema. */
  circularRef?: string;
  /** Names of $refs this schema was resolved through (informational). */
  refName?: string;
  /** True when allOf was merged into this node. */
  merged?: boolean;
}

export interface IRParameter {
  /** Stable matching key: "<in>:<name>", or "path:#<index>" for path params (rename-tolerant). */
  key: string;
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  required: boolean;
  deprecated: boolean;
  style: string;
  explode: boolean;
  schema?: IRSchema;
  pointer: string;
}

export interface IRMediaType { mediaType: string; schema?: IRSchema; pointer: string }
export interface IRRequestBody { required: boolean; content: Record<string, IRMediaType>; pointer: string }
export interface IRHeader { name: string; required: boolean; schema?: IRSchema; pointer: string }
export interface IRResponse {
  status: string;
  content: Record<string, IRMediaType>;
  headers: Record<string, IRHeader>;
  pointer: string;
}

/** One alternative of a security requirement: scheme name -> sorted scopes. */
export type IRSecurityAlternative = Record<string, string[]>;

export interface IROperation {
  key: string; // "GET /pets/{}"
  method: HttpMethod;
  path: string; // original path template
  normalizedPath: string;
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated: boolean;
  parameters: Record<string, IRParameter>;
  requestBody?: IRRequestBody;
  responses: Record<string, IRResponse>;
  /** Effective security (operation-level overrides global). [] = explicitly none/anonymous. */
  security: IRSecurityAlternative[];
  pointer: string;
}

export interface IRSecurityScheme {
  name: string;
  type: string;
  scheme?: string;
  bearerFormat?: string;
  in?: string;
  paramName?: string;
  pointer: string;
}

export interface UnsupportedConstruct { construct: string; pointer: string; detail?: string }

export interface ApiContractIR {
  irVersion: string;
  parserVersion: string;
  openapi: string; // e.g. "3.0.3"
  info: { title: string; version: string; description?: string };
  servers: string[];
  operations: Record<string, IROperation>;
  securitySchemes: Record<string, IRSecurityScheme>;
  /** Constructs that were present but NOT analyzed. Never silently dropped. */
  unsupported: UnsupportedConstruct[];
}
