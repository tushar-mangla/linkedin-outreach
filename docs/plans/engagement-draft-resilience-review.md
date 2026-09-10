# Engagement Draft Resilience — Architecture Decision Review

**Status:** `PENDING_USER_REVIEW`
**Classification:** Enhancement (resilience) — decides between the "manual rollback" alternative proposal and the existing catchup/reconcile architecture in `neon-resilience-and-e2e-pipeline.md`
**Tier:** Medium — persistence, external provider (Neon suspend, Luna LLM), concurrency with the auto-approve worker

---

## 1. What Was Asked

Tushar's team proposed an alternative to the neon-resilience plan:

> When `aiProvider.generateComment()` fails (Neon drop or LLM timeout), the scan leaves a
> LIKE draft but no COMMENT draft; because the LIKE draft exists, future `scanProspect` runs
> treat the prospect as "engaged" and never generate the missing comment. Proposal:
> 1) roll back (DELETE) the just-created LIKE draft on COMMENT failure; 2) retry
> `generateComment()` up to 2 attempts; 3) log the rollback.
> Open questions: retry count 2 vs fail-fast; does rollback align with expectations?

I inspected the code (`src/services/engagement/engagement-service.ts`,
`cooldown-policy.ts`, `luna-engagement-provider.ts`, `drizzle-adapter.ts`) and the
existing plan `docs/plans/neon-resilience-and-e2e-pipeline.md`. The answer is:

**The premise is incorrect: a LIKE draft does NOT block a later COMMENT draft.**
**Neither is the hand-rollback approach recommended.** See §2 evidence.

---

## 2. Critical Correctness Findings (from code)

### 2.1 A LIKE draft does NOT prevent a future COMMENT (finding — matches the plan's own §3.1 step 7)

The gating logic in `scanProspect` counts only COMMENT-side state:

| Gate | Where | Does a PENDING LIKE draft trip it? |
| --- | --- | --- |
| "1 active comment candidate per prospect" | `engagement-service.ts:129-181` | **No** — line 133 AND filters `actionType:'COMMENT'`; line 142 counts only `scheduledActions.actionType='comment'`; line 165-171 counts only PENDING `account_post_comments` slots. A LIKE draft/LIKE action is invisible to this wall. |
| Post-level "comment already exists" | `engagement-service.ts:362-368` (`findFirst` on COMMENT drafts) | **No** — the query is per `postId` AND `actionType='COMMENT'`; a LIKE draft is a different row. |
| Per-post raw-post slot check | `engagement-service.ts:183-199,292-298` | **No** — slots (`account_post_comments` rows) are created only when a COMMENT is queued (`requestAction`, line 636-663). A LIKE execution never creates a slot. |
| Cooldown | `cooldown-policy.ts:43-77` | **No** — `checkComment` reads `engagementHistory` rows with `actionType='COMMENT'`; a LIKE draft creates no history (history is written at execution, `engagement-service.ts:712` and `drizzle-adapter.ts:409`). |

Conclusion: **any `if (!existingCommentDraft)` path (line 370) regenerates the missing
COMMENT on the next scan, unconditionally re-eligible, without duplicating anything.**
The LIKE-only state is a *recoverable checkpoint*, not a dead end. The actual root
cause of "no comment for today's prospects" is not the LIKE: it is (a) the DB failure
after the AI call with no retry, and (b) **there is no automatic trigger that re-runs
`scanProspect`/reconcile**, plus (c) the ingest caller discards `result.errors`
(`server.ts:486-490`).

### 2.2 The rollback DELETE fails in exactly the failure mode it targets

If the error was `Connection terminated due to connection timeout` (the Neon/live
log signature), the connection that failed is dead. The compensating
`DELETE FROM engagement_drafts` in the `catch` block goes through the same pool, which
must open a **new** connection to a still-cold-starting Neon. With pre-hardening
5–10 s connect timeout it fails; with the plan's 30 s it can still fail whenever the
cold-start exceeds the in-process budget. **The DELETE is not atomic with the failed
commit, is not connected to a live server, and cannot guarantee the LIKE is removed.**
The draft survives and the exact same behavior returns. Rollback only works if the
error actually allowed a subsequent connection — i.e., the "failure mode" it was
designed for is the one where it fails.

### 2.3 A compensating DELETE is also unsafe by race

The LIKE draft is a PENDING row that the 30 s `autoApproveAndQueueCycle`
(`server.ts`) may approve concurrently while our COMMENT writer is failing:
- the delete can orphan `recommendation_revisions` and `recommendation_approvals`
  (the proposal says delete "the LIKE draft (and revision)"), and
