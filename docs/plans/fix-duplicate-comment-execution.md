# Eliminate Duplicate LinkedIn Comment Execution

## Status

Proposed. This is a large/risky bug fix because it changes concurrency control around a real external side effect (posting to LinkedIn) and introduces a database migration.

## Goal

Guarantee that one tenant/account can have at most one active or completed comment execution for one canonical LinkedIn post, even when scheduler instances, API requests, or retries race. A failed execution may be retried only through an explicit, auditable state transition; an uncertain external outcome must never be automatically reposted.

## Problem Evidence and Current Causal Chain

The report of two distinct comments on the same LinkedIn post is consistent with, and directly explained by, a database race in the current scheduling path.

1. Post ingestion finds posts and creates one comment draft per stored `engagement_posts` record. The lookup is by raw `postUrl` at `src/services/engagement/engagement-service.ts:212-239`; comment-draft creation checks `(postId, tenantId, actionType)` at `:278-329`. `engagement_posts` is unique only by `(tenantId, postUrl)` in `src/db/schema.ts:201-214`, not by a provider-native canonical post ID. A repeated scan can therefore race while creating drafts because the read-then-insert draft path has no database uniqueness constraint.
2. The server starts two in-process timers in `src/server.ts:1186-1191`: auto-drain and auto-approve/queue every 30 seconds. `autoApproveAndQueueCycle` has only the process-local `autoApproveRunning` boolean at `:1121-1183`; it cannot coordinate multiple server processes. It approves every `PENDING` draft and queues it at `:1143-1172`.
3. The scheduler passes `auto-${draft.id}-${Date.now()}` at `src/server.ts:1162-1170`, but `EngagementService.requestAction` ignores this caller-provided idempotency key after validation and builds its own revision/payload semantic key at `src/services/engagement/engagement-service.ts:519-522`. Thus the timestamp is not the primary duplicate cause, but it is misleading and masks the intended stable idempotency contract at the call site.
4. `requestAction` checks `account_post_comments` for `PENDING` or `COMPLETED` at `engagement-service.ts:532-546`. This is the reported “only add the post whose comment is not executed” check. The table is designed as the source of truth, with unique `(tenantId, accountId, postHash)` in `src/db/schema.ts:319-339`.
5. The check is not an atomic claim. It performs: read slot -> insert a `scheduled_actions` row at `engagement-service.ts:554-559` -> unconditional upsert slot to `PENDING` at `:561-577`. Two requests can both read no mapping (or a `FAILED` mapping), each insert distinct scheduled actions because their revisions/payloads differ, and then each upsert the same slot. The later upsert overwrites `scheduledActionId`; neither request is rejected. The unique index does not solve this because `onConflictDoUpdate` grants ownership to the loser instead of conditionally denying it.
6. The queue safely atomically claims a *scheduled-action row* with `FOR UPDATE SKIP LOCKED` in `src/db/drizzle-adapter.ts:251-304`, and `ActionQueueService.processNextAction` executes the claimed action at `src/services/action-queue-service.ts:50-198`. That prevents two workers from executing the same scheduled action, but it does not prevent both separately-created actions from executing.
7. `runAutoDrainCycle` uses only another process-local guard at `src/server.ts:1000-1008` and a per-account lease at `:1026-1041`. Once duplicate action rows exist, it can execute them sequentially, producing the observed time-gap duplicate. It marks the mapping only after executor success in `src/server.ts:1061-1070`; its paired-action path at `:1073-1087` does not re-run post-slot idempotency before dispatch. The lease is also acquired by insert/catch in `src/db/drizzle-adapter.ts:144-162`, so correctness depends on the database uniqueness behavior and does not replace a post-level claim.
8. The OpenCLI executor also tries browser-side detection before submit at `src/executors/opencli.ts:238-262`, but it detects visible author text containing `You` or a text fragment only after opening the UI. It is advisory, selector-dependent, does not establish database ownership, and cannot repair a race that has already queued two actions. Its success verification only checks that the editor cleared at `:321-353`, not that exactly one matching provider-side comment exists.

