# Post Integrity and Queue Resilience — Audit Remediation

**Status:** `PENDING_USER_REVIEW`
**Classification:** Enhancement (correctness + resilience) — remediation of the approved audit findings
**Tier:** Medium — persistence (new column + new status value), queue state machine, external provider (LinkedIn/OpenCLI), concurrency with auto-drain/auto-queue workers
**Scope:** RecruitmentOS → sales / operations / product (engagement + queue)

---

## 1. Goal

Remediate the five approved audit findings so the system (a) never engages with
fabricated posts or fabricated profile-feed URLs, (b) only ever queues actions
against valid LinkedIn post/activity URLs, (c) dead-letters queue items instead of
hot-looping, (d) bounds the AutoQueue queries that risk Neon pool timeouts, and
(e) stops logging normal throttle/cooldown checks as errors.

## 2. Assumptions

- `scheduled_actions.status` is `varchar(50)` with **no DB-level enum constraint**
  (verified in `src/db/schema.ts:178`), so adding a `PAUSED_BUDGET` status value
  requires **no migration**.
- The only production path that inserts engagement rows into `scheduled_actions`
  is `EngagementService.requestAction` (`engagement-service.ts:788`). The
  `ActionQueueService.scheduleAction` path is used by tests and non-engagement
  actions (visit/connection/message) and is out of scope for URL validation.
- `POST_NOT_ELIGIBLE` is the established error code for post-eligibility refusals
  (`execution-contracts.ts:60`, `server.ts:77`) and will be reused for invalid
  post URLs rather than introducing a new code.
- The audit's "retry ceiling" intent: execution failures such as
  `SELECTOR_MISMATCH` / `POST_NOT_ELIGIBLE` currently dead-letter to `FAILED` on
  the first failure (`action-queue-service.ts:234`). The fix adds **bounded
  retries (max 3) with backoff before dead-lettering**, so a transient DOM
  mismatch gets another chance without looping forever.

## 3. Non-Goals

- No change to the `visit` / `connection` / `message` action types or their
  payload validation.
- No change to the `engagement_posts` / `engagement_drafts` schema.
- No UI changes (the queue list already renders whatever status the row carries;
  `PAUSED_BUDGET` will display as a non-terminal status).
- No change to the audit-log events (`action.refused`, `action.budget_exceeded`)
  — those remain; only the console log level changes.
- No re-architecture of `scanCampaignResume`'s unbounded prospect query (noted in
  §12 as a related risk, out of scope).

## 4. User Journeys

1. **Operator scans a prospect with no discoverable posts.** Today the system
   fabricates a fake post ("Sharing our latest milestones…") and queues a LIKE
   against `/recent-activity/all/#post-0`. After the fix: no draft is created,
   the scan reports 0 posts found, and nothing is queued.
2. **OpenCLI returns a post item without a URL.** Today the system fabricates
   `/recent-activity/all/#post-{i}`. After the fix: the item is skipped.
3. **Operator approves a draft whose post URL is not a real LinkedIn post URL.**
   After the fix: `requestAction` refuses with `POST_NOT_ELIGIBLE`; nothing enters
   `scheduled_actions`.
4. **Daily budget is exhausted.** Today the action flips back to `PENDING` and is
   re-claimed every 180 s drain cycle (hot loop). After the fix: the action moves
   to `PAUSED_BUDGET` with `scheduled_for` pushed to the next budget window; it is
   not claimable while paused and resumes automatically when the window rolls.
5. **A LIKE fails with `SELECTOR_MISMATCH` (transient DOM issue).** Today it
   dead-letters to `FAILED` immediately. After the fix: it retries up to 3 times
   with backoff, then dead-letters to `FAILED`.
6. **Cooldown is active.** Today the drain worker logs `[ERROR] ✗ COMMENT FAILED
   → COOLDOWN_ACTIVE` every cycle. After the fix: throttle/cooldown refusals log
   at `[INFO]`.

## 5. Current Behavior (verified)