- the auto-approve path is not covered — a deleted draft whose `scheduled_action`
  was already created reproduces a *voided engagement* (approval→QUEUED→completion
  that points to a deleted draft), which turns the "clean rollback" into a **worse
  inconsistent state** (engagement history written against a deleted draft).

---

## 3. Approach comparison

| | **Approach 1 — Rollback / DELETE LIKE on COMMENT failure** | **Approach 2 — Keep + Catchup (reconcile & two-phase writes)** (the plan's design) | **Hybrid (recommended)** |
| --- | --- | --- | --- |
| Survives DB outage? | **No** — the compensating DELETE itself needs a live conn (§2.2) | Yes — LIKE stays as a checkpoint; reconcile/backfill runs later | Yes (A2 + bounded LLM retry) |
| Idempotency / duplicates | Poor — deletion + later re-creation replays the LIKE; racing auto-approve can quote drafts | Good — `onConflictDoNothing`, existence checks, optional unique index | Good |
| Preserves operator intent (valid LIKE) | Risky — saves nothing, destroys a possibly-good LIKE on a non-transient COMMENT failure | Preserves | Preserves |
| Damages concurrent work | Yes — delete races with auto-approve (dangling approvals/actions) | No — never mutates committed rows | No |
| Self-healing without the trigger | No — must re-scan the same prospect repeatedly | Yes if `scanResumeCycle` exists | Yes |
| Cost/latency | Same as A2 (RETry) | Single pass; reconcile may re-call the LLM for the missing half | At most 2 LLM calls per post (≥ unchanged) |
| Alignment with current plan | Diverges | **Core of the existing neon plan (§5 §6.2 §8.6)** | Extends the plan minimally |

The existing plan is already the catchup/reconcile design: extract `processPost`,
tx1 (like) / tx2 (comment) with `withDbRetry` on the post-AI writes, a
`reconcileMissingDrafts` pass (LIKE-without-COMMENT ⇒ backfill COMMENT), a
`scanCampaignResume` worker + endpoint, and ingest surfaces `errors`. The same
conclusion was already in the plan's root-cause analysis (§3.1 step 7).

---

## 4. Answers to the open questions

### Q1 — Retry count: 2 total vs fail-fast

**Recommend 2 total attempts for `generateComment()`: initial call + 1 retry**, and
**only on retryable causes** (Luna timeout/5xx/transport errors from
`luna-engagement-provider.ts`, whose `TIMEOUT_MS = 30_000`). Do not retry provider
4xx (invalid model/auth) or validation-dependent internal errors. A single retry is
cheap (one extra LLM invoice per failed-first attempt), roughly doubles success and
keeps late cases bounded to ASTP (2 retries × 30 s = at most ~60–65 s per post). The
reconcile pass adds a third attempt only when it later resurfaces — no code-time cost.
This is *stronger and cheaper* than fail-fast.
The current retry budget on the DB side stays 3 (existing `withDbRetry` contract, §12.1
of `neon-resilience-and-e2e-pipeline.md`); the AI-round-trip budget is separate.
**Decision on record: LLM call = 2 total attempts; DB writes = 3 total via withDbRetry.**

### Q2 — Is deleting the LIKE draft recommended?

**No — keep the LIKE and catch up.** Concrete reasons:
1. The rollback cannot delete when a Neon-suspended adjusts via §2.3.
2. It races the auto-approve/drain workers (§2.3).
3. The LIKE + missing COMMENT pair is precisely the **checkpoint contract**
   (`engagement_posts` row ∧ LIKE draft present ∧ COMMENT absent), which the
   catchup pass reads. Deleting the checkpoint throws away the only durable
   "needs backfill" marker and ORPHANS the actual one.
4. It can destroy a valid LIKE that passed the provider call while the COMMENT
   failed non-transiently.
Catch-up is strictly superior: `reconcileMissingDrafts` fills exactly the missing
COMMENT, `if(!existingCommentDraft)` prevents duplicates, and the resume worker
triggers automatically every ~10 min (or on manual endpoint).

---

## 5. Recommended architecture (deltas to `neon-resilience-and-e2e-pipeline.md`)

The plan is approved as baseline; apply these **four deltas**:

1. **Bounded in-run LLM retry** in `processPost`: wrap `generateComment` in a
   transient retry loop (total 2 attempts, backoff short e.g. 500 ms + jitter)
   that classifies per `isTransientLLMError` (timeout / 5xx / transport), and
   passes provider 4xx through. (New small contract — does not change the
   `EngagementAIProvider` interface.)
2. **Log-the-KEEP line**: when the COMMENT step fails after the LIKE was written,
   log `[EngagementService] LIKE kept (checkpoint), COMMENT missing for post <url> —
   will backfill on next scan/reconcile`, and in the ingest caller surface
   `result.errors` (as already planned in §5 of the document).
3. **Accept decision 7** — the one-time additive migration of the unique index on
   `engagement_drafts (tenant_id, post_id, action_type)` — so catchup/retry is
   provably duplicate-free even under the LLM retry + silence.
4. **Accept decision 8** — a scheduled `scanResumeCycle` (10 min, single-flight),
   which is the "automatic trigger" that actually closes today's bug. Recommended
   regardless of rollback.

No changes to schema beyond decision 7; no API shape changes (the `/resume`
endpoint already defined); nothing in the UI contract.

**Explicitly NOT adopted:** the manual rollback/DELETE-on-failure path from the
alternative proposal; automatic fail-fast with no retry is suboptimal vs the small
bounded retry.

## 6. Existing affected files (already in the plan §5) — unchanged

`src/db/client.ts`, `src/db/retry.ts` (new), `src/services/engagement/engagement-service.ts`
(`processPost` extraction, tx1/tx2, LLM retry wrapper, log line), `src/services/engagement/scan-resume-service.ts` (new),
`src/server.ts` (resume route/worker, error mapping), tests in
`src/services/engagement/engagement-service.test.ts` + `scripts/e2e-prospect-lifecycle-resilience.ts`,
and the optional migration of decision 7.

## 7. Tests & verification

New tests added to `engagement-service.test.ts`:
- fault-inject the COMMENT insert after a successful LIKE → assert LIKE present,
  COMMENT absent, `errors` non-empty, nothing re-queued; then run
  `reconcileMissingDrafts` → exactly 1 LIKE + 1 COMMENT; rerun → no new rows.
- fault-inject the *delete rollback* candidate-path → assert no DELETE is issued
  (regression test proving the pattern is not committed).
- `withRetry` on `generateComment`: provider 5xx/timeout → retried once; 4xx → no
  retry; success on attempt 2 → 1 LIKE + 1 COMMENT exactly once.
- Idempotency preserved: verify `scanCampaignResume` never double-inserts when
  drafts already exist (this stays regardless of rollback choice).

Unit/`typecheck --` `npm test`, plus the offline E2E script
(`scripts/e2e-prospect-lifecycle-resilience.ts`) — §9.4 of the neon plan — unchanged; the
LLM retry asserts only the bounded path.

## 7. Risks / rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| LLM retry doubles cost when a real outage persists | 2 max, retry only transient/timeout, provider 4xx excluded | Reduce to 1 retry or 0 at a const |
| Retry re-invokes LLM post-swap timeouts | bounded by retries; catchup uses `if (!existingCommentDraft)` so never double-write | Toggle the retry wrapper |
| Unique-index migration is risk at `DROP` | Additive, default value paths (re-check + onConflict), can be separate/approved | Revert migration |
| No behavior change for a valid other plan | This delta is additive to the existing already-planned design | No new call sites |

## 8. Definition of done

- [ ] Plan at `docs/plans/neon-resilience-and-e2e-pipeline.md` updated with §4/§5 deltas
  (bounded AI retry, log-the-KEEP, decision 9 clarification).
- [ ] No DELETE-on-failure path in the codebase.
- [ ] Proof tests added (retry path, reconcile backfill, keep-log line).
- [ ] Existing acceptance criteria from the neon plan remain satisfied plus the new
  uniqueness.

---

## 9. Recommendation to Tushar

**Adopt the hybrid**: the existing neon plan's catchup/reconcile + two-phase write
architecture, **plus** a bounded per-post `generateComment` retry (2 total attempts,
transient only), **plus** the explicit "LIKE kept as checkpoint, will backfill" log
line, **plus** automatic resume (decision 8 cadence). **Reject the rollback/delete
approach** — it cannot execute during a DB outage, races the auto-approve worker,
and destroys the very checkpoint that recovery relies on.
Answer the 3 questions as: retry = 2 attempts; rollback = no (keep & recover);
alignment = the existing plan is already the correct design.

Decisions requested from Tushar (in the plan):
1. Accept bounded AI retry (2 attempts) — YES/NO (this doc)
2. Accept the LIKE-kept log line wording — YES/NO
3. Approve decision 7 (unique index) — gates (duplicate-free catchup)
4. Approve decision 8 (10-min resume worker) — gates recovery