### Additional State Integrity Gaps

- The comment slot is mutated in `server.ts` rather than in the queue/action service that owns execution results. API-driven or non-auto-drain workers can complete/fail a comment without updating the mapping.
- `requestAction` deletes `FAILED` and `UNCERTAIN` scheduled actions before re-queueing at `engagement-service.ts:522-529`. Treating `UNCERTAIN` as retryable risks reposting after a browser timeout or ambiguous provider result.
- The execution result update and comment-slot terminal update occur in separate operations. A crash after posting but before the mapping is marked complete leaves an ambiguous state.
- `postHash` is derived from stored content and the post record is keyed by raw URL. URL variants, feed/activity URL changes, or changed post text can create separate identity records for the same LinkedIn post. This has not been proven as the screenshot’s cause, but it can bypass the account/post-hash uniqueness constraint.
- The stated “max 2 posts per prospect at one time” rule is not enforced as a durable invariant: `scanProspect` attempts to select two only when more than two are kept, accepts any non-empty LLM index result at `:168-175`, and otherwise iterates all `postsToEngage`; it also fabricates fallback posts when fewer than two exist. The plan must define and test exactly two distinct candidate slots, while the one-comment-per-post claim remains the final safety boundary.
- The repeat-prospect rule is only partially implemented: cooldown history is loaded once before the loop and is not updated after a newly queued comment, so multiple selected posts can pass the same check; `engagementHistory` is not written by the queue completion path. The durable account/post slot, rather than stale in-memory history, must decide repeats.
- The API route is `POST /api/queue/process` (not `/api/queue/process-next`), and `POST /api/engagement/recommendations/:id/actions` always wraps results in HTTP 202 with `queueStatus: pending`; duplicate/refusal outcomes need an explicit contract and route-level tests.

## Assumptions

- The intended policy is one comment per canonical LinkedIn post per tenant/account, regardless of comment text, draft revision, or execution path.
- `FAILED` means the provider-side post was definitively not submitted and may be explicitly retried. `UNCERTAIN` means the provider outcome is not known and must be reconciled or manually resolved before another publish attempt.
- PostgreSQL is the production authority; PGlite is used for isolated tests. The existing `drizzle/` migration chain is the schema migration location.
- A multiple-process deployment is possible or must be supported. Process-local booleans remain an optimization only, never a correctness control.

## Non-Goals

- Do not automatically delete existing duplicate LinkedIn comments.
- Do not introduce a broad queue framework or alter non-comment action semantics beyond shared result plumbing required for correctness.
- Do not rely on browser DOM duplicate detection as the authoritative safeguard.

## User Journeys

1. Automatic flow: ingest a post, generate and approve one comment, atomically claim its comment slot, queue one action, publish once, and expose a completed audit trail.
2. Concurrent flow: two scheduler instances or a scheduler and manual/API request attempt the same post at once. Exactly one receives/retains the claim and one scheduled action exists; the other returns a deterministic `POST_ALREADY_COMMENTED`/already-queued result without provider execution.
3. Definite failure: LinkedIn returns a pre-submit or explicit failure. The action and its slot transition to `FAILED`; an authorized, explicit retry may atomically replace that failed attempt.
4. Uncertain outcome: browser/network failure occurs after submit may have reached LinkedIn. The action and slot remain `UNCERTAIN`; no automatic retry happens. An operator can reconcile from provider evidence and mark completed or failed.
5. URL variants: source ingestion yields equivalent LinkedIn activity/feed URLs for the same native post. The canonical identity resolves to one engagement post/slot and prevents a second comment.

## Affected Components and Contracts