| # | Finding | Location | Current behavior |
| --- | --- | --- | --- |
| 1a | Synthetic post generator | `engagement-service.ts:255-263` | When `rawPosts.length === 0`, fabricates `{ postUrl: "{profile}/recent-activity/all/#post-0", postText: "Sharing our latest milestones…" }` and pushes it into `kept` → becomes a LIKE draft + queued action. |
| 1b | Synthetic profile-feed URL | `profile-activity-post-source.ts:57-59` | When an OpenCLI item has no `url`, fabricates `{profile}/recent-activity/all/#post-{i}`. |
| 2 | No post-URL validation | `engagement-service.ts:725,788` | `requestAction` inserts `payload.postUrl = post.postUrl` into `scheduled_actions` with no URL-shape check. |
| 3a | Budget hot loop | `action-queue-service.ts:133-145` | On `reserveBudget()` returning null, sets `status: 'PENDING'` + `errorCode: 'BUDGET_EXCEEDED'` → re-claimed every cycle. |
| 3b | No retry ceiling | `action-queue-service.ts:233-235` | Any non-`MANUAL_CONFIRMATION_PENDING` execution failure → `FAILED` immediately (no retry). |
| 4 | Unbounded AutoQueue queries | `server.ts:1267-1287` | Three `findMany` calls (PENDING actions, PENDING drafts, APPROVED drafts) with no `limit`/`orderBy`. |
| 5 | Throttle logged as ERROR | `server.ts:1196-1199` | `console.error('[AutoDrain] ✗ …')` fires for any failure **or any reason**, including `COOLDOWN_ACTIVE` / `BUDGET_EXCEEDED`. |

## 6. Affected Components / Files

| File | Change |
| --- | --- |
| `src/services/engagement/post-url-validator.ts` | **NEW** — `isValidLinkedInPostUrl(url): boolean` + `assertValidLinkedInPostUrl(url): void`. |
| `src/services/engagement/engagement-service.ts` | Delete synthetic generator (255-263); call `assertValidLinkedInPostUrl(post.postUrl)` in `requestAction` before the `scheduled_actions` insert (≈788); treat `PAUSED_BUDGET` in the idempotency branch (735-757). |
| `src/services/engagement/profile-activity-post-source.ts` | Remove synthetic URL fallback (57-59); `continue` when `item.url` is not an `http(s)` string. |
| `src/services/action-queue-service.ts` | Budget-exceeded → `PAUSED_BUDGET` + `scheduledFor` push (133-145); retry ceiling on execution failure (233-235); call `resumePausedActions` at start of `processNextAction` (≈59). |
| `src/db/schema.ts` | Add `attemptCount: integer('attempt_count').default(0).notNull()` to `scheduledActions` (≈169-193). |
| `src/types.ts` | `ScheduledAction.status` union += `'PAUSED_BUDGET'`; add `attemptCount?: number` (168-190). |
| `src/db/db-adapter.ts` | Extend `updateScheduledActionResult` result type with `attemptCount?` / `scheduledFor?`; add optional `resumePausedActions(now?)` to the interface (33-41). |
| `src/db/drizzle-adapter.ts` | `attemptCount` in `insertScheduledAction` / `claimNextScheduledAction` mapping / `updateScheduledActionResult`; add `resumePausedActions` SQL (≈287-368). |
| `src/db/memory-storage.ts` | Same as drizzle adapter for the in-memory twin (350-466). |
| `src/server.ts` | AutoQueue: `limit: 50` + `orderBy: [asc(createdAt)]` on the three queries (1267-1287); demote throttle/cooldown refusals to `console.log` (1196-1199). |
| `drizzle/0009_post_integrity_and_queue_resilience.sql` | **NEW migration** — `ALTER TABLE "scheduled_actions" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;` |
| Tests | See §10. |

## 7. Contracts

### 7.1 Post URL validation (new)

`assertValidLinkedInPostUrl(url)` accepts only real LinkedIn post/activity URL
forms (host `linkedin.com` / `www.linkedin.com`, http/https):

```
^https?:\/\/(www\.)?linkedin\.com\/
  (?:posts\/[^/?#]+\/[^/?#]+            # post permalink: /posts/{author}/{slug}
   |feed\/update\/urn:li:(?:activity|ugcPost|share):\d+   # feed activity/UGC/share
  )(?:[?#].*)?$
```

- Rejects: profile URLs (`/in/…`), profile-feed fragments (`/recent-activity/all/#post-0`),
  non-LinkedIn hosts (`fixture.test`, `example.com`), bare `/posts/{one-segment}`.
- The regex is deliberately aligned with the URL forms already recognized by
  `canonicalPostIdentifier` (`post-identity.ts`) and used in production tests
  (`/feed/update/urn:li:activity:{id}/?trk=feed`, `/posts/{author}/{slug}-{id}`).

**Enforcement points:**
1. **Hard gate (required):** `requestAction` — throw `POST_NOT_ELIGIBLE` (message
   `"Post URL is not a valid LinkedIn post/activity URL"`) before the
   `scheduled_actions` insert. Surfaces as HTTP 422 `{ status: 'refused', code:
   'POST_NOT_ELIGIBLE' }` via the existing handler (`server.ts:857-861`).
