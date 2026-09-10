# Neon Resilience & End-to-End Prospect Lifecycle Pipeline

**Status:** `PENDING_USER_REVIEW` (materially updated — previously approved plan extended with
the scan-window root cause, missing-draft catchup, resilient scan loop, and campaign resume worker)
**Classification:** Bug (DB connection resilience) + Enhancement (worker/queue hardening) + Feature (E2E lifecycle test harness, scan resume/catchup)
**Tier:** Large/risky — external provider (Neon), concurrency, persistence, background workers, retries/idempotency.

---

## 1. Goal

Make the codebase permanently resilient to Neon auto-suspend and connection drops:

1. **Pool & client hardening** so a suspended/cold-starting Neon instance does not produce
   spurious timeouts, crashes, or stuck rows.
2. **Worker resilience** so `autoApproveAndQueueCycle`, `runAutoDrainCycle`, and
   `ActionQueueService.processNextAction` never crash, never drop actions, never leave
   actions stuck in `CLAIMED`, and never duplicate executed actions when the DB drops
   mid-flight. Actions in `scheduled_actions` must stay `PENDING`/`QUEUED` and retry
   cleanly after the DB wakes up.
3. **Correct error semantics** so transient DB drops are never mislabeled as permanent
   `POST_NOT_ELIGIBLE` failures (the draft-generation 500 / `POST_NOT_ELIGIBLE` symptom).
4. **Resilient prospect scan** so a Neon drop during `scanProspect` can no longer leave a
   prospect with a LIKE draft but no COMMENT draft: per-post DB retry, per-post
   transactional writes, and a **missing-draft catchup/reconcile pass** that heals
   already-orphaned posts.
5. **Campaign scan restart/resume** — an idempotent `scanCampaignResume(campaignId)`
   orchestrator (manual endpoint + scheduled worker) that re-scans every enrolled
   prospect, backfills missing drafts, and lets the existing auto-approve/drain workers
   finish likes and comments — without duplicating posts, drafts, or actions.
6. **An end-to-end prospect lifecycle test** (configure → ingest/scan → generate →
   approve → queue like+comment → simulate Neon suspend → resume → drain → verify
   exactly-once completion, no state loss, no duplicates), with exact scripts and
   regression coverage.

## 2. Assumptions & Non-Goals

**Assumptions**
- The working tree contains uncommitted in-progress changes (confirmed via `git status`:
  `src/db/client.ts`, `src/server.ts`, `src/services/action-queue-service.ts`,
  `src/db/drizzle-adapter.ts`, `src/db/schema.ts`, `src/services/engagement/engagement-service.ts`,
  etc.). The builder must build on top of the current tree and preserve these changes.
- `DATABASE_URL` points to a Neon Postgres instance that auto-suspends after idle.
- The queue is single-process today (`setInterval` workers in `src/server.ts`); the
  lease/claim machinery already exists for multi-worker safety and must be preserved.
- Tests run offline via `MemoryStorage` + `FakeExecutor` (existing pattern); live-Neon
  verification is a separate, operator-gated step.
- The scan is triggered today only (a) per-prospect at discovery-ingest time
  (`server.ts:486-490`) and (b) manually via `POST /api/engagement/scan`
  (`server.ts:633`). There is **no** periodic campaign scan today — this is the gap the
  resume worker closes.

**Non-Goals**
- No LinkedIn/browser executor, LLM provider selection, or cooldown/budget policy value changes.
- No new frontend screens (resume endpoint returns JSON; UI already renders drafts).
- No changes to OpenCode/tool configuration, env files, or MCP setup.
- Discovery ("finding the people") is unchanged — the resume worker operates on
  already-enrolled prospects (`campaign_enrollments`); re-discovery remains a separate
  operator action.
- **Schema change is optional and gated on review** (see §12 decision 7): a unique index
  on `engagement_drafts (tenant_id, post_id, action_type)` would make catchup/retry
  provably duplicate-free. Default plan: no migration; duplicate-safety via single-flight
  guard + existence checks + sequential per-prospect processing.

## 3. Root-Cause Analysis (evidence from inspection)

