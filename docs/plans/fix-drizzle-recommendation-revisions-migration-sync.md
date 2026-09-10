# Repair Drizzle Migration Ledger Drift for `recommendation_revisions`

## Goal

Restore a safe, repeatable `npm run db:migrate` path for the approved target PostgreSQL database without dropping tables, deleting data, or re-running schema creation that already exists. The repair must make Drizzle's migration ledger accurately represent the schema that is actually present, then apply any genuinely pending migrations.

## Classification and Scope

- Type: production-database migration incident and maintenance bug.
- Risk tier: large/risky because it changes migration history for persisted data.
- In scope: diagnostic SQL, a reviewed ledger-baselining procedure or reconciliation migration selected from diagnostic results, migration-runner observability/cleanup if needed, and focused migration verification.
- Non-goals: rebuilding the database, using `drizzle-kit push` as a repair mechanism, modifying historical migrations before root cause is proven, or changing application behavior.

## Current Behavior and Evidence

1. `npm run db:migrate` runs `tsx src/migrate.ts` with `.env`. `runMigrations` creates a `pg` pool from `DATABASE_URL` and calls Drizzle `migrate(db, { migrationsFolder: 'drizzle' })` ([`src/migrate.ts`](../../src/migrate.ts)). It does not supply a custom migrations schema/table, preflight check, or recovery path; therefore Drizzle's default `__drizzle_migrations` ledger controls whether a local migration is pending.
2. [`drizzle/0004_supervised_execution.sql`](../../drizzle/0004_supervised_execution.sql) is the migration that begins with the unguarded `CREATE TABLE "recommendation_revisions"`. It also creates `recommendation_approvals`, `manual_tasks`, `engagement_controls`, `browser_accounts`, and `execution_evidence`, then adds five columns to `scheduled_actions`.
3. The failure `42P07 relation "recommendation_revisions" already exists` proves that the target database already has that relation when Drizzle tries to execute `0004`. It does not, by itself, prove whether all of `0004` is present or whether the table was created by this exact migration.
4. [`drizzle/meta/_journal.json`](../../drizzle/meta/_journal.json) contains local migration entries `0000` through `0005`; [`drizzle/0006_comment_slot_claims.sql`](../../drizzle/0006_comment_slot_claims.sql) has no journal entry. Also, checked-in snapshots stop at `0003`. These repository inconsistencies are migration-generation hygiene issues. At runtime, `migrate()` uses the local journal and remote ledger, so they are not sufficient evidence that `0004` is being retried.
5. The graph check for `runMigrations` reports one direct file-level caller and `LOW` risk, no affected execution processes, and an index one commit behind HEAD. This does not reduce database-state risk.

## Root-Cause Assessment

The immediate cause is confirmed: the `0004` DDL is being sent to a database that already contains `recommendation_revisions`.

The leading root-cause hypothesis is migration-ledger drift: the matching Drizzle hash/timestamp record for local migration `0004_supervised_execution` is absent from the target database's `__drizzle_migrations` table, commonly after schema was created via `drizzle-kit push`, manual SQL, a restored database with incomplete ledger data, or a migration-history mismatch. A second possibility is an incorrectly targeted `DATABASE_URL` pointing at a database whose schema was created by another environment. A partial/out-of-order schema is also possible and is unsafe to baseline until checked.

The diagnostic phase below is a mandatory decision gate. Do not declare the root cause confirmed, insert a ledger row, or make `0004` idempotent until its results distinguish these cases.

## Assumptions

- The target is PostgreSQL and can be placed in a short maintenance window for the repair.
- An operator with read access to catalog tables and controlled write access to `__drizzle_migrations` will execute the approved commands.
- The schema uses the default `public` schema unless the diagnostic query proves otherwise.
- The target must preserve all existing application data.
- `DATABASE_URL` and database exports are treated as secrets and are never committed, logged, or placed in the plan implementation artifacts.

## User Journeys

1. An operator runs the migration against a database whose full `0004` schema already exists but whose ledger is missing `0004`. The preflight identifies an exact schema match, records a backup, baselines the exact migration identity, and `npm run db:migrate` resumes at the next pending journaled migration without data loss.
2. An operator runs the migration against a fresh database. Drizzle applies journaled migrations exactly once; a second run is a no-op and the required tables, constraints, and columns exist.
3. An operator runs the migration against a database with only some `0004` objects. The preflight stops before any ledger edit, captures the mismatch, and requires a new forward-only reconciliation migration tailored to the missing objects/constraints.
4. An operator points at the wrong environment or a ledger containing unexpected hashes. The target identity check fails the repair and no schema or ledger mutation occurs.

