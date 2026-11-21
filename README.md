# ContractGuard

Deterministic OpenAPI compatibility analysis: parse two contract versions, classify every change as
**BREAKING / POTENTIALLY_BREAKING / NON_BREAKING / INFORMATIONAL**, apply a policy, and export evidence-backed reports.

> **Read [Verification status](#verification-status) first.** The deterministic engine, the domain/service layer and the CLI
> are tested. The NestJS API, Prisma store, BullMQ worker, Next.js UI, Docker Compose, CI and Playwright tests are written but
> have **never been executed**: the environment they were written in had no network, pnpm, Postgres, Redis, Docker or browser.

## Quick start

Requires Node 22+.

```bash
npm install                      # yaml, tsx, typescript, @types/node
npm test                         # 104 tests (node:test via tsx)
npm run typecheck
npm run cli -- compare fixtures/petstore-v1.yaml fixtures/petstore-v2.yaml
npm run cli -- compare fixtures/petstore-v1.yaml fixtures/petstore-v2.yaml --format html --out report.html
npm run cli -- rules             # list the rule catalog
```

Exit codes: `0` pass / needs review, `1` check failed, `2` usage or specification error — so it drops straight into CI.

## Layout

| Path | Purpose |
|---|---|
| `packages/openapi-parser` | JSON/YAML → validated, `$ref`-resolved, normalized IR (`ir.ts`). Source line lookup, checksum, safety limits. |
| `packages/compatibility` | Rule catalog (`rules.ts`), comparison engine (`engine.ts`), policy + suppressions (`policy.ts`), reports (`report.ts`). |
| `apps/cli` | `compare`, `validate`, `rules`. |
| `fixtures/` | Demo contracts (v1 → v2 with ~28 changes). |

## Design guarantees (all covered by tests)

* **Deterministic.** Same inputs + policy + clock ⇒ byte-identical output. Finding IDs are SHA-256 hashes of
  rule/operation/location/schema-path. Shuffling key order in the source documents does not change results.
* **No AI in the verdict.** Classification is rule-based; every finding carries evidence, before/after values and
  JSON pointers into the original documents (plus line numbers via `locate`).
* **Reproducible.** `evaluatePolicy(findings, policy, now)` is pure, so a stored finding set can be re-evaluated.
* **Safe input handling.** 5 MiB default size limit, NUL-byte rejection, YAML alias-bomb rejection, duplicate-key rejection,
  depth limit, **external `$ref`s are never fetched** (flagged as unsupported).
* **Safe output.** HTML report escapes everything, ships no script and a `default-src 'none'` CSP; CSV neutralizes
  formula injection (`=`, `+`, `-`, `@`).
* **Nothing silently dropped.** Constructs that are present but not analyzed are listed in `unsupported` and shown in reports.

## Compatibility profiles

The same change can be classified differently depending on how strict consumers are. Each rule defines its category per
profile (`conservative` / `standard` / `permissive`); see `packages/compatibility/src/rules.ts` — every rule has a
documented `rationale`. Notable policy decisions:

* New **required response property** → non-breaking (standard; tolerant readers), potentially breaking (conservative).
* Response **enum value added** → potentially breaking (clients with exhaustive switches); **removed** → non-breaking.
* Request **property removed** → potentially breaking (depends on server strictness).
* `readOnly` properties are ignored for request breakage; `writeOnly` for response breakage.
* A finding is reported **per operation** that exposes the changed schema (impact analysis), so one shared-schema change
  can yield several findings.

## Policy file (`--policy policy.json`)

```json
{
  "profile": "standard",
  "failOn": ["BREAKING"],
  "failOnWarnings": false,
  "severityThreshold": "high",
  "ruleOverrides": { "CG-OP-002": { "category": "INFORMATIONAL" }, "CG-RES-014": { "fails": false } },
  "suppressions": [
    { "ruleId": "CG-RES-013", "operationPrefix": "GET /pets", "reason": "Coordinated migration", "author": "alice", "expiresAt": "2027-01-31T00:00:00Z" }
  ]
}
```

Suppressed findings are never deleted: they keep their evidence and are marked `SUPPRESSED`. Suppressions need a reason and
author, must name a selector, and stop applying after `expiresAt`.

## Known limitations

* OpenAPI 3.0.x / 3.1.x, local `$ref`s only. Swagger 2.0 rejected.
* `oneOf`/`anyOf` compared by structural signature; `allOf` merged shallowly (later parts win on conflicts).
* Not analyzed: `not`, `discriminator`, `patternProperties`, `if/then/else`, `prefixItems`, callbacks, links, webhooks,
  `additionalProperties` depth, regex containment (changed patterns are classified in the unsafe direction).
* Based only on the documents: no runtime or consumer-code knowledge.

## Architecture

```
apps/web (Next.js 15 App Router, React 19, Tailwind v4, shadcn-pattern components)
   │  same-origin proxy  /api/*
apps/api (NestJS) ── thin controllers ──► packages/domain  ◄── apps/worker (BullMQ consumer)
   │                                      ContractGuardService      │
   │ enqueue                              (auth, RBAC, tenancy,      │ processComparison()
   ▼                                       limits, registry, policy, │ runPullRequestCheck()
 Redis/BullMQ ─────────────────────────────  reports, AI, GitHub)  ──┘
                                              │            │
                              packages/compatibility   packages/db (Prisma → PostgreSQL)
                              packages/openapi-parser   implements the Store port
```

* **Business rules live in `packages/domain`**, not in controllers, so they are testable without HTTP, Postgres or Redis.
  `Store` (persistence) and `JobQueue` are ports; tests use `InMemoryStore`, production uses `PrismaStore` + `BullJobQueue`.
* **The compatibility engine is unchanged** (55 rules, same exports). The worker calls it through `processComparison()`.
* Multi-tenancy: every tenant-owned read takes `orgId`; a foreign ID resolves to NOT_FOUND (no existence leak). Spec versions
  are append-only (no update/delete in the `Store` interface, plus a DB trigger in `packages/db/prisma/sql/immutability.sql`).

## Run it (requires Node 22, pnpm 9, Docker)

```bash
cp .env.example .env
docker compose up --build            # postgres, redis, migrate, api (:4000), worker, web (:3000)
# or locally:
pnpm install
docker compose up -d postgres redis
pnpm db:generate && pnpm db:migrate  # generates the initial migration from schema.prisma
psql "$DATABASE_URL" -f packages/db/prisma/sql/immutability.sql
pnpm dev:api & pnpm dev:worker & pnpm dev:web
pnpm e2e                             # Playwright (starts the three servers itself)
```

The engine, domain tests and CLI need none of that: `npm install && npm test`.

## Verification status

| Area | Status |
|---|---|
| `openapi-parser`, `compatibility` (55 rules), CLI | **Executed**: 104 tests pass, typecheck clean |
| `packages/domain` (auth, RBAC, tenancy, limits, registry, policies, comparisons, reports, dashboard, SSRF guard, AI grounding, GitHub signature/PR flow) | **Executed**: 31 tests pass (135 total), typecheck clean |
| `apps/api` (NestJS), `packages/db` (Prisma schema, `PrismaStore`), `packages/queue` (BullMQ), `apps/worker`, GitHub App HTTP client | **Written, never run.** Syntax-checked only (no parse errors); not type-checked, not started |
| `apps/web` (Next.js, React, Tailwind) | **Written, never built or rendered.** Syntax-checked only |
| Prisma migrations | **Not generated** (needs the Prisma CLI). The schema is hand-written and unvalidated |
| `docker-compose.yml`, `Dockerfile`, `.github/workflows/ci.yml` | **Never executed** |
| Playwright e2e (`apps/web/e2e`) | **Written, never run** |

### Known gaps
* No end-to-end proof yet that Postgres/Redis/Nest/Next work together; expect integration fixes on first run.
* Email invitations, password reset, email verification, SSO/MFA, real billing provider integration: not implemented
  (plan limits are enforced; `setPlanFromBilling` is the hook a billing webhook would call).
* Notifications are in-app only. AI explanations use Anthropic's API only when `ANTHROPIC_API_KEY` is set; otherwise deterministic.
* `AuthGuard` CSRF defense relies on the `Origin` header + SameSite=Lax cookie; no CSRF tokens.
* The shadcn/ui components are hand-written in the shadcn style (cva + tailwind-merge); the shadcn CLI was not run.
* No GitHub Marketplace/OAuth app registration flow; installation IDs are entered manually in Settings.
