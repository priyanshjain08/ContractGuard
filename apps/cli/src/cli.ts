#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseOpenApi, type ParseResult } from '@contractguard/openapi-parser';
import { compare, renderCsv, renderHtmlReport, renderJson, renderText, RULES, type Category, type Policy, type Profile } from '@contractguard/compatibility';

const USAGE = `contractguard - OpenAPI compatibility checker

Usage:
  contractguard compare <base> <target> [options]
  contractguard validate <spec>
  contractguard rules

Options (compare):
  --profile <conservative|standard|permissive>   default: standard
  --policy <file.json>      policy file (failOn, ruleOverrides, suppressions, ...)
  --fail-on-warnings        potentially breaking findings also fail
  --format <text|json|html|csv>                  default: text
  --out <file>              write report to a file instead of stdout

Exit codes: 0 pass / needs review, 1 check failed, 2 usage or specification error.
`;

const PROFILES = ['conservative', 'standard', 'permissive'];
const CATEGORIES = ['BREAKING', 'POTENTIALLY_BREAKING', 'NON_BREAKING', 'INFORMATIONAL'];

function die(msg: string): never { process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n'); process.exit(2); }

function load(file: string, label: string): ParseResult {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) { return die(`Cannot read ${label} "${file}": ${(e as Error).message}`); }
  const r = parseOpenApi(text);
  for (const i of r.issues) process.stderr.write(`${label} ${i.severity}: ${i.code}${i.line ? ` (line ${i.line})` : ''}: ${i.message}\n`);
  if (!r.ok || !r.ir) die(`${label} "${file}" is not a valid supported OpenAPI document.`);
  return r;
}

function loadPolicy(file: string | undefined, profile: string | undefined, failOnWarnings: boolean): Policy {
  let policy: Partial<Policy> = {};
  if (file) {
    try { policy = JSON.parse(readFileSync(file, 'utf8')) as Partial<Policy>; } catch (e) { die(`Cannot read policy "${file}": ${(e as Error).message}`); }
    if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) die('Policy file must contain a JSON object.');
    for (const c of policy.failOn ?? []) if (!CATEGORIES.includes(c)) die(`Policy failOn contains unknown category "${c}".`);
    for (const s of policy.suppressions ?? []) {
      if (!s.reason || !s.author) die('Every suppression needs a "reason" and an "author".');
      if (s.expiresAt && Number.isNaN(Date.parse(s.expiresAt))) die(`Suppression has an invalid expiresAt "${s.expiresAt}".`);
    }
    for (const id of Object.keys(policy.ruleOverrides ?? {})) if (!RULES[id]) die(`Policy overrides unknown rule "${id}".`);
  }
  const p = profile ?? policy.profile ?? 'standard';
  if (!PROFILES.includes(p)) die(`Unknown profile "${p}". Use one of: ${PROFILES.join(', ')}.`);
  return { ...policy, profile: p as Profile, failOnWarnings: failOnWarnings || policy.failOnWarnings, failOn: (policy.failOn ?? ['BREAKING']) as Category[] };
}

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      profile: { type: 'string' }, policy: { type: 'string' }, format: { type: 'string', default: 'text' },
      out: { type: 'string' }, 'fail-on-warnings': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) { process.stdout.write(USAGE); process.exit(cmd ? 0 : 2); }

  if (cmd === 'rules') {
    for (const r of Object.values(RULES)) process.stdout.write(`${r.id.padEnd(13)} ${r.categories.standard.padEnd(21)} ${r.title}\n`);
    return;
  }
  if (cmd === 'validate') {
    if (rest.length !== 1) die(USAGE);
    const r = load(rest[0]!, 'spec');
    const ops = Object.keys(r.ir!.operations).length;
    process.stdout.write(`OK: ${r.ir!.info.title} ${r.ir!.info.version} (OpenAPI ${r.ir!.openapi}), ${ops} operation(s), ${r.ir!.unsupported.length} unsupported construct(s).\n`);
    return;
  }
  if (cmd !== 'compare' || rest.length !== 2) die(USAGE);
  const format = values.format as string;
  if (!['text', 'json', 'html', 'csv'].includes(format)) die(`Unknown format "${format}".`);

  const base = load(rest[0]!, 'base');
  const target = load(rest[1]!, 'target');
  const policy = loadPolicy(values.policy, values.profile, values['fail-on-warnings'] ?? false);
  const result = compare(base.ir!, target.ir!, { policy });

  const out = format === 'json' ? renderJson(result) : format === 'html' ? renderHtmlReport(result) : format === 'csv' ? renderCsv(result)
    : renderText(result, { base: base.locate, target: target.locate });
  if (values.out) writeFileSync(values.out, out, { encoding: 'utf8', mode: 0o644 });
  else process.stdout.write(out);
  process.exit(result.result === 'FAIL' ? 1 : 0);
}

main(process.argv.slice(2));