| # | Symptom | Root cause | Evidence |
| --- | --- | --- | --- |
| R1 | First query after Neon resume times out | `connectionTimeoutMillis` (5–10 s pre-hardening) is far below Neon cold-start latency (10–30 s); `idleTimeoutMillis` churns idle clients; no query-level retry exists anywhere in the repo | `src/db/client.ts:14-23` (working tree now 30 s/15 s — hardening partially applied, uncommitted); grep for `retry` found no DB retry wrapper |
| R2 | Worker "drops" actions | `processNextAction` claims a row (`status → CLAIMED`, `src/services/action-queue-service.ts:66`) then runs `resolveSafety` (6+ DB queries, `src/server.ts:107-168`). Any DB throw propagates out of `processNextAction`; the row is never reset to `PENDING` and never finalized → **stuck CLAIMED forever**. Same for `isCommentSlotOwner` (line 71) and `checkEngagementCooldown` (line 91) | `action-queue-service.ts:50-98`; `runAutoDrainCycle` catch at `server.ts:1085` only logs |
| R3 | `autoApproveAndQueueCycle` silently loses actions | `applyReviewDecision` (draft → `APPROVED`) succeeds, then `requestAction` throws on a transient DB error. Next cycle only queries `status='PENDING'` drafts (`server.ts:1111`), so the now-`APPROVED` draft is skipped → **action never queued, data loss** | `server.ts:1098-1160` |
| R4 | Draft-generation 500 / `POST_NOT_ELIGIBLE` | `GET /api/engagement/posts` (`server.ts:646`) and `GET /api/engagement/drafts` (`server.ts:669`) catch **all** errors and return `POST_NOT_ELIGIBLE`. A Neon suspend mid-request surfaces as a permanent-looking `POST_NOT_ELIGIBLE` 500. Additionally, in `resolveSafety`, a missing `engagement_posts` row (e.g., scan insert failed during a drop) yields `postEligible=false` → `SafetyGate` throws `POST_NOT_ELIGIBLE` → action finalized `FAILED` permanently | `server.ts:640-671`; `execution-contracts.ts:60`; `logs/error.log:49` shows `LIKE FAILED → POST_NOT_ELIGIBLE` |
| R5 | Migrations also fail on suspended Neon | `src/migrate.ts:11-13` builds a bare `Pool` with no `connectionTimeoutMillis` | `src/migrate.ts` |
| **R6** | **Today's prospects got a LIKE draft but NO COMMENT draft** | `scanProspect` per-post sequence (`engagement-service.ts:275-417`): post upsert → LIKE draft + revision (2 fast DB writes) → `aiProvider.generateComment()` (external HTTP, Luna `TIMEOUT_MS = 30_000`, `luna-engagement-provider.ts:15`) → COMMENT draft + revision (DB writes). Neon auto-suspend + `idleTimeoutMillis` discarding idle sockets means the DB call **after** the AI round-trip hits a dead/cold connection; `connectionTimeoutMillis` expires → `Connection terminated due to connection timeout`. The per-post `catch` (`engagement-service.ts:414`) swallows the error into `result.errors` and continues — the loop survives, but every prospect is left LIKE-only. The ingest caller (`server.ts:486-490`) ignores the returned result. **No automatic resume exists** — `autoApproveAndQueueCycle` only approves existing PENDING drafts (all LIKEs today), `runAutoDrainCycle` only drains queued actions; neither re-scans | `logs/info.log` 2026-09-10 08:42–09:00: every auto-queued action is a LIKE (drafts `07d3deed`, `31843878`, `712821c1`, `fa6db8dd`, `41ca5161`, `ffd784d0`, `47cc52c3`, `562ceaf5`, `58cd93cc`, `5ee47411`); **zero COMMENT drafts queued all day**. `logs/error.log` + `logs/info.log` 09:01–09:42: repeated `DrizzleQueryError … cause: Error: Connection terminated due to connection timeout` with `[cause]: Error: Connection terminated unexpectedly` in both workers |

### 3.1 Why comments were not generated for today's prospects — the exact causal chain

1. **Scan ran** (discovery ingest auto-scan, `server.ts:486-490`) while Neon was
   suspended or mid-cold-start.
2. **Per prospect**, `scanProspect` (`engagement-service.ts:81`) processed posts in
   sequence. For each post it first wrote the deterministic LIKE draft + revision
   (lines 333-359) — two fast DB writes that succeed while a pooled connection is alive.
3. It then called `aiProvider.generateComment()` (line 372) — an **external HTTPS
   round-trip to the Luna LLM API with a 30 s timeout** (`luna-engagement-provider.ts:15`).
   During that wall-clock gap, Neon's compute paused (idle) and/or the pool's idle socket
   was discarded (`idleTimeoutMillis`), so the pooled client was dead.
4. On return from the AI call, the next DB operation — the `existingCommentDraft` read
   (line 362), the COMMENT draft INSERT (line 383), or `persistRevision` (line 400) —
   needed a connection. The pool tried to establish a new one while Neon was still
   cold-starting; `connectionTimeoutMillis` (5–10 s pre-hardening) expired → pg threw
   `Connection terminated due to connection timeout` (cause `Connection terminated
   unexpectedly`) — **exactly the signature in today's logs**.
5. The per-post `catch` (line 414) recorded `Error processing post <url>: …` into
   `result.errors` and moved to the next post/prospect. **The scan did not crash** — it
   silently produced LIKE-only prospects. The ingest loop's own try/catch (line 488)
   only logs; the returned `ScanProspectResult` (with `errors`) is discarded.
6. **No automatic recovery**: the 30 s `autoApproveAndQueueCycle` only approves drafts
   that already exist (all LIKEs — see logs), and `runAutoDrainCycle` only drains queued
   actions. Neither re-scans prospects. The same connection-drop signature also failed
   `autoApproveAndQueueCycle` at its **first query** (`server.ts:1103`) 10+ times between
   09:01 and 09:42, so even the LIKE approvals stalled mid-window.