## Affected Components, Files, and Data

| Component | Role | Planned change |
| --- | --- | --- |
| `drizzle/0004_supervised_execution.sql` | Historical creation migration for the conflicting table and related footprint | Do not modify during ledger repair; use as the expected schema specification. |
| `drizzle/meta/_journal.json` | Local migration source of truth read by the migrator | Inspect and repair journal coverage through normal `drizzle-kit generate` workflow only after the live incident is synchronized. It currently omits `0006`. |
| `drizzle/meta/0000_snapshot.json` through `0003_snapshot.json` | Local schema-generation snapshots | Regenerate missing snapshots only in a separate reviewed migration-artifact hygiene change; do not use them to edit the live database ledger. |
| `drizzle/0005_supervised_hardening.sql` | Next journaled migration with dependencies on `0004` tables | Apply only after `0004` state has been verified/baselined. |
| `drizzle/0006_comment_slot_claims.sql` | Existing unjournaled migration file | Exclude from automatic migration expectations until a reviewed journal entry is created; do not manually mark it applied merely because the file exists. |
| `src/migrate.ts` / `package.json` | Migration entry point (`npm run db:migrate`) | Initially unchanged. Consider a follow-up preflight/error-handling enhancement only after the data repair, so it does not obscure the original incident. |
| Target database `public.__drizzle_migrations` | Drizzle application ledger, normally `id`, `hash`, `created_at` | Read, backup, and update only after exact schema equivalence is proven. |
| Target database schema | `recommendation_revisions`, five sibling tables, scheduled-action columns, foreign keys, unique constraint, dependent type `engagement_action_type` | Catalog-compare against `0004`; repair forward-only only when incomplete. |

## Frontend, API, and Database Contracts

- Frontend: no UI screens, routes, or client contracts change.
- API: no endpoint request/response contract changes. API startup must continue to use the existing database schema after the repair.
- Database entities: `recommendation_revisions` is keyed by UUID, references `engagement_drafts(id)`, requires tenant/draft/revision uniqueness, and is referenced by `recommendation_approvals(revision_id)`. The same migration also establishes `manual_tasks`, `engagement_controls`, `browser_accounts`, `execution_evidence`, and `scheduled_actions` columns `revision_id`, `post_hash`, `mode`, `outcome_label`, and `error_code`.
- Permissions: no application authorization change. The one-time repair role needs least-privilege catalog read and tightly controlled access to the migration ledger; application roles retain their existing permissions.
- Validation/error states: the repair script must fail before mutation when the target database identity is unexpected, `__drizzle_migrations` cannot be read, the `0004` hash cannot be determined, any required `0004` object is absent/different, or existing ledger rows conflict. It must emit redacted diagnostics and a non-zero exit status.

## Schema and Migration Strategy

### 1. Freeze and back up

1. Pause concurrent deploys and migration invocations for the selected database. Record a redacted target identifier (`current_database()`, server host name if policy permits, and schema) in the incident record.
2. Take an approved logical backup/snapshot and verify restoration procedure before changing the ledger. Export the current `public.__drizzle_migrations` rows separately as an auditable artifact stored outside the repository.
3. Do not run `db:push`, do not drop `recommendation_revisions`, do not truncate the ledger, and do not add `IF NOT EXISTS` to `0004`. `IF NOT EXISTS` would skip only the first conflicting table and could mask absent sibling tables, constraints, or altered columns.

### 2. Build a read-only preflight script

Implement a committed or operationally controlled TypeScript/SQL preflight tool after approval. It must use the same target selection mechanism as `src/migrate.ts`, with an explicit confirmation parameter containing the expected database name/environment; it must never print `DATABASE_URL`.

The preflight must run these read-only checks:

```sql
SELECT current_database(), current_schema(), current_user;

SELECT id, hash, created_at
FROM public.__drizzle_migrations
ORDER BY created_at, id;

SELECT to_regclass('public.recommendation_revisions') AS recommendation_revisions;

SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'recommendation_revisions', 'recommendation_approvals', 'manual_tasks',
    'engagement_controls', 'browser_accounts', 'execution_evidence', 'scheduled_actions'
  )
ORDER BY table_name, ordinal_position;

SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN (
  'public.recommendation_revisions'::regclass,
  'public.recommendation_approvals'::regclass
)
ORDER BY table_name, conname;
```