| File | Symbols / responsibility | Planned change |
| --- | --- | --- |
| `src/services/engagement/engagement-service.ts` | `EngagementService.requestAction` | Replace check-then-insert-then-upsert with an atomic comment-slot claim before action scheduling; use a stable post-level idempotency key; classify conflict and retry outcomes. |
| `src/db/schema.ts` | `accountPostComments`, `scheduledActions`, `engagementPosts` | Extend the comment-slot lifecycle/metadata as required for action ownership, terminal evidence, and uncertainty; add canonical provider post identity after confirming source data availability. |
| `drizzle/<new migration>.sql` | PostgreSQL schema migration | Add/alter constraints and safely backfill existing mappings/actions; preserve production data and fail on irreconcilable active duplicates rather than silently selecting a winner. |
| `src/services/action-queue-service.ts` | `ActionQueueService.processNextAction` | Make action-result handling atomically drive its owned comment slot to `COMPLETED`, `FAILED`, or `UNCERTAIN`; reject execution if the action no longer owns the slot. |
| `src/db/db-adapter.ts`, `src/db/drizzle-adapter.ts`, `src/db/memory-storage.ts` | storage contract and implementations | Add a transaction-safe claim/finalize/reconcile interface implemented for PostgreSQL and in-memory tests. Retain row-level scheduled-action claims. |
| `src/server.ts` | `runAutoDrainCycle`, `autoApproveAndQueueCycle` | Remove direct comment-slot state writes from the server; retain local flags only as optimization; scope pending-action queries by tenant/account where operationally needed; use the service’s stable outcome instead of timestamp keys. |
| `src/executors/opencli.ts` | `OpenCliExecutor.publishComment` | Keep provider-side preflight as defense in depth, improve it to target canonical post context where feasible, and return evidence sufficient for uncertain-outcome reconciliation. It must not be the idempotency authority. |
| `src/services/engagement/engagement-service.test.ts` | service tests | Add concurrent claim regression tests using `Promise.all` against the PGlite migration schema. |
| `src/services/action-queue-service.test.ts`, `src/services/action-queue-safety.test.ts` | queue tests | Add completed/failed/uncertain slot lifecycle tests and stale-owner rejection tests. |
| `src/executors/opencli.test.ts` or new focused test | executor contract | Cover duplicate preflight interpretation and evidence/uncertain result mapping without live LinkedIn access. |

## Frontend, API, and Database Contracts

### Frontend/API

- No new end-user screen is required for the minimum repair. Existing action-request endpoints must return a stable non-executing outcome when a slot is already `PENDING`/`CLAIMED`/`COMPLETED` or `UNCERTAIN`.
- If existing response consumers distinguish errors, document and test one explicit response code for `POST_ALREADY_COMMENTED` and one for `POST_EXECUTION_UNCERTAIN`; do not expose a false “queued” success to the losing caller.
- Any pending-draft/action UI must show terminal state derived from the durable slot/action record. The final implementation must inspect route consumers with API impact analysis before changing an API handler.

### Database

- Entity: `account_post_comments` remains the single authority for `(tenantId, accountId, canonicalPostIdentity)`.
- Required lifecycle: `CLAIMED`/`PENDING` -> `COMPLETED` | `FAILED` | `UNCERTAIN`. Define whether `PENDING` is renamed to `CLAIMED` or retained; record an owning `scheduledActionId`, timestamps, and provider/evidence metadata sufficient for reconciliation.
- Enforce ownership with a conditional database write. Preferred shape: within one transaction, insert the comment slot with `ON CONFLICT DO NOTHING`; only the successful inserter (or a guarded `FAILED` -> claimed transition) can create/link the scheduled action. A conflict must return the existing slot without overwriting its owner.
- Keep a database unique constraint on the canonical identity. Decide whether to add a partial unique index for live comment actions as a defense-in-depth invariant after auditing historical rows.
- Do not delete `UNCERTAIN` actions for retry. Preserve action and evidence for audit/reconciliation.

## Implementation Sequence