2. **Soft filter (defense-in-depth):** `scanProspect` — skip raw posts whose URL
   fails validation and count them in `postsFiltered`, so invalid URLs never
   become drafts. (Decision point D1.)

### 7.2 Queue state machine

| Status | Claimable? | Terminal? | Notes |
| --- | --- | --- | --- |
| `PENDING` | Yes | No | Unchanged. |
| `CLAIMED` | No | No | Unchanged. |
| `PAUSED_BUDGET` (**new**) | **No** | **No** | Budget-exceeded pause. `scheduled_for` pushed to next budget window (next local midnight). Resumed to `PENDING` by `resumePausedActions` once `scheduled_for <= now()`. |
| `COMPLETED` / `FAILED` / `UNCERTAIN` / `CANCELLED` | No | Yes | Unchanged; `TERMINAL_SCHEDULED_ACTION_STATUSES` untouched (PAUSED_BUDGET is deliberately not terminal). |

- `claimNextScheduledAction` (both adapters) filters `status = 'PENDING'` only, so
  `PAUSED_BUDGET` rows are never claimed → hot loop eliminated.
- `resumePausedActions(now)` (new, both adapters): `UPDATE … SET status='PENDING',
  error_code=NULL WHERE status='PAUSED_BUDGET' AND scheduled_for <= now`. Called
  at the top of `processNextAction` next to `recoverStaleClaims` (guarded by
  `if (this.db.resumePausedActions)` like the existing optional-method pattern).
- `requestAction` idempotency branch (`engagement-service.ts:735-757`): a
  `PAUSED_BUDGET` existing action falls into the `else` → returns `QUEUED` with
  the existing action (it will resume when the budget window rolls). No code
  change strictly required; verified behavior only.

### 7.3 Retry ceiling

- New column `attempt_count integer NOT NULL DEFAULT 0` on `scheduled_actions`.
- `MAX_EXECUTION_ATTEMPTS = 3`.
- `RETRYABLE_EXECUTION_ERROR_CODES = ['SELECTOR_MISMATCH', 'POST_NOT_ELIGIBLE',
  'RATE_LIMITED', 'EXECUTION_TIMEOUT', 'PROVIDER_UNAVAILABLE']` (decision point D2).
- In the execution-failure branch (`action-queue-service.ts:233-235`), for
  non-`MANUAL_CONFIRMATION_PENDING` failures:
  - if `errorCode ∈ RETRYABLE_EXECUTION_ERROR_CODES` and
    `(action.attemptCount ?? 0) < MAX_EXECUTION_ATTEMPTS` →
    `updateScheduledActionResult(…, { status: 'PENDING', errorCode,
    attemptCount: n+1, scheduledFor: now + n * 5 min })` (backoff), release budget
    (already done), log `action.{type}.retry` audit event.
  - else → `FAILED` (dead-letter, current behavior).
- Pre-dispatch safety refusals (`POST_NOT_ELIGIBLE`, `COOLDOWN_ACTIVE`, etc. from
  `safetyGate.assertActionSafe`, line 106-111) remain terminal `FAILED` — they are
  policy refusals, not execution failures (decision point D3).

### 7.4 AutoQueue bounding

All three queries in `autoApproveAndQueueCycle` (`server.ts:1267-1287`) get
`limit: 50` and `orderBy: [asc(scheduledActions.createdAt)]` /
`[asc(engagementDrafts.createdAt)]`. Natural pagination: the 30 s interval picks
up the next 50 on the following cycle.

### 7.5 Log level demotion

`EXPECTED_REFUSAL_CODES = ['COOLDOWN_ACTIVE', 'BUDGET_EXCEEDED', 'RATE_LIMITED',
'OUTSIDE_WORKING_HOURS', 'WORKING_HOURS_CLOSED', 'KILL_SWITCH_ACTIVE',
'ACCOUNT_PAUSED', 'PILOT_CAP_REACHED', 'LIKE_DISABLED', 'COMMENT_DISABLED',
'FEATURE_05_BROWSER_DISABLED', 'LEASE_UNAVAILABLE', 'SESSION_EXPIRED']`.

In `runAutoDrainCycle` (`server.ts:1196-1199`): if `result.reason` (or
`result.result?.errorCode`) is in the set → `console.log('[AutoDrain] ⚠ …')`;
otherwise keep `console.error`. `SESSION_EXPIRED` keeps its existing dedicated
warning + consecutive-failure counter (1206-1208).

## 8. Schema / Migration Approach

