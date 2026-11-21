export * from './types.ts';
export { RULES, RULE_IDS, CATEGORY_RANK, SEVERITY_RANK } from './rules.ts';
export type { RuleDef } from './rules.ts';
export { compare } from './engine.ts';
export type { CompareOptions } from './engine.ts';
export { evaluatePolicy, isSuppressionActive, DEFAULT_POLICY } from './policy.ts';
export { renderHtmlReport, renderCsv, renderJson, renderText, REPORT_LIMITATIONS } from './report.ts';