1. Reproduce and characterize the race in a failing integration test: create one approved comment draft, issue two concurrent `requestAction` calls with different request idempotency keys, and assert one comment slot plus one scheduled action. Add variants for two service instances and a pre-existing failed/uncertain slot.
2. Establish the canonical post identity contract. Inspect all post sources and URL normalizers to determine whether a native activity URN/ID is available. Normalize and persist it at ingestion; otherwise define a conservative URL canonicalizer plus a migration/backfill report. Do not claim the screenshot is identity-related without data evidence.
3. Create the forward Drizzle migration. Add lifecycle metadata/constraints and backfill mappings from comment scheduled actions. Identify active duplicate action groups by tenant/account/canonical identity; mark non-owner actions `FAILED` with a deterministic refusal only when definitively unexecuted, otherwise `UNCERTAIN`/quarantined for operator review rather than allowing both to drain. Review the existing one-off `scripts/migrate-post-comments.ts` because it currently cancels pending duplicates outside a transaction and does not model uncertain outcomes. Provide a reversible down/operational rollback procedure appropriate to the project’s migration conventions.
4. Add explicit storage operations such as `claimCommentSlotAndScheduleAction`, `finalizeCommentSlot`, and `reconcileCommentSlot`, all tenant-bound and transactional. PostgreSQL must condition its update on expected current state and owner action ID; memory storage must model the same behavior.
5. Refactor `requestAction` to validate approval/safety inputs first, then invoke the atomic claim-and-schedule operation. Replace the unused timestamp caller key with a documented stable idempotency contract. Return the pre-existing owner/action on an idempotent repeat only when it represents the same request; return an explicit refusal for a competing comment for the same post.
6. Refactor `ActionQueueService.processNextAction` so completion, definite failure, and uncertainty update the scheduled action and the matching owned comment slot together. Ensure budget release/commit and audit logging retain their existing behavior. Require the selected action to own the slot immediately before executor dispatch.
7. Simplify `runAutoDrainCycle`: remove direct `accountPostComments` updates and make the paired-action branch use the same queue result/lifecycle path. Verify error handling releases account leases even if a slot-finalization failure occurs. Keep auto-approve’s in-process guard, but rely on database claims for cross-process correctness.
8. Improve the OpenCLI executor’s provider-side detection and result evidence. Keep `ACTION_DUPLICATE` as a last-line safety stop; classify failures after submit as `UNCERTAIN` unless provider evidence definitively proves no comment was created.
9. Add observability: audit events for claim acquired, contention refused, terminal transition, and reconciliation; metric/log fields for tenant/account/canonical post identity/action ID without comment text leakage. Add an operator query/runbook to list and resolve `UNCERTAIN` slots. Include queue depth, claim contention, duplicate refusal, and uncertain-outcome counters so exact-time and delayed duplicates can be distinguished in production.
10. Run impact/API analysis for modified symbols/handlers, execute the full verification suite, and review the migration on a production-like database copy before release.

## Acceptance Criteria

- Two concurrent attempts to queue a comment for one tenant/account/canonical post produce exactly one durable comment slot and one executable scheduled comment action.
- Repeating the same logical request is idempotent and returns the original action; a competing draft/revision/comment for that post is refused without overwriting the original `scheduledActionId`.
- Two worker processes cannot both publish for one slot. Row-level scheduled-action claims and slot ownership are both enforced.
- A successful publish atomically reaches `COMPLETED` with action ownership/evidence; no server-specific follow-up is needed to update it.
- A definite failure reaches `FAILED` and can only be retried through an explicit guarded claim. An ambiguous outcome reaches `UNCERTAIN` and cannot auto-retry.
- URL/URN normalization decisions are covered with fixtures so known equivalent forms resolve to one canonical post identity.
- The browser preflight may stop an already-visible provider-side comment, but system correctness does not depend on it.
- Existing non-comment queue action behavior, lease protection, budget behavior, and manual-confirmation flow remain covered and unchanged unless explicitly approved.

## Test and Verification Plan

