import type { Category, Profile, Severity } from './types.ts';

export interface RuleDef {
  id: string;
  title: string;
  /** Category per compatibility profile. */
  categories: Record<Profile, Category>;
  severity: Severity;
  /** Documented compatibility semantics behind the classification. */
  rationale: string;
  recommendation: string;
}

const B: Category = 'BREAKING';
const P: Category = 'POTENTIALLY_BREAKING';
const N: Category = 'NON_BREAKING';
const I: Category = 'INFORMATIONAL';
const c = (conservative: Category, standard: Category, permissive: Category) => ({ conservative, standard, permissive });

const defs: RuleDef[] = [
  // ---- paths & operations
  { id: 'CG-PATH-001', title: 'Endpoint removed', categories: c(B, B, B), severity: 'critical',
    rationale: 'Clients calling a removed path receive 404/405.', recommendation: 'Restore the endpoint, or deprecate it first and remove it in a later major version.' },
  { id: 'CG-OP-001', title: 'HTTP method removed', categories: c(B, B, B), severity: 'critical',
    rationale: 'Clients using the removed method on an existing path will fail.', recommendation: 'Restore the method, or deprecate it and give consumers a migration window.' },
  { id: 'CG-OP-002', title: 'operationId changed', categories: c(B, P, I), severity: 'medium',
    rationale: 'operationId is not part of the wire protocol, but generated SDKs and tooling key off it.', recommendation: 'Keep operationId stable, or announce the rename to SDK consumers.' },
  { id: 'CG-OP-003', title: 'Operation added', categories: c(N, N, N), severity: 'low',
    rationale: 'New operations cannot affect existing clients.', recommendation: 'No action required.' },
  { id: 'CG-OP-004', title: 'Operation deprecated', categories: c(P, I, I), severity: 'info',
    rationale: 'Deprecation signals future removal but does not change behavior.', recommendation: 'Communicate a removal timeline and replacement to consumers.' },
  { id: 'CG-OP-005', title: 'Operation no longer deprecated', categories: c(I, I, I), severity: 'info',
    rationale: 'Informational.', recommendation: 'No action required.' },
  // ---- parameters
  { id: 'CG-PARAM-001', title: 'Required parameter removed', categories: c(B, P, P), severity: 'medium',
    rationale: 'Clients that still send the parameter may be rejected (strict servers) or ignored. Removing a parameter changes the contract clients were built against.', recommendation: 'Keep accepting the parameter (ignore it) until consumers have migrated.' },
  { id: 'CG-PARAM-002', title: 'Optional parameter became required', categories: c(B, B, B), severity: 'high',
    rationale: 'Clients that omit the parameter will now be rejected.', recommendation: 'Keep the parameter optional with a default, or version the endpoint.' },
  { id: 'CG-PARAM-003', title: 'Parameter type or format changed', categories: c(B, B, P), severity: 'high',
    rationale: 'Values valid under the old type may be rejected by the new one.', recommendation: 'Accept both representations, or introduce a new parameter.' },
  { id: 'CG-PARAM-004', title: 'Parameter location changed', categories: c(B, B, B), severity: 'high',
    rationale: 'Clients send the value in the old location (query/header/path/cookie), which the server no longer reads.', recommendation: 'Accept the parameter in both locations during a transition period.' },
  { id: 'CG-PARAM-005', title: 'Parameter serialization changed', categories: c(P, P, I), severity: 'medium',
    rationale: 'style/explode changes alter how arrays and objects are encoded on the wire.', recommendation: 'Confirm all consumers can emit the new encoding, or keep the old one.' },
  { id: 'CG-PARAM-006', title: 'Parameter schema narrowed', categories: c(B, B, P), severity: 'high',
    rationale: 'Values accepted before (enum values, ranges, lengths, patterns) are now rejected.', recommendation: 'Do not narrow accepted input within a version.' },
  { id: 'CG-PARAM-007', title: 'Optional parameter added', categories: c(N, N, N), severity: 'low',
    rationale: 'Existing clients do not send it and the server tolerates its absence.', recommendation: 'No action required.' },
  { id: 'CG-PARAM-008', title: 'Required parameter added', categories: c(B, B, B), severity: 'high',
    rationale: 'Existing clients do not send it and will be rejected.', recommendation: 'Make the parameter optional with a default, or version the endpoint.' },
  { id: 'CG-PARAM-009', title: 'Optional parameter removed', categories: c(P, I, I), severity: 'low',
    rationale: 'Clients may still send it; most servers ignore unknown optional parameters but behavior may differ.', recommendation: 'Keep accepting and ignoring the parameter until consumers migrate.' },
  { id: 'CG-PARAM-010', title: 'Parameter schema widened', categories: c(N, N, N), severity: 'low',
    rationale: 'The server accepts everything it accepted before and more.', recommendation: 'No action required.' },
  { id: 'CG-PARAM-011', title: 'Required parameter became optional', categories: c(N, N, N), severity: 'low',
    rationale: 'Clients that still send the parameter keep working.', recommendation: 'No action required.' },
  // ---- request body
  { id: 'CG-REQ-001', title: 'Request body became required', categories: c(B, B, B), severity: 'high',
    rationale: 'Clients that send no body will be rejected.', recommendation: 'Keep the body optional, or version the endpoint.' },
  { id: 'CG-REQ-002', title: 'Request media type removed', categories: c(B, B, B), severity: 'high',
    rationale: 'Clients sending the removed Content-Type receive 415.', recommendation: 'Keep accepting the media type during a transition period.' },
  { id: 'CG-REQ-003', title: 'Request media type added', categories: c(N, N, N), severity: 'low',
    rationale: 'Existing clients are unaffected.', recommendation: 'No action required.' },
  { id: 'CG-REQ-004', title: 'Request body became optional', categories: c(N, N, N), severity: 'low',
    rationale: 'Clients that send a body still work.', recommendation: 'No action required.' },
  { id: 'CG-REQ-010', title: 'Required request property added', categories: c(B, B, B), severity: 'high',
    rationale: 'Clients built against the old schema do not send it and will be rejected.', recommendation: 'Make the property optional with a server-side default.' },
  { id: 'CG-REQ-011', title: 'Request property removed', categories: c(B, P, I), severity: 'medium',
    rationale: 'Servers may tolerate or reject the extra property that clients still send; behavior is policy-dependent.', recommendation: 'Keep accepting the property (ignored) until consumers migrate.' },
  { id: 'CG-REQ-012', title: 'Request property type or format changed', categories: c(B, B, B), severity: 'high',
    rationale: 'Values valid under the old type are rejected by the new type.', recommendation: 'Accept both representations or add a new property.' },
  { id: 'CG-REQ-013', title: 'Request enum values removed', categories: c(B, B, B), severity: 'high',
    rationale: 'Clients sending a removed value will be rejected.', recommendation: 'Keep accepting removed values, mapping them server-side.' },
  { id: 'CG-REQ-014', title: 'Request schema constraints narrowed', categories: c(B, B, P), severity: 'high',
    rationale: 'Inputs that were previously valid (ranges, lengths, patterns) are now rejected.', recommendation: 'Do not tighten validation within a version.' },
  { id: 'CG-REQ-015', title: 'Optional request property added', categories: c(N, N, N), severity: 'low',
    rationale: 'Clients that omit it keep working.', recommendation: 'No action required.' },
  { id: 'CG-REQ-016', title: 'Request property became optional', categories: c(N, N, N), severity: 'low',
    rationale: 'Clients that still send it keep working.', recommendation: 'No action required.' },
  { id: 'CG-REQ-017', title: 'Request enum values added', categories: c(N, N, N), severity: 'low',
    rationale: 'The server accepts everything it accepted before.', recommendation: 'No action required.' },
  { id: 'CG-REQ-018', title: 'Request schema loosened', categories: c(N, N, N), severity: 'low',
    rationale: 'Types widened or constraints relaxed; previously valid input is still valid.', recommendation: 'No action required.' },
  { id: 'CG-REQ-019', title: 'Optional request property became required', categories: c(B, B, B), severity: 'high',
    rationale: 'Clients that omit it will be rejected.', recommendation: 'Keep the property optional with a default.' },
  { id: 'CG-REQ-020', title: 'Request schema alternatives changed', categories: c(B, P, P), severity: 'medium',
    rationale: 'oneOf/anyOf alternatives were removed (narrowing) or added; matching is by structural signature and is approximate.', recommendation: 'Review manually; variant analysis is only partially supported.' },
  // ---- responses
  { id: 'CG-RES-001', title: 'Success response removed', categories: c(B, B, B), severity: 'critical',
    rationale: 'Clients depend on a documented 2xx response that no longer exists.', recommendation: 'Restore the response or version the endpoint.' },
  { id: 'CG-RES-002', title: 'Non-success response removed', categories: c(P, I, I), severity: 'low',
    rationale: 'Error handling for the removed status may become dead code; clients are rarely broken.', recommendation: 'Confirm the server no longer returns this status.' },
  { id: 'CG-RES-003', title: 'Response media type removed', categories: c(B, B, B), severity: 'high',
    rationale: 'Clients that negotiate or parse the removed media type will fail.', recommendation: 'Keep serving the media type during a transition period.' },
  { id: 'CG-RES-004', title: 'Response added', categories: c(P, N, N), severity: 'low',
    rationale: 'Clients with strict status handling may not expect a new status code.', recommendation: 'Make sure consumers have a default handler for unknown statuses.' },
  { id: 'CG-RES-005', title: 'Response media type added', categories: c(N, N, N), severity: 'low',
    rationale: 'Existing clients keep receiving the media type they negotiated.', recommendation: 'No action required.' },
  { id: 'CG-RES-006', title: 'Response header removed', categories: c(B, P, I), severity: 'medium',
    rationale: 'Clients may read the header (pagination, rate-limit, etags).', recommendation: 'Keep sending the header until consumers migrate.' },
  { id: 'CG-RES-010', title: 'Required response property added', categories: c(P, N, N), severity: 'low',
    rationale: 'Policy choice: tolerant readers ignore unknown properties, so by default this is non-breaking. Strict-validating clients may reject unknown fields; the conservative profile flags it.', recommendation: 'Announce the new property to consumers that validate responses strictly.' },
  { id: 'CG-RES-011', title: 'Required response property removed', categories: c(B, B, B), severity: 'critical',
    rationale: 'Clients rely on a property that was guaranteed to be present.', recommendation: 'Keep returning the property or version the endpoint.' },
  { id: 'CG-RES-012', title: 'Optional response property removed', categories: c(B, P, P), severity: 'medium',
    rationale: 'Clients may still read the optional property when present.', recommendation: 'Keep returning the property until consumers migrate.' },
  { id: 'CG-RES-013', title: 'Response property type or format changed', categories: c(B, B, B), severity: 'critical',
    rationale: 'Clients deserialize the old type and may fail on the new one.', recommendation: 'Add a new property rather than changing the type of an existing one.' },
  { id: 'CG-RES-014', title: 'Response enum values added', categories: c(B, P, P), severity: 'medium',
    rationale: 'Clients with exhaustive enum handling may break on an unknown value.', recommendation: 'Ensure clients handle unknown enum values, and announce the new values.' },
  { id: 'CG-RES-015', title: 'Response enum values removed', categories: c(I, N, N), severity: 'low',
    rationale: 'The server returns a subset of the previous values, which clients already handle.', recommendation: 'No action required.' },
  { id: 'CG-RES-016', title: 'Response schema narrowed', categories: c(N, N, N), severity: 'low',
    rationale: 'Output is more constrained than before; clients that handled the old range still work.', recommendation: 'No action required.' },
  { id: 'CG-RES-017', title: 'Response schema loosened', categories: c(B, P, P), severity: 'medium',
    rationale: 'Clients may assume the old, tighter bounds (lengths, ranges, nullability, types).', recommendation: 'Confirm consumers do not depend on the previous constraints.' },
  { id: 'CG-RES-018', title: 'Optional response property added', categories: c(N, N, N), severity: 'low',
    rationale: 'Tolerant readers ignore new optional properties.', recommendation: 'No action required.' },
  { id: 'CG-RES-019', title: 'Response property became optional', categories: c(B, B, P), severity: 'high',
    rationale: 'Clients relied on the property always being present.', recommendation: 'Keep the property required or version the endpoint.' },
  { id: 'CG-RES-020', title: 'Response schema alternatives changed', categories: c(B, P, P), severity: 'medium',
    rationale: 'oneOf/anyOf alternatives were added (clients may not handle them) or removed; matching is approximate.', recommendation: 'Review manually; variant analysis is only partially supported.' },
  { id: 'CG-RES-021', title: 'Optional response property became required', categories: c(N, N, N), severity: 'low',
    rationale: 'The property is now guaranteed, which only helps clients.', recommendation: 'No action required.' },
  // ---- security
  { id: 'CG-SEC-001', title: 'New or stricter security requirement', categories: c(B, B, B), severity: 'critical',
    rationale: 'Clients that authenticate the old way are rejected.', recommendation: 'Roll out gradually and keep the old mechanism during a migration period.' },
  { id: 'CG-SEC-002', title: 'Security requirement removed or relaxed', categories: c(I, I, I), severity: 'medium',
    rationale: 'Clients keep working, but removing authentication is a security-relevant change that deserves review.', recommendation: 'Confirm the relaxation is intentional.' },
  { id: 'CG-SEC-003', title: 'Authentication scheme changed', categories: c(B, B, P), severity: 'critical',
    rationale: 'Clients use credentials of the previous scheme type.', recommendation: 'Support both schemes during a transition period.' },
  // ---- informational
  { id: 'CG-INFO-001', title: 'Default value changed', categories: c(P, I, I), severity: 'info',
    rationale: 'Clients that omit the value get different behavior.', recommendation: 'Confirm the new default is acceptable to existing consumers.' },
  { id: 'CG-INFO-002', title: 'Servers changed', categories: c(I, I, I), severity: 'info',
    rationale: 'Server URLs are deployment metadata.', recommendation: 'Confirm consumers are aware of new base URLs.' },
];

export const RULES: Readonly<Record<string, RuleDef>> = Object.freeze(Object.fromEntries(defs.map((d) => [d.id, d])));
export const RULE_IDS: readonly string[] = defs.map((d) => d.id);

export const CATEGORY_RANK: Record<Category, number> = { BREAKING: 0, POTENTIALLY_BREAKING: 1, NON_BREAKING: 2, INFORMATIONAL: 3 };
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