7. **Would a re-scan heal it? Yes — but nothing triggers one.** A LIKE-only post is
   re-eligible on re-scan: `accountPostComments` has no PENDING/COMPLETED/UNCERTAIN slot
   for it (slots are created only for queued/executed comments), the LIKE draft is not
   counted by the "1 active comment candidate" gate (line 177-181 counts only COMMENT
   drafts/actions/slots), the post upsert reuses the existing `engagement_posts` row
   (line 304), and `if (!existingCommentDraft)` (line 370) regenerates the missing
   comment. The gap is purely the **absence of an automatic resume trigger** plus the
   **absence of DB retry** around the per-post step.

## 4. Current Behavior & Closest Existing Pattern

- **Existing pattern to reuse:** the atomic claim (`FOR UPDATE SKIP LOCKED`,
  `drizzle-adapter.ts:253-306`), idempotent `insertScheduledAction`
  (`onConflictDoNothing`, `drizzle-adapter.ts:242-251`), idempotent finalization
  (`TERMINAL_STATE_IMMUTABLE` guard, `drizzle-adapter.ts:341-424`), the
  `UNCERTAIN`-on-executor-throw semantics (`action-queue-service.ts:199-211`), the
  single-flight worker guards (`autoDrainRunning`/`autoApproveRunning`, `server.ts:1001,1099`),
  and the existing per-post try/catch in `scanProspect` (`engagement-service.ts:414`).
- **Gap:** nothing between the pool and the services retries transient errors; the
  claim→safety→budget→dispatch pipeline has no "revert to PENDING on pre-dispatch
  failure" path; `scanProspect` has no DB retry, no per-post transaction, no
  missing-draft reconcile pass, and no campaign-level resume trigger.

## 5. Affected Files & Symbols

| File | Change |
| --- | --- |
| `src/db/client.ts` | Pool config hardening (already partially applied in working tree: 30 s connect / 15 s idle / keepAlive); export `createPool()` factory; export `isTransientDbError()` + `withDbRetry()` (or new `src/db/retry.ts`); keep `db`, `withTenantTransaction` exports unchanged |
| `src/db/index.ts` | Re-export the new retry helpers (file is a barrel; no logic change) |
| `src/db/retry.ts` *(new)* | `isTransientDbError(err)`, `withDbRetry(fn, {attempts, baseDelayMs, maxDelayMs, jitter, retryable})`, `TransientDbError` class |
| `src/db/drizzle-adapter.ts` | Add `recoverStaleClaims(tenantId, accountId, staleAfterMs)`; wrap claim/finalize/update-result internals with `withDbRetry` where idempotent |
| `src/db/db-adapter.ts` | Add optional `recoverStaleClaims?` to `DBAdapter` interface |
| `src/db/memory-storage.ts` | Implement `recoverStaleClaims` for parity (tests use it) |
| `src/services/action-queue-service.ts` | Pre-dispatch transient-error → revert to `PENDING`; stale-claim recovery call; typed `DB_RETRYABLE` result |
| `src/server.ts` | `resolveSafety` transient-error typing; `autoApproveAndQueueCycle` retry + APPROVED-draft pickup; `runAutoDrainCycle` retry + lease release in `finally`; route error mapping for `/api/engagement/posts` and `/api/engagement/drafts` (503 `DB_UNAVAILABLE`); shared `handleDbError` helper; **new `POST /api/engagement/resume` route + scheduled `scanResumeCycle` worker (single-flight)** |
| `src/services/engagement/engagement-service.ts` | **Extract per-post step into a private `processPost` method** wrapped in `withDbRetry`; **wrap per-post DB writes in a transaction** (post upsert + LIKE draft + revision in tx1; re-check + COMMENT draft + revision in tx2, AI call outside any tx); **new `reconcileMissingDrafts(tenantId, prospectId?)` catchup pass** (LIKE-without-COMMENT and COMMENT-without-LIKE, respecting the 1-active-comment gate + cooldown); **new `scanCampaignResume(campaignId)` orchestrator** (enumerate enrolled prospects → resilient `scanProspect` each → reconcile → summary); surface `errors` in the ingest caller |
| `src/services/engagement/scan-resume-service.ts` *(new, optional)* | If `scanCampaignResume` grows beyond a method, extract the orchestrator here (keeps `engagement-service.ts` focused) |
| `src/migrate.ts` | Reuse hardened pool settings (or `createPool()`) |
| `scripts/db-push.ts`, `scripts/migrate-post-comments.ts` | Reuse `createPool()` (candidate; verify before editing) |
| `src/services/action-queue-service.test.ts`, `src/services/action-queue-safety.test.ts` | New resilience regression tests |
| `src/db/retry.test.ts` *(new)* | Classifier + backoff unit tests |
| `src/services/action-queue-resilience.test.ts` *(new)* | Fault-injection adapter tests |
| `src/services/engagement/engagement-service.test.ts` | **New scan-resilience tests** (see §8.6): transient failure mid-post → LIKE-only + `errors`; re-scan heals comment without duplicating LIKE/post; reconcile pass; campaign resume idempotency |
| `scripts/e2e-prospect-lifecycle-resilience.ts` *(new)* | Offline E2E lifecycle + simulated suspend + **scan-timeout catchup scenario** |
| `scripts/e2e-neon-resilience.ts` *(new)* | Live-Neon E2E (operator-gated) |
| `docs/plans/neon-resilience-and-e2e-pipeline.md` | This plan |