- Regression integration test in PGlite: concurrent `Promise.all` action requests for the same post, including separate service instances, assert one winner/one scheduled action/one owner mapping.
- Transaction failure tests: action insert failure rolls back the slot claim; slot claim conflict creates no orphan action; stale owner cannot finalize a newer owner’s slot.
- Lifecycle tests: success -> completed, definite failure -> failed, post-submit exception -> uncertain, explicit retry from failed succeeds once, retry from uncertain is refused.
- Worker tests: two calls to `processNextAction` with different workers execute only the slot owner; queued duplicate historical action is quarantined/refused before executor dispatch.
- Canonical identity fixtures: activity URN, feed URL, URL fragment/index, and tracking-query variants. Include a negative fixture for genuinely different posts with identical text if content hash remains a fallback.
- API contract tests for duplicate and uncertain responses, plus `gitnexus_api_impact` before any route handler edits.
- Run `npm test`, `npm run typecheck`, and migration generation/validation. Use an isolated PGlite migration run and a staging/backup database migration dry run with a query that proves no active duplicate comment groups remain.
- Before commit, run GitNexus `detect_changes(scope: all)` and resolve any partial/truncated result; inspect impacts of every changed public service/handler.

## Risks and Mitigations

- Exactly-once delivery to LinkedIn cannot be guaranteed across a process/browser crash after click. Mitigation: durable pre-execution claim, `UNCERTAIN` terminal state, provider evidence, and manual reconciliation rather than blind retry.
- Migration may discover active duplicates. Mitigation: quarantine non-owner rows and require review; do not silently execute or delete them.
- Canonical ID availability may vary by source. Mitigation: verify source payloads before schema choice; use the smallest conservative normalization only if native IDs are unavailable.
- A transaction containing external LinkedIn execution would hold locks too long. Mitigation: transactionally claim before execution and transactionally finalize afterward; never keep a database transaction open around browser I/O.
- Existing test PGlite behavior may differ from PostgreSQL concurrency semantics. Mitigation: add a PostgreSQL/staging concurrency test or transaction-level integration verification for the final claim query.

## Rollback Notes

- Disable browser comment execution via the existing feature/control path before deploying or rolling back if unexpected contention or reconciliation volume occurs.
- The migration must be additive/backward-compatible for one release where possible. Preserve all existing `scheduled_actions`, slot records, and audit evidence.
- Roll back application code only after pausing/draining workers; an older version can otherwise overwrite slot ownership/state. Do not drop the new unique/ownership data until all workers run compatible code and a migration rollback has been reviewed.
- Retain `UNCERTAIN` and quarantined duplicate records for manual resolution; never replay them automatically during rollback.

## Decisions Requiring Tushar's Approval

1. Confirm the policy is exactly one comment per tenant/account/canonical LinkedIn post, including when the comment text or draft revision changes.
2. Confirm retry policy: permit only explicit retries from definitively `FAILED`; require manual reconciliation for `UNCERTAIN` rather than automatic retry.
3. Approve a forward database migration and a production data audit/quarantine path for currently active duplicate comment actions.
4. Choose the canonical identity source after inspection: provider-native LinkedIn activity URN/ID preferred; normalized URL fallback only if unavailable.
5. Confirm whether users/operators need a minimal UI/API reconciliation surface in this change or whether an audited administrative/runbook workflow is sufficient for the first release.

## Definition of Done

- The concurrency regression is first reproduced by automated test and then fixed.
- Database constraints and transactional claim/finalization make duplicate comments impossible from concurrent internal requests for the same canonical post/account.
- Every comment terminal state is durable, owned, auditable, and correctly handles ambiguous external outcomes.
- Migration is generated, reviewed, tested against representative existing data, and has a documented rollback/operational halt procedure.
- Full automated tests and typecheck pass; staging verification demonstrates one provider publish attempt under a forced concurrent scheduling scenario.
- GitNexus consequence scan is clean/non-partial and user-facing/API contract changes are reviewed.

## Binary Completion Contract

**COMPLETE only if** all acceptance criteria and definition-of-done checks above pass, including the forced concurrent-claim regression, migration validation, and no auto-retry from `UNCERTAIN`.

**INCOMPLETE if** more than one scheduled executable comment can be created for one canonical post/account, terminal slot state is updated outside the owned queue lifecycle, canonical identity remains undefined, migration data conflicts are silently discarded, or verification is partial/failing.
