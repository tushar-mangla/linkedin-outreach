# Enforce One Comment Per Prospect Scan and Durable Comment Cooldown

## Status

Proposed. This is a medium-risk behavioral repair because it changes candidate generation and persists state after real external engagement actions complete. It complements, but does not replace, the broader account-post ownership work documented in `docs/plans/fix-duplicate-comment-execution.md`.

## Goal

Implement Tushar's three settled decisions:

1. Generate at most one new comment candidate per prospect in each scan.
2. Record successful actions in `engagement_history` so a completed comment blocks another comment to the same prospect for 14 days, including a second candidate that was queued before the first completed.
3. Keep the auto-approve worker enabled exactly as it is.

## Assumptions and Non-Goals

- Scope is tenant plus prospect: a successfully completed `COMMENT` starts a 14-day cooldown across that prospect's posts and accounts. A successful `LIKE` is also recorded, preserving the existing five-day like policy.
- “One post per prospect per scan” means at most one `COMMENT` draft is created by one `EngagementService.scanProspect` invocation, including LLM, fallback, and repeat-scan paths. The paired `LIKE` draft for that selected post remains allowed.
- `interactedAt` is completion time, not scan, approval, queue, or claim time. The actor is the queue worker for automatic completion and the operator for a manual completion.
- Existing `account_post_comments` ownership checks remain the post-level protection. Existing enabled auto-approve and auto-drain cadence are out of scope.
- Do not change provider/browser execution, UI screens, public API response shapes, cooldown durations, campaign behavior, or unrelated migration work.

## Current Behavior and Root Cause

- `PostFilter.filter` retains up to two recent posts at `src/services/engagement/post-filter.ts` (`filter`, lines 62-80). `EngagementService.scanProspect` independently computes `maxNewPostsAllowed` from two active candidates at `src/services/engagement/engagement-service.ts` (`scanProspect`, lines 127-263). A fresh scan can therefore create two comment drafts for one prospect.
- `scanProspect` already de-duplicates selected raw posts by canonical post identifier and loads tenant/prospect `engagement_history` before calling `CooldownPolicy.checkComment`.
- `CooldownPolicy.checkComment` correctly chooses the latest matching `COMMENT` history record and blocks less than 14 days later at `src/services/engagement/cooldown-policy.ts` (`checkComment`, lines 42-75). The policy is ineffective because the completion path never writes history.
- `engagement_history` already has `tenantId`, `prospectId`, `postId`, `actionType`, `interactedAt`, and `operatorId` at `src/db/schema.ts` (`engagementHistory`, lines 310-318). `ActionQueueService.processNextAction` currently finalizes successful actions but does not insert a history row.
- The worker already checks that a comment action owns its account-post slot before provider dispatch at `src/services/action-queue-service.ts` (`processNextAction`, lines 71-74). A prospect cooldown check is still needed at dispatch time to stop an old second action for a different post from executing after the first comment completes.

## User Journeys

1. A scan finds many eligible posts. It creates one `COMMENT` draft and one paired `LIKE` draft at most, and a repeat scan creates no second active comment candidate.
2. The enabled auto-approve worker queues the approved action as today. When the queue worker completes it, one history record captures the prospect, post, action type, completion time, and actor.
3. A scan during the following 14 days detects the completed comment and returns a cooldown skip with no comment draft. At the exact expiry boundary, a scan can create one new candidate.
4. If a legacy/previously queued second comment reaches a worker after the first completes, the worker refuses it before external provider I/O and without consuming budget.
5. A successful `LIKE` is recorded once. Failed, uncertain, and manual-confirmation-pending actions never start a cooldown.

## Affected Components and Contracts