- **Additive column only.** `drizzle/0009_post_integrity_and_queue_resilience.sql`:
  ```sql
  ALTER TABLE "scheduled_actions" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;
  ```
- Generated via `npm run db:generate` (drizzle-kit, `drizzle.config.ts` points at
  `src/db/schema.ts` → `./drizzle`), or hand-written to match the existing
  migration style; applied via `npm run db:migrate`.
- `PAUSED_BUDGET` needs no migration (varchar status).
- No destructive changes; rollback is a plain `DROP COLUMN` (see §13).

## 9. Implementation Sequence (dependency order)

1. **`post-url-validator.ts`** (new) + `post-url-validator.test.ts` — pure
   function, no dependencies.
2. **Remove synthetic post generator** (`engagement-service.ts:255-263`) and
   **synthetic URL fallback** (`profile-activity-post-source.ts:57-59`; skip
   URL-less items). Update `engagement-service.test.ts` mock post source URL if
   the scan-time soft filter (D1) is approved.
3. **Hard gate in `requestAction`** — `assertValidLinkedInPostUrl(post.postUrl)`
   before the insert; update the two fixture-URL call sites in
   `engagement-service.test.ts` (≈348, ≈421) to valid LinkedIn URLs.
4. **Schema + types + migration** — `attemptCount` in `schema.ts`, `types.ts`,
   `db-adapter.ts`, `drizzle-adapter.ts`, `memory-storage.ts`; write
   `0009_*.sql`.
5. **`PAUSED_BUDGET`** — budget-exceeded branch (133-145) sets
   `PAUSED_BUDGET` + `scheduledFor` = next local midnight; add
   `resumePausedActions` to both adapters + interface; call at top of
   `processNextAction`. New tests (memory storage).
6. **Retry ceiling** — execution-failure branch (233-235); extend
   `updateScheduledActionResult` result type with `attemptCount`/`scheduledFor`;
   new tests.
7. **AutoQueue bounding** — `limit: 50` + ordering on the three queries.
8. **Log demotion** — `EXPECTED_REFUSAL_CODES` branch in `runAutoDrainCycle`.
9. **Full verification** — `npm run typecheck`, `npm test`, targeted manual
   checks (§11).

## 10. Test Plan

| Test | Type | Covers |
| --- | --- | --- |
| `post-url-validator.test.ts` (new) | Unit | Accept: `/posts/{a}/{slug}-{id}`, `/feed/update/urn:li:activity:{id}/?trk=feed`, `urn:li:ugcPost`, `urn:li:share`, http + www variants, query/fragment suffixes. Reject: profile URLs, `/recent-activity/all/#post-0`, `fixture.test`, bare `/posts/x`, empty. |
| `engagement-service.test.ts` (update) | Integration (PGlite) | Fixture URLs → valid LinkedIn URLs; new case: `requestAction` on a post with an invalid URL rejects `POST_NOT_ELIGIBLE` and inserts nothing into `scheduled_actions`. |
| `engagement-service.test.ts` (update) | Integration | Scan with 0 raw posts creates 0 drafts (synthetic generator gone). |
| `action-queue-service.test.ts` / `action-queue-resilience.test.ts` (new cases) | Unit (MemoryStorage) | (a) Budget exhausted → `PAUSED_BUDGET`, not claimable on next tick, resumes to `PENDING` after `scheduledFor` passes; (b) `SELECTOR_MISMATCH` retries: attempts 1-2 → `PENDING` with incremented `attemptCount` + backoff, attempt 3 → `FAILED`; (c) non-retryable code → `FAILED` immediately; (d) `resumePausedActions` flips only due rows. |
| `memory-storage.test.ts` (update) | Unit | `attemptCount` round-trips through insert/claim/update; `PAUSED_BUDGET` is not terminal and not claimable. |
| `server.ts` AutoQueue | Manual + existing e2e | With >50 pending drafts, the cycle processes ≤50 per run and ordering is deterministic. |
| Log demotion | Manual | Drain cycle with an active cooldown logs `[INFO]`/`⚠`, not `[ERROR]`. |

Run: `npm run typecheck && npm test`. Existing suites that must stay green:
`action-queue-service.test.ts`, `action-queue-resilience.test.ts`,
`action-queue-safety.test.ts`, `safety-resolver.test.ts`, `post-identity.test.ts`,
`memory-storage.test.ts`, `engagement-service.test.ts`.

## 11. Verification Path