**Symbols with callers (GitNexus impact, LOW risk, exact):** `ActionQueueService.processNextAction`
(3 direct callers: `runAutoDrainCycle`, `scripts/demo-recruitment-pipeline.ts`, tests);
`DBAdapter.claimNextScheduledAction` (3 implementers: DrizzleAdapter, MemoryStorage, interface);
`EngagementService.scanProspect` (2 callers: `server.ts:487` ingest loop, `server.ts:633` scan route,
plus tests). No HIGH/CRITICAL risk found; `risk: UNKNOWN` cases (anonymous `resolveSafety` closure)
were confirmed by direct file reads. Index is behind HEAD — re-run `gitnexus analyze` before
implementation if graph-gated edits are required.

## 6. Contract Changes

### 6.1 Frontend/API contract
- `GET /api/engagement/posts` and `GET /api/engagement/drafts`:
  - On **transient DB error** → `503` `{ status: 'refused', code: 'DB_UNAVAILABLE', message, correlationId }` (retryable).
  - On **other errors** → keep existing codes (`POST_NOT_ELIGIBLE` only for genuine
    eligibility/not-found conditions, never for DB failures).
- **New** `POST /api/engagement/resume` — body `{ campaignId?: string }` (omit for
  all ready prospects). Returns `{ status: 'completed', prospectsScanned, draftsBackfilled, errors, correlationId }`.
  Idempotent: safe to call repeatedly; single-flight guard returns `{ status: 'already_running' }` if a resume is in progress.
- No other route signatures change. `structuredRefusal` shape is preserved.

### 6.2 DB contract (no schema change by default)
- `scheduled_actions.status` lifecycle gains one explicit transition:
  `CLAIMED → PENDING` via `recoverStaleClaims` (only when the owning lease is
  expired/absent) and via the pre-dispatch transient-error revert.
- `error_code` values added: `DB_TRANSIENT` (revert marker), `DB_UNAVAILABLE` (route-level).
- `DBAdapter` gains optional `recoverStaleClaims?(tenantId, accountId, staleAfterMs)`.
- **Checkpoint contract (no new columns):** the persisted state itself is the checkpoint —
  `engagement_posts` row present ∧ LIKE draft present ∧ COMMENT draft absent = "needs
  comment backfill". `reconcileMissingDrafts` reads exactly this shape.

### 6.3 New internal contracts
- `isTransientDbError(err: unknown): boolean` — classifies:
  - Node net errors: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `socket hang up`.
  - PG error codes: `57P01 admin_shutdown`, `57P02 crash_shutdown`, `57P03 cannot_connect_now`,
    `08xxx` connection exceptions, `53300 too_many_connections`, `40001 serialization_failure`,
    `40P01 deadlock_detected`.
  - Message patterns: `Connection terminated unexpectedly`, `Connection terminated due to
    connection timeout` (the exact observed signature), `terminating connection due to
    administrator command`, `timeout expired`, `Client has encountered a connection error`,
    `read ECONNRESET`, `write EPIPE`, `Connection refused`, `no response to PING`.
- `withDbRetry(fn, opts?)` — exponential backoff + jitter, default 3 attempts,
  `baseDelayMs 250`, `maxDelayMs 2500`. **Callers decide retry-safety:** reads and
  idempotent writes (claim, finalize, insert-on-conflict) may retry; non-idempotent
  side effects (executor dispatch) never retry inside the wrapper.
- `TransientDbError` — typed error so `processNextAction` can distinguish
  "revert to PENDING" from "finalize FAILED".
- `EngagementService.processPost(tenantId, prospect, raw, voiceProfile?)` *(private)* —
  the per-post unit: tx1 (post upsert + LIKE draft + revision) → AI call (outside tx) →
  tx2 (re-check no COMMENT draft → insert COMMENT draft + revision). Wrapped in
  `withDbRetry`; a transient failure aborts cleanly (tx rollback) and is retried; a
  non-transient failure leaves the post in the "needs comment" checkpoint state.