| File | Symbols / responsibility | Planned change |
| --- | --- | --- |
| `src/services/engagement/post-filter.ts` | `PostFilter.filter` | Retain one recent post instead of two; update the rejection reason. Preserve the single older-post fallback. |
| `src/services/engagement/engagement-service.ts` | `EngagementService.scanProspect` | Set `maxNewPostsAllowed = Math.max(0, 1 - currentActiveCandidates)`. Preserve canonical identifier de-duplication and the final slice after LLM/fallback selection so all paths are capped at one. Update stale “two active candidates” comments. |
| `src/services/engagement/cooldown-policy.ts` | `CooldownPolicy.checkComment`, `checkLike` | Preserve 14-day/5-day rules; make clock evaluation deterministic for tests if needed. Verify latest-record selection, action/prospect isolation, daily cap behavior, and exact-boundary allowance. |
| `src/services/action-queue-service.ts` | `ActionQueueService.processNextAction` | After row claim and existing comment-slot ownership check, but before budget reservation/executor dispatch, query cooldown status for `comment`/`like`. Refuse a current cooldown terminally and audit it. On successful engagement action, call one idempotent adapter finalizer that updates the action/slot and writes history. |
| `src/services/engagement/execution-contracts.ts` | `SafetyActionInput` / `assertActionSafe`, only if necessary | Prefer a queue-owned typed adapter query. Change this contract only if required to express the new cooldown refusal without duplicating or weakening existing safety semantics. |
| `src/db/schema.ts` | `engagementHistory` | Add nullable `scheduledActionId` referencing `scheduledActions.id`, plus a unique association when populated, so retries of action finalization cannot duplicate history. Existing history columns remain unchanged. |
| `drizzle/<next>_engagement_history_action_id.sql`, `drizzle/meta/_journal.json` | migration chain | Add an additive nullable foreign key and unique index. Do not backfill historical history rows without a reliable action link. |
| `src/db/db-adapter.ts` | `DBAdapter` | Add a typed terminal engagement finalization/history operation and a tenant/prospect/action cooldown lookup. |
| `src/db/drizzle-adapter.ts` | `DrizzleAdapter` implementation | Transactionally resolve action -> revision -> draft -> post, update terminal action/comment slot, and insert history with conflict-safe `scheduledActionId` semantics. Only successful `like`/`comment` results insert history. |
| `src/db/memory-storage.ts` | `MemoryStorage` implementation | Mirror the adapter contract, atomic/idempotent behavior, and cooldown visibility used by queue tests. |
| `src/services/engagement/engagement-service.test.ts` | PGlite scan integration tests | Change current two-comment expectation to one; add completed-history cooldown and expiry-boundary scan coverage. |
| `src/services/engagement/cooldown-policy.test.ts` (new) | policy tests | Add unit tests for newest event selection, 14-day boundary, prospect/action isolation, and daily caps. |
| `src/services/action-queue-service.test.ts` | queue lifecycle tests | Assert one history row after successful comment and like; no history after failed/uncertain/manual-pending; duplicate finalization stays one row; cooled-down queued comment does not invoke executor or consume budget. |

## Frontend, API, and Database Contract

### Frontend and API

- No UI or API handler change is planned. Existing screens will naturally show fewer newly generated drafts.
- Preserve current action and queue response shapes. If implementation discovers that a route must expose a new error, run `gitnexus_api_impact` before modifying the handler and add consumer-compatible route tests.

### Database

- `engagement_history` becomes the authoritative completed-engagement ledger for the existing prospect cooldown policy.
- New history values derive from the scheduled action and its authoritative revision/draft/post chain: action type maps to upper-case `LIKE` or `COMMENT`; `interactedAt` is the successful terminal timestamp; `operatorId` is the worker/manual actor.
- The nullable unique `scheduledActionId` ensures one action yields at most one history record, while retaining legacy history rows without a link.
- Do not insert history for `FAILED`, `UNCERTAIN`, `PENDING`, `CLAIMED`, or manual-confirmation-pending states.

## Implementation Sequence

1. Update/add failing tests for the one-candidate cap in `engagement-service.test.ts`: a multi-post scan must create one comment and one paired like at most; a repeat scan must not add a second active comment candidate.
2. Change `PostFilter.filter` from two recent posts to one and change `scanProspect` to one active-comment slot. Verify every fallback, LLM selection, canonical de-duplication, and final `.slice()` path remains capped.
3. Add deterministic `CooldownPolicy` tests, then verify scan integration reads only that tenant/prospect history and blocks a comment within 14 days while allowing the exact expiry boundary.
4. Add and review the additive Drizzle migration for `engagement_history.scheduled_action_id`; generate it from schema change if required by repository conventions. Do not modify historical records.
5. Extend `DBAdapter`, Drizzle, and memory implementations with a shared idempotent successful-engagement completion method and cooldown lookup. In Drizzle, use a single transaction for terminal mutation plus history insert; use the unique action association/`ON CONFLICT` behavior to make repeated finalization safe. Resolve `postId` through revision/draft/post rather than executor payload URLs.
6. Refactor `ActionQueueService.processNextAction`: retain lease, comment-slot ownership, safety gates, budget, audit, executor, and uncertainty behavior. Add dispatch-time cooldown refusal before provider I/O. Route only successful `like`/`comment` actions through the history-writing finalizer; release any reservation on refusal and write no history.
7. Ensure manual completed engagement tasks use the same idempotent history write, either by routing through the adapter finalizer or a shared equivalent. Preserve manual-pending behavior.
8. Do not change `src/server.ts`: auto-approve remains enabled and scheduling behavior remains as is. Run API impact analysis only if an unexpected handler change becomes necessary.
9. Run tests, typecheck, migration validation, and GitNexus consequence analysis. Review current dirty-worktree diff and preserve unrelated changes.