The tool must additionally compare foreign keys for `recommendation_approvals.revision_id` and `execution_evidence.scheduled_action_id`, verify the `tenant_draft_revision_unique` constraint, check the five `scheduled_actions` columns, and detect whether enum/type `engagement_action_type` exists. It should produce a machine-readable report with `exact-0004-match`, `partial-0004`, `no-0004`, or `ledger-conflict` status.

### 3. Determine the exact migration identity

Before any ledger mutation, use the installed Drizzle migrator/version to derive the exact hash and `created_at` value it expects for `0004_supervised_execution`. Prefer a disposable PostgreSQL database and a temporary instrumented read of the ledger written by `npm run db:migrate`; alternatively use an audited local helper that reproduces the installed `drizzle-orm@0.45.2` migration-hash calculation. Do not guess from the filename, tag, or snapshot ID.

Verify that the expected identity is not already present in any conflicting ledger row. Also compare all existing target ledger rows to the local journal entries `0000`–`0005` and report gaps or unknown hashes. A missing `0004` row alongside an exact footprint is the only condition suitable for baselining this historical migration.

### 4. Select one repair branch

**Branch A: Exact full `0004` footprint; `0004` ledger identity absent.**

1. Create a transactional, one-time baseline script with a dry-run mode. It must acquire an advisory lock, re-run the preflight inside the transaction, then insert exactly the Drizzle-compatible `hash` and `created_at` values for `0004` into `public.__drizzle_migrations` only if no equivalent/conflicting row exists.
2. Commit, export the resulting ledger, and run `npm run db:migrate`. Confirm it skips `0004`, applies only truly pending journaled migrations such as `0005`, and finishes successfully.
3. Repeat `npm run db:migrate` and confirm no migration SQL is run and no duplicate ledger rows are created.

**Branch B: Partial or structurally different `0004` footprint.**

1. Do not insert a `0004` ledger row and do not alter historical `0004`.
2. Capture the exact missing/different objects and data conditions. Write a new, forward-only, reviewed reconciliation migration that safely creates only missing objects and adds only missing columns/constraints, with explicit guards and preconditions. Where a proposed constraint could reject existing data, add an audit query and a data-remediation decision before applying it.
3. Because Drizzle would still consider `0004` pending, select a reviewed baseline strategy that preserves the historical sequence: either bring the database back to exact `0004` equivalence and baseline its exact ledger identity, or provision a new clean environment and migrate/restore application data through an approved export/import procedure. Do not mark a partially matched migration as applied.

**Branch C: `recommendation_revisions` is absent but `0004` ledger identity exists.**

1. Stop and treat it as schema drift/corruption, not a normal pending migration.
2. Restore the missing schema using a forward-only reconciliation migration after confirming data dependencies and restore capability. Do not delete the ledger row to force historical SQL to replay.

**Branch D: Target identity is wrong or ledger has broad unknown/conflicting history.**

1. Stop without mutation, identify the correct environment/credential or restore the ledger from the verified backup.
2. Escalate for database-owner review; do not attempt bulk ledger reconstruction from filenames.

### 5. Repair local migration artifacts separately

After the live database has passed Branch A, B, or C verification, create a separate reviewed repository change to reconcile Drizzle artifacts: establish correct snapshots for migrations after `0003` and ensure `0006_comment_slot_claims.sql` has an intentionally generated, ordered journal entry before treating it as deployable. Run artifact generation against an isolated database, inspect the generated SQL, and confirm it does not rewrite applied history. This is intentionally separate from the target-ledger repair so a local metadata cleanup cannot change the meaning of an already-applied migration.

## Implementation Sequence

1. Confirm the maintenance window, expected environment, backup owner, and restore test. Preserve unrelated workspace changes.
2. Implement the read-only preflight/report tool and tests using a disposable Postgres/PGlite fixture where catalog fidelity permits; use a real non-production PostgreSQL instance for the final catalog query validation.
3. Run preflight against the target with explicit environment confirmation. Archive redacted output and classify it into Branch A, B, C, or D.
4. In an isolated database, derive and verify the installed Drizzle migration identity for `0004`; record the method and result in the incident evidence.
5. Have a database owner review the preflight report, backup confirmation, and selected branch.
6. For Branch A, implement/run the transactional, idempotent baseline script under an advisory lock. For Branch B/C, produce and review the required forward-only reconciliation migration before changing any ledger state. For Branch D, correct the environment/restore issue without code changes.
7. Run `npm run db:migrate` once, inspect ledger and catalog results, then run it a second time to prove no-op behavior.
8. Execute application migration-smoke checks, complete the separate migration-artifact hygiene work, and document final ledger/schema evidence and rollback readiness.