- `EngagementService.reconcileMissingDrafts(tenantId, prospectId?)` — catchup pass:
  for each post with a LIKE draft and no COMMENT draft (and no `accountPostComments`
  slot in PENDING/COMPLETED/UNCERTAIN, comment cooldown allowed, and the prospect's
  1-active-comment gate not already consumed) → run `processPost`'s comment half.
  Inverse (COMMENT without LIKE) → insert LIKE draft. Returns `{ backfilledComments, backfilledLikes }`.
- `EngagementService.scanCampaignResume(campaignId?)` — enumerate prospects via
  `campaign_enrollments` (or all `READY_FOR_CAMPAIGN`/`APPROVED_FOR_OUTREACH` when no
  campaignId), run resilient `scanProspect` per prospect (per-prospect isolation: one
  prospect's failure is recorded, never aborts the worker), then `reconcileMissingDrafts`
  per prospect. Returns a summary; re-runnable with no duplicates.

## 7. Implementation Sequence (dependency order)

1. **`src/db/retry.ts` (new)** — `TransientDbError`, `isTransientDbError`, `withDbRetry`.
   Unit tests in `src/db/retry.test.ts` (include the observed `Connection terminated due
   to connection timeout` / `Connection terminated unexpectedly` signatures).
2. **`src/db/client.ts`** — pool hardening (already partially applied; finish):
   `connectionTimeoutMillis: 30_000`, `idleTimeoutMillis: 30_000`, `keepAlive: true`,
   `keepAliveInitialDelayMillis: 10_000`, `max: 10`, `application_name: 'recruitmentos'`.
   Keep the pool `error` listener. Extract `createPool(overrides?)` factory; `db` and
   `withTenantTransaction` unchanged. Re-export retry helpers from `src/db/index.ts`.
3. **`src/db/drizzle-adapter.ts`** — add `recoverStaleClaims` (SQL UPDATE:
   `status='CLAIMED' AND claimed_at < now() - interval AND NOT EXISTS (active lease for
   account)` → `PENDING`, `error_code='DB_TRANSIENT'`). Wrap `claimNextScheduledAction`,
   `updateScheduledActionResult`, `finalizeCommentAction` bodies with `withDbRetry`
   (all idempotent/atomic). Mirror in `memory-storage.ts` and `db-adapter.ts`.
4. **`src/services/action-queue-service.ts`** — restructure `processNextAction`:
   - Call `recoverStaleClaims` after lease validation (heals stuck rows).
   - Wrap claim → safety → cooldown → budget-reservation in a try/catch:
     - `TransientDbError` (or `isTransientDbError`) **before dispatch** → retried
       `updateScheduledActionResult(..., { status: 'PENDING', errorCode: 'DB_TRANSIENT' })`,
       return `{ processed: false, reason: 'DB_RETRYABLE' }`.
     - Non-transient → existing FAILED semantics.
   - Keep the dispatch try/catch `UNCERTAIN` semantics unchanged (never duplicate).
5. **`src/server.ts`** (workers + routes):
   - `resolveSafety`: wrap the DB-query section; rethrow DB errors as `TransientDbError`.
   - `autoApproveAndQueueCycle`: (a) wrap cycle queries in `withDbRetry`; (b) after
     approving a draft, retry `requestAction` with `withDbRetry`; (c) change the draft
     query to also include `APPROVED` drafts that have no queued action for
     `auto-${draft.id}` (closes R3 data-loss gap — `requestAction` is idempotent via
     `semanticKey`).
   - `runAutoDrainCycle`: wrap lease+process in `withDbRetry`; move lease release into
     `finally`; treat `DB_RETRYABLE` as "skip this tick, retry next".
   - Route error mapping: add `handleDbError(err, res, req)` helper; use it in the two
     engagement GET routes (503 `DB_UNAVAILABLE` on transient, existing codes otherwise).
   - **New `scanResumeCycle` worker** (`setInterval`, e.g. every 10 min, single-flight
     guard like `autoDrainRunning`) calling `engagementService.scanCampaignResume()` for
     all ready prospects; **new `POST /api/engagement/resume`** route for manual trigger.
   - Ingest loop (`server.ts:486-490`): log `ScanProspectResult.errors` when non-empty
     (today they are silently discarded).
6. **`src/services/engagement/engagement-service.ts`** — scan resilience:
   - Extract the per-post body (lines 275-417) into `processPost` with the tx1/AI/tx2
     structure and `withDbRetry` (step 6.3 contract). Keep the per-post catch so one
     post never kills the prospect loop.
   - Add `reconcileMissingDrafts` and `scanCampaignResume` per §6.3.
   - Keep `maxNewPostsAllowed` gate and cooldown semantics identical.
7. **`src/migrate.ts` (+ scripts)** — use `createPool()` so migrations survive suspend.
8. **Tests** (see §8) — write regression tests alongside each step (test-first).
9. **E2E scripts** (see §9).

## 8. Test Plan

### 8.1 Unit — `src/db/retry.test.ts`
- `isTransientDbError` returns true for: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`,
  `EPIPE`, PG codes `57P01/57P02/57P03/53300/40001/40P01`, message patterns
  (`Connection terminated unexpectedly`, `Connection terminated due to connection timeout`,
  `timeout expired`, `Client has encountered a connection error`).
- Returns false for: `POST_NOT_ELIGIBLE`, `ACTION_DUPLICATE`, `BUDGET_EXCEEDED`,
  `TERMINAL_STATE_IMMUTABLE`, generic `Error('boom')`.
- `withDbRetry` retries exactly N times with backoff, succeeds on attempt 2, and
  rethrows after exhausting attempts; non-transient errors are not retried.

### 8.2 Unit — `action-queue-service.test.ts` / `action-queue-safety.test.ts` (additions)
- `resolveSafety` throws `TransientDbError` → action back to `PENDING` with
  `error_code='DB_TRANSIENT'`, no `engagement_history`, no budget consumed,
  `result.reason === 'DB_RETRYABLE'`.
- `resolveSafety` throws non-transient error → action `FAILED` (existing semantics).
- `isCommentSlotOwner` / `checkEngagementCooldown` throw transient → action `PENDING`.
- Stale `CLAIMED` row (claimed_at older than TTL, lease expired) → recovered to
  `PENDING` and claimable; fresh `CLAIMED` row with active lease → untouched.
- Executor throws after dispatch → still `UNCERTAIN` (no duplication regression).

### 8.3 Integration — `src/services/action-queue-resilience.test.ts` (new)
- Fault-injection `DBAdapter` proxy wrapping `MemoryStorage`: fails the next N calls
  with `TransientDbError`, then passes through.
- Scenario: claim succeeds → safety query fails (fault) → assert revert to `PENDING`;
  re-run with faults exhausted → action completes exactly once; `engagement_history`
  has exactly 1 row; `account_post_comments` slot `COMPLETED` once.

### 8.4 Route-level
- Extract `handleDbError` and unit-test the mapping: transient → `503 DB_UNAVAILABLE`;
  genuine not-found → `404 POST_NOT_ELIGIBLE` (posts route) / existing codes (drafts route).
- `POST /api/engagement/resume`: returns summary; second concurrent call returns
  `already_running`; transient DB error → `503 DB_UNAVAILABLE`.

### 8.5 Unit — `engagement-service.test.ts` (scan resilience, new)
- **Regression (the today bug):** `generateComment` (or the comment INSERT) throws a
  transient DB error once → `scanProspect` returns `errors` containing the post URL,
  `draftsCreated === 1` (LIKE only), LIKE draft exists, COMMENT draft absent, post row
  exists. **Re-scan with faults drained** → COMMENT draft created, `draftsCreated === 1`
  (comment only), LIKE draft NOT duplicated, `engagement_posts` row NOT duplicated.
- **Retry idempotency:** fault-inject the comment INSERT to fail once inside
  `withDbRetry` → retry succeeds → exactly 1 COMMENT draft + 1 revision.
- **`reconcileMissingDrafts`:** seed a post with LIKE draft + no COMMENT draft (and a
  second post with COMMENT draft + no LIKE draft) → reconcile backfills exactly the
  missing halves; re-running reconcile creates nothing new.
- **Gate respect:** when a prospect already has 1 active COMMENT candidate,
  `reconcileMissingDrafts` does NOT backfill a second comment for another LIKE-only post.
- **`scanCampaignResume`:** 2 enrolled prospects; prospect B's comment insert throws
  transient → summary records B's error, prospect A completes fully; second resume run
  (faults drained) backfills B's comment; total posts/drafts/actions unchanged for A.

### 8.6 E2E — see §9. Commands:
```bash
npm run typecheck
npm test
npm run build
```

## 9. End-to-End Prospect Lifecycle Test

### 9.1 Offline script — `scripts/e2e-prospect-lifecycle-resilience.ts` (new, `tsx`)
Uses `MemoryStorage` + `FakeExecutor` + a fault-injection wrapper (same proxy as §8.3).
Steps (each prints a PASS/FAIL assertion):
1. **Configure prospect** — insert prospect, set `currentStage='READY_FOR_CAMPAIGN'`,
   create `engagementControls` (LIKE/COMMENT enabled), `dailyActionBudgets` (limit ≥ 2),
   `browserAccounts` HEALTHY, acquire lease.
2. **Ingest/scan** — `EngagementService.scanProspect` with a fixture post source →
   assert ≥1 `engagement_post`, ≥1 LIKE draft, ≥1 COMMENT draft, all `PENDING`.
3. **Generate & queue** — `applyReviewDecision(APPROVED)` + `requestAction` for LIKE and
   COMMENT → assert 2 `scheduled_actions` in `PENDING` with distinct `idempotency_key`.
4. **Simulate Neon suspend** — activate fault window: next N DB calls throw
   `TransientDbError` (mimics `Connection terminated due to connection timeout`).
   - Run `processNextAction` → assert `reason === 'DB_RETRYABLE'`, action still `PENDING`
     (not stuck `CLAIMED`), no history, no budget consumed.
   - Run `autoApproveAndQueueCycle`-equivalent → assert no crash, drafts remain
     `APPROVED`, no action lost.
5. **Resume** — deactivate faults; run `processNextAction` until queue empty.
6. **Verify exactly-once** — assert both actions `COMPLETED`; `engagement_history` has
   exactly 2 rows (one per action); `account_post_comments` slot `COMPLETED` once;
   budget `completedCount` matches; re-running `processNextAction` returns
   `NO_PENDING_ACTIONS`; `requestAction` with the same idempotency key returns the
   existing action (no duplicate).
7. **Stale-claim recovery** — manually set an action to `CLAIMED` with old `claimed_at`
   and no lease → next `processNextAction` recovers and completes it.
8. **Scan-timeout catchup (the today bug)** — new prospect; fault-inject the DB call
   immediately after `generateComment` (comment INSERT) → `scanProspect` returns
   LIKE-only + `errors`. Assert LIKE draft exists, COMMENT draft absent. Then run
   `scanCampaignResume` (faults drained) → assert COMMENT draft backfilled, LIKE draft
   still exactly 1, post row still exactly 1. Then run the auto-approve + drain
   equivalent → both actions complete exactly once.

Run: `npx tsx scripts/e2e-prospect-lifecycle-resilience.ts` (exit 0 = PASS).

### 9.2 Live-Neon script — `scripts/e2e-neon-resilience.ts` (new, operator-gated)
Same lifecycle against real `DATABASE_URL` via `createPool()`. Optional
`NEON_SUSPEND_TEST=1` pauses mid-run (default 45 s) to force an actual suspend; the
script then asserts the queue resumes and completes without stuck `CLAIMED` rows or
duplicates. **Requires Tushar's explicit approval to run** (real Neon, may incur
cold-start latency; uses a disposable tenant/account IDs).

### 9.3 Regression coverage
- All §8 tests run in `npm test` (CI-able, offline).
- The offline E2E script is added to the repo and documented in the handoff; it is
  deterministic (no network, no LLM — fixture post source + FakeExecutor).

## 10. Acceptance Criteria

1. `npm run typecheck`, `npm test`, `npm run build` all pass.
2. Pool config: `connectionTimeoutMillis ≥ 30s`, `idleTimeoutMillis ≥ 30s`,
   `keepAlive: true`; `createPool()` reused by `src/migrate.ts`.
3. `withDbRetry` + `isTransientDbError` exist, unit-tested, and used at the DB boundary.
4. A transient DB error during `processNextAction` **before dispatch** leaves the action
   `PENDING` (never stuck `CLAIMED`, never `FAILED`), returns `DB_RETRYABLE`, and the
   next tick completes it exactly once.
5. A transient DB error **after dispatch** leaves the action `UNCERTAIN` (never
   duplicated, never reset to `PENDING`).
6. `autoApproveAndQueueCycle` never loses an approved-but-unqueued draft: APPROVED
   drafts without a queued action are picked up on the next cycle.
7. `GET /api/engagement/posts` and `GET /api/engagement/drafts` return `503
   DB_UNAVAILABLE` on transient DB errors — never `POST_NOT_ELIGIBLE` for a DB drop.
8. `recoverStaleClaims` heals pre-existing stuck `CLAIMED` rows (lease-expired only).
9. **Scan resilience:** a transient DB error during `scanProspect`'s comment step leaves
   the post in the "LIKE draft present, COMMENT draft absent" checkpoint state, records
   the error in `result.errors`, and does NOT abort the prospect loop or the campaign scan.
10. **Catchup:** `reconcileMissingDrafts` backfills the missing COMMENT (or LIKE) draft
    for every orphaned post, respects the 1-active-comment gate and cooldown, and is
    idempotent (re-running creates nothing new).
11. **Campaign resume:** `scanCampaignResume(campaignId)` (endpoint + scheduled worker,
    single-flight) re-scans all enrolled prospects, backfills missing drafts, and
    produces no duplicate `engagement_posts`, `engagement_drafts`, `scheduled_actions`,
    or `account_post_comments` rows when re-run.
12. Offline E2E script passes end-to-end (exit 0) including the scan-timeout catchup
    scenario (§9.1 step 8) and asserts exactly-once semantics.
13. No new dependencies; no schema/migration changes unless decision 7 (§12) is approved.

## 11. Risks & Rollback

| Risk | Mitigation | Rollback |
| --- | --- | --- |
| Retry amplifies load during a long outage | Bounded attempts (3), backoff+jitter, retry only transient errors, single-process workers | Revert `withDbRetry` call sites; pool settings are env-independent constants |
| `recoverStaleClaims` re-claims an action a slow worker is still executing → duplicate | Only reclaim when the account lease is expired/absent AND `claimed_at` older than TTL (default 15 min, > lease TTL 5 min); document that BROWSER actions longer than TTL need a higher TTL | Disable via flag; TTL is a constant |
| `UNCERTAIN` semantics change accidentally | Dispatch try/catch untouched; only pre-dispatch path changes | Git revert of `action-queue-service.ts` |
| `POST_NOT_ELIGIBLE` mapping change hides real eligibility issues | `handleDbError` only intercepts `isTransientDbError`; genuine not-found/eligibility paths keep their codes | Revert `server.ts` route mapping |
| **Retry re-invokes the LLM** (comment generation) after a post-AI DB failure → double LLM cost | Retry budget small (3); the AI call is only re-run when the post-AI DB write failed (rare); `if (!existingCommentDraft)` re-check prevents DB duplicates | Reduce attempts to 2; log LLM re-invocations |
| **Concurrent resume workers double-insert drafts** (`engagement_drafts` has no unique (tenant, post, action_type) constraint) | Single-flight guard on the resume worker + sequential per-prospect processing + existence re-checks inside tx2; optional unique-index migration (decision 7) makes it provably safe | Disable the scheduled resume worker; keep only the manual endpoint |
| **Resume worker re-scans a prospect whose comment was already executed** | `accountPostComments` PENDING/COMPLETED/UNCERTAIN slot check + COMMENT-draft existence check + cooldown gate all skip executed posts | Revert `scanCampaignResume` wiring |
| Live-Neon E2E incurs cost/latency | Operator-gated, disposable IDs, `NEON_SUSPEND_TEST` opt-in | Skip script; offline E2E is the CI gate |
| Uncommitted working-tree changes conflict | Builder diffs against current tree; no unrelated files touched | `git diff` review before commit |

## 12. Decisions Requiring Tushar's Review

1. **Retry budget:** 3 attempts, 250 ms/1 s/2.5 s + jitter — acceptable, or env-configurable?
2. **Pool values:** `connectionTimeoutMillis 30s`, `idleTimeoutMillis 30s`, `max 10` — approve?
3. **`statement_timeout`:** recommend **not** adding (long scans/LLM waits); confirm.
4. **Stale-claim TTL:** 15 min, lease-expired-only — approve? (BROWSER executors running
   longer than 15 min would need a higher TTL.)
5. **Error-code mapping:** transient DB errors on the two engagement GET routes → `503
   DB_UNAVAILABLE` (was `500 POST_NOT_ELIGIBLE`).
6. **Live-Neon E2E:** approve running `scripts/e2e-neon-resilience.ts` against the real
   Neon instance (operator-gated, opt-in suspend).
7. **Unique index on `engagement_drafts (tenant_id, post_id, action_type)`:** small
   migration that makes catchup/retry provably duplicate-free (recommended). Default
   without it: single-flight + existence checks (slightly weaker under multi-process
   deployment). Approve the migration or accept the weaker default?
8. **Resume worker cadence:** 10 min `setInterval` for `scanResumeCycle` — approve, or
   manual endpoint only?
9. **LLM re-invocation on retry:** accept that a post-AI DB failure may re-run
   `generateComment` (bounded by retry budget) — approve?

## 13. Definition of Done

- All §10 acceptance criteria met with recorded evidence (test output, typecheck, build).
- Offline E2E script passes (including scan-timeout catchup); live-Neon run recorded if approved.
- Consequence scan recorded in handoff: sibling callers (`demo-recruitment-pipeline.ts`,
  tests), shared state (claim/budget/lease), API contracts, idempotency, provider
  boundary (LLM re-invocation), frontend error rendering.
- Handoff follows the engineering-workflow completion template
  (`coding-builder → coding-tester → coding-reviewer`).

## 14. Inspected Files

`src/db/client.ts`, `src/db/index.ts`, `src/db/schema.ts`, `src/db/db-adapter.ts`,
`src/db/drizzle-adapter.ts`, `src/db/memory-storage.ts`, `src/db/tenant-context.ts`,
`src/migrate.ts`, `src/server.ts`, `src/services/action-queue-service.ts`,
`src/services/action-queue-service.test.ts`, `src/services/action-queue-safety.test.ts`,
`src/services/lease-service.ts`, `src/services/engagement/engagement-service.ts`,
`src/services/engagement/engagement-service.test.ts`,
`src/services/engagement/engagement-ai-provider.ts`,
`src/services/engagement/luna-engagement-provider.ts`,
`src/services/engagement/execution-contracts.ts`, `src/logger.ts`,
`src/executors/opencli.ts`, `package.json`, `drizzle.config.ts`,
`scripts/demo-recruitment-pipeline.ts`, `docs/plans/0.2-engagement-native-integration-evidence-plan.md`,
`docs/plans/fix-migration-and-e2e-run.md`, `logs/error.log`, `logs/info.log`.
GitNexus impact: `processNextAction` (LOW, exact, 3 direct callers), `claimNextScheduledAction`
(LOW, 3 implementers), `scanProspect` (LOW, 2 callers + tests). Index is behind HEAD — re-run
`gitnexus analyze` before implementation if graph-gated edits are required.