## Acceptance Criteria

- A scan with one or many eligible posts creates at most one `COMMENT` draft per prospect and at most one paired `LIKE` draft for that selected post.
- `PostFilter` retains no more than one recent post, and every scan fallback/selection path preserves the one-comment cap.
- A completed comment and a completed like each create exactly one valid `engagement_history` record. Repeating terminal finalization cannot duplicate it.
- Failed, uncertain, budget-refused, and manual-pending actions do not create a history record.
- A completed comment blocks new comment candidate generation for the same tenant/prospect for 14 days; it does not block another prospect, and it permits a candidate at the exact boundary.
- A queued comment that is now cooled down is refused before executor invocation and without a completed budget reservation.
- Existing comment-slot ownership, worker leases, budgets, audits, manual task lifecycle, and enabled auto-approve worker remain intact.

## Test and Verification Plan

- Focused command: `npm test -- src/services/engagement/cooldown-policy.test.ts src/services/engagement/engagement-service.test.ts src/services/action-queue-service.test.ts`.
- Full verification: `npm test` and `npm run typecheck`.
- Migration verification: `npm run db:generate` when schema generation is required, then run PGlite migration-backed engagement tests; inspect generated SQL and migration journal. Do not apply production migrations during tests.
- Impact evidence already gathered: upstream `scanProspect` impact is LOW with two direct callers, including `src/server.ts` ingest flows; upstream `ActionQueueService` impact is MEDIUM with server auto-drain, demo, and focused queue tests. The index is one commit stale, so re-run impact after re-indexing if the implementation changes public symbols materially.
- Before commit, run `gitnexus_detect_changes` with `scope: all`; partial or truncated output is not a clean consequence scan. Exercise `action-queue-safety.test.ts` and non-engagement queue action tests to prove no regression.
- Before any API route modification, run `gitnexus_api_impact`; none is expected.

## Risks and Mitigations

- Provider success cannot be guaranteed after a post-submit crash. Keep existing `UNCERTAIN` semantics and never write successful history from uncertain outcomes.
- A cooldown refusal after claim could strand work or consume quota. Test final action/slot state, budget release, audit event, and executor non-invocation.
- The new history association needs identical behavior in production and memory adapters. Cover both through queue tests and use an additive nullable migration.
- The worktree is already dirty, including target services, schema, migrations, and tests. Implementation must treat these as in-progress user work and reconcile rather than overwrite/revert them.

## Rollback Notes

- Use existing engagement controls/kill switch to pause comment execution before rolling back queue code; inspect claimed actions first.
- The migration is additive. A code rollback can retain the nullable column and unique index without losing data.
- Never delete completion history as a rollback tactic: that would remove the cooldown safeguard and permit repeat comments immediately.
- Restore the prior application version only after workers are stopped; retain `UNCERTAIN` and historical completion records for audit.

## Decisions Requiring Review

1. Approve the nullable unique `engagement_history.scheduled_action_id` association as the completion idempotency guard.
2. Confirm manual `COMPLETED` engagement actions should start the same cooldown as automatic completion. This plan assumes yes.
3. Confirm stale queued actions blocked by cooldown should be terminally `FAILED`/`refused` (recommended) rather than returned to `PENDING` until expiry.

## Definition of Done

- All acceptance criteria pass with focused tests, full `npm test`, and `npm run typecheck`.
- Migration is additive, reviewed, and exercised through the PGlite-backed service tests.
- GitNexus impact/consequence scans complete without partial or truncated results.
- Auto-approve remains enabled and unchanged while scans produce one comment candidate and completions provide durable cooldown evidence.

## Binary Completion Contract

**COMPLETE only if** scan generation is capped at one comment candidate, successful action history is durable and idempotent, and both generation and worker dispatch honor the 14-day comment cooldown without disabling auto-approve.

**INCOMPLETE if** a scan can create two comment drafts for one prospect, successful engagement does not create one durable history record, a second comment can execute within cooldown, the auto-approve worker is changed/disabled, or verification is partial/failing.