1. `npm run typecheck` — clean.
2. `npm test` — full suite green.
3. Manual (dev server + Neon): scan a prospect with no posts → 0 drafts, no
   `#post-0` rows in `engagement_posts`/`scheduled_actions`; set a daily budget to
   0 → next drain cycle moves the action to `PAUSED_BUDGET` and stops re-claiming;
   force a `SELECTOR_MISMATCH` via the OpenCLI executor → observe 3 retries then
   `FAILED`; confirm `attempt_count` increments in the DB.
4. `gitnexus detect-changes` before commit (per AGENTS.md).

## 12. Risks / Consequence Scan

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `PAUSED_BUDGET` actions stuck forever if resume never fires | Actions silently never execute | `resumePausedActions` runs at the top of every `processNextAction` (same cadence as `recoverStaleClaims`); `scheduledFor` pushed to next local midnight guarantees the window rolls. |
| Retry ceiling delays dead-lettering of genuinely broken actions | 3 extra dispatch attempts per action | Backoff via `scheduledFor` (5 min × attempt); ceiling is hard-coded at 3; audit events record each retry. |
| URL regex too strict rejects a legitimate LinkedIn URL form | Operator sees `POST_NOT_ELIGIBLE` on a real post | Regex covers the forms already exercised in production tests + `canonicalPostIdentifier`; D1/D2 review gates. |
| Test churn from fixture URLs | Broad test edits | Only `engagement-service.test.ts` call sites (≈348, ≈421) + mock source URL; all other suites use `scheduleAction` directly (bypasses `requestAction`) and are unaffected. |
| `scanCampaignResume` still queries prospects unbounded (related, out of scope) | Neon pool pressure on the 10 m worker | Noted for a follow-up; AutoQueue (the named finding) is fixed here. |
| Migration ordering vs. running server | `attempt_count` missing at runtime | Additive defaulted column; `db:migrate` before deploy; drizzle adapter reads it via `RETURNING *` / select mapping. |

## 13. Rollback Notes

- **Code:** revert the commit; all changes are additive/behavioral, no schema
  destruction.
- **Migration:** `ALTER TABLE "scheduled_actions" DROP COLUMN "attempt_count";`
  (additive column — safe to keep or drop).
- **Data:** if rolling back after `PAUSED_BUDGET` rows exist, run
  `UPDATE "scheduled_actions" SET "status" = 'PENDING', "error_code" = NULL WHERE "status" = 'PAUSED_BUDGET';`
  to restore pre-fix behavior.
- **No irreversible state:** no rows are deleted by this change.

## 14. Decisions Requiring Tushar's Review

- **D1 — Scan-time soft filter:** include the `scanProspect` invalid-URL skip
  (defense-in-depth, small test churn) or gate only at `requestAction`?
  **Proposed: include both.**
- **D2 — Retryable code set:** `SELECTOR_MISMATCH` + `POST_NOT_ELIGIBLE` are
  named by the audit; include `RATE_LIMITED`, `EXECUTION_TIMEOUT`,
  `PROVIDER_UNAVAILABLE` in the same set? **Proposed: yes** (all transient
  execution failures). Note: `POST_NOT_ELIGIBLE` is usually non-transient; the
  audit named it explicitly, so it stays in the set.
- **D3 — Pre-dispatch safety refusals:** keep them terminal `FAILED` (proposed)
  or route `POST_NOT_ELIGIBLE` from the safety gate through the retry ceiling too?
- **D4 — `PAUSED_BUDGET` vs. delayed-retry-only:** the audit offered either; the
  plan uses `PAUSED_BUDGET` + `scheduledFor` push + resume sweep. Confirm this
  satisfies the intent.

## 15. Definition of Done

- [ ] No code path can fabricate a post or a profile-feed URL
      (`engagement-service.ts`, `profile-activity-post-source.ts`).
- [ ] `requestAction` refuses non-LinkedIn post URLs with `POST_NOT_ELIGIBLE`;
      nothing invalid enters `scheduled_actions`.
- [ ] `BUDGET_EXCEEDED` actions rest in `PAUSED_BUDGET` (non-claimable) and
      resume only when the budget window rolls; no hot loop.
- [ ] Retryable execution failures retry ≤3 times with backoff, then `FAILED`;
      `attempt_count` persists and increments.
- [ ] AutoQueue queries are bounded (`LIMIT 50`, deterministic ordering).
- [ ] Throttle/cooldown refusals log at INFO, not ERROR.
- [ ] `npm run typecheck` and `npm test` pass; new tests cover §10.
- [ ] Migration `0009_*.sql` applied and verified against Neon.

---

`APPROVAL_STATUS: PENDING_USER_REVIEW`

`STOP: Review the plan with Tushar. Do not start implementation until Tushar explicitly approves this exact plan in a later message.`