## Test and Verification Plan

1. Regression characterization: in disposable PostgreSQL, apply `0004` schema without its corresponding ledger row and assert current `npm run db:migrate` reproduces `42P07` at `recommendation_revisions`.
2. Preflight tests: cover exact footprint/missing ledger, partial `0004`, ledger-present/table-missing, unexpected target identity, missing ledger table, unknown hash, and conflicting hash. Assert all non-exact outcomes perform zero writes.
3. Baseline-script tests: verify dry-run has no mutation; exact-match mode inserts exactly one expected ledger identity; a second invocation is idempotent; a structural mismatch or pre-existing conflicting identity rolls back.
4. Fresh-database integration: run the journaled migration sequence against a clean approved PostgreSQL database, assert `recommendation_revisions` and all `0004` sibling objects/constraints/columns exist, then assert a second migration run is a no-op.
5. Upgrade integration: start from an exact `0004` schema with its ledger identity missing, execute the approved Branch A script, run `npm run db:migrate`, and assert only pending journaled migrations execute.
6. Application verification: run `npm run typecheck` and `npm test`; run focused persistence tests that write/read recommendation revisions and approvals once the migration state is valid. Do not represent a successful migration as proof of RLS/tenant behavior; run any existing RLS check separately.
7. Operational verification: compare pre- and post-repair row counts for migration ledger and affected application tables; ensure no data/table drops occurred; store redacted before/after schema fingerprints and migration logs.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Baselining an incomplete `0004` leaves a silently broken schema | Require a complete catalog/constraint/foreign-key comparison before ledger insertion; use Branch B on any mismatch. |
| Wrong database receives a ledger mutation | Require explicit expected target confirmation, capture target identity, use least-privilege credentials, and take a backup first. |
| Incorrect hash/timestamp means Drizzle still replays `0004` | Derive identity from the installed Drizzle version in a disposable database; never infer it from the filename. |
| Concurrent deploy runs migration during repair | Maintenance window plus advisory lock and post-lock recheck. |
| Editing old SQL with guards hides drift | Preserve historical `0004`; use a separate forward-only reconciliation migration when needed. |
| Unjournaled `0006` is unexpectedly skipped | Treat it as not deployable until a reviewed journal/snapshot repair validates its ordering and SQL. |
| `src/migrate.ts` leaves pools open on failures | Consider `try/finally` cleanup and preflight diagnostics only as a separately reviewed follow-up; it is not the direct cause of `42P07`. |

## Rollback Notes

- Before ledger mutation, the primary rollback is restoring the approved database snapshot or the exported original `__drizzle_migrations` rows.
- A Branch A baseline changes only migration metadata. If its expected identity was inserted incorrectly and no subsequent migration has run, remove only that exact, audited row in a maintenance window after comparing it to the backup; do not truncate the ledger.
- If later migrations have already run, do not remove ledger rows or roll back DDL manually. Restore to the verified snapshot or create a new forward-only remediation plan after database-owner review.
- Reconciliation migrations must include their own forward rollback assessment. Prefer a compensating forward migration over destructive rollback on shared data.

## Decisions Requiring Tushar's Review

1. Which concrete target environment and maintenance window are approved for diagnostic access and repair?
2. Who owns the backup/restore verification and has authority to mutate `public.__drizzle_migrations`?
3. May the approved implementation add a repository-maintained preflight/baseline utility, or must the repair remain a runbook executed by the database owner?
4. If preflight finds a partial `0004`, should the team prefer a forward-only reconciliation in place or a clean-environment migration and controlled data transfer?
5. Should local Drizzle journal/snapshot reconciliation, including unjournaled `0006`, be scoped as the immediate follow-up release?

## Definition of Done

- The root-cause branch is evidenced by saved, redacted target identity, migration-ledger, and schema-fingerprint outputs.
- The target schema and Drizzle ledger agree on the status of `0004`; no historical migration was edited or replayed against existing objects.
- `npm run db:migrate` succeeds once and is a no-op on the next invocation.
- All objects, columns, foreign keys, and constraints expected from `0004` are present and application data remains intact.
- The `0005` status is verified, `0006` is explicitly tracked as unjournaled until repaired, and migration artifact remediation has an approved separate change.
- Focused migration checks, `npm run typecheck`, and `npm test` have recorded results, with failures resolved or documented as blockers.
