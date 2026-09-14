# Channels 2 & 4 — Post URL List + Post Keyword Search with Buying Signals

**Plan ID:** `channels-2-and-4-prospect-discovery`
**Mode:** FEATURE_PLANNING (executable slice plan)
**Parent plan:** `docs/plans/prospect-discovery-channels.md` (PROPOSED, 784 lines) — this document is the executable refinement of that plan's Slices 0, 1, 2, and 5, scoped to the user's prioritized rollout order and enriched with live research from `dev-gaspar/jobhunter`.
**Active scope:** RecruitmentOS -> engineering / product
**Status:** PROPOSED. This document authorizes planning only. It does not authorize application edits, migrations, live LinkedIn scanning, browser sessions, provider calls, or any external write.

## 1. Goal

Ship two independently usable prospect-discovery channels on the shared channel spine, in the user's stated order:

1. **Channel 2 — Post URL List import** (`POST /api/prospects/import-post-urls`): operator pastes N LinkedIn post URLs; each post's author becomes a prospect, the exact post is ingested into `engagement_posts` with real text, and the post is scored for buying signal. Zero placeholder posts.
2. **Channel 4 — Post Keyword Search + AI Buying Signals** (`POST /api/discovery/runs` with `channelKey: 'POST_KEYWORD_SEARCH'`): operator runs 3–6 word keyword searches against LinkedIn's content search index (`/search/results/content/`), extracted posts pass a two-layer hybrid classifier (deterministic negative gate + regex pre-extraction + LLM `BuyingSignalClassifier` with verbatim-quote grounding), and qualified prospects land in the same review funnel.

Both channels reuse the existing qualification spine (`PersistentIcpPipeline` → `deterministicFilter` → AI evaluation → stage) and never bypass the human approval gate before `READY_FOR_CAMPAIGN`.

### 1.1 Rollout order (user directive)

> "start with channel 2, channel 4!! then channel 5 and then channel 3 and 6"

Mapped to the parent plan's channel table:

| User's order | Parent-plan channel | This plan |
| --- | --- | --- |
| 1st | C2 — post URL list | **IN SCOPE (Slice 1)** |
| 2nd | C4 — post keyword search + buying signals | **IN SCOPE (Slice 3)** |
| 3rd | C5 — additional high-ROI channels (C5-a commenters/reactors, C5-b engagers on own posts, C5-d second-degree) | Follow-on plan; reuses this plan's foundation |
| 4th | C3 — feed scan | Follow-on plan; reuses this plan's pre-filter + scoring |
| 5th | "channel 6" | **AMBIGUOUS — see Decision D11.** The parent plan defines channels 1–5 only. Likely C5-b (engagers on the operator's own posts) or the buying-signal engine as a standalone deliverable. |

The shared foundation (interface, models, migration, buying-signal engine, blacklist, query stats) is built once here and is the prerequisite for C5/C3.

## 2. Assumptions

- A1. The parent plan's evidence ledger (sections 5.1–5.3) is adopted as read; this plan adds only new findings (section 4).
- A2. OpenCLI remains the browser seam (`src/executors/opencli.ts` `browser <session> open|eval|extract`; `src/services/discovery/opencli-linkedin-source.ts` `OpenCliRunner`). The jobhunter research supplies the exact content-search URL and DOM selectors, so Channel 4 does **not** require a new OpenCLI subcommand — it drives `open` + `eval`/`extract` against the content-search URL. Capability must still be probed live before Slice 3 (Decision D9).
- A3. Signal provider reuses the codex-everywhere / `gpt-5.6-luna` HTTP API already wired in `luna-engagement-provider.ts:13-33` (Decision D2 default (a)).
- A4. Single-operator, single-tenant runtime (`src/server.ts:199`; `src/db/tenant-context.ts:11`). Tenant/operator identity always from request context (invariant I10).
- A5. No auto-promotion for new channels (Decision D4 default (b)): a channel run leaves prospects at `EVALUATED` / `REQUIRES_REVIEW` / `REJECTED`; only an explicit operator promotion sets `READY_FOR_CAMPAIGN`.
- A6. Post persisted only after its author reaches at least `EVALUATED` (Decision D5 default (a)); `engagement_posts.prospect_id` is `NOT NULL` (`src/db/schema.ts:204`), so no orphan posts.
- A7. Budgets (Decision D3): max 25 post URLs per C2 run; max 25 search results and 25 LLM scoring calls per C4 run; one active run per channel.
- A8. Channel enablement via env flags (Decision D8 default (a)): `FEATURE_CHANNEL_POST_URL_LIST` and `FEATURE_CHANNEL_POST_KEYWORD_SEARCH`, both default **off**, mirroring `FEATURE_05_BROWSER_ENABLED` (`src/server.ts:113`).
- A9. Signal thresholds (Decision D10): `signalQualificationThreshold = 70`, `signalReviewThreshold = 40`, `minimumSignalConfidence = 0.6`.

## 3. Non-goals (unchanged from parent plan, restated for this scope)

- No new LinkedIn write actions; like/comment execution, approval, budget, cooldown, kill-switch, lease semantics untouched.
- No removal of CSV/manual intake.
- No connection requests, DMs, InMail, or sequencing.
- No Sales Navigator dependency.
- No bulk crawling, CAPTCHA bypass, proxy/UA rotation, or multi-account operation.
- No scheduled/background discovery (parent D-a).
- No claim that content-search scanning is permitted by LinkedIn's terms — operational/legal decision for Tushar (Decision D1).
- No precision claims for buying signals before the labelling exercise (parent 7.5).
- C3 (feed scan) and C5 (commenters/reactors etc.) are **not** implemented here; they are follow-on plans that consume this plan's foundation.

## 4. Current-state evidence (new findings beyond parent plan)

**EVIDENCE_GATE: PASS.** Working directory `/Users/tusharmangla/Dev/outreach/linkedin-outreach` inspected. Parent plan's evidence ledger (5.1–5.3) adopted. New findings from this inspection:

| # | Finding | Evidence | Consequence |
| --- | --- | --- | --- |
| F1 | **No prospect-promotion HTTP route exists.** `PersistentIcpPipeline.applyOverride` (`persistent-pipeline.ts:198-215`) is the only promotion path and has **zero callers** in `src/server.ts` (30 routes grepped; no `PATCH/POST /api/prospects/:id/stage|promote|review`). The frontend only *reads* `READY_FOR_CAMPAIGN` (`App.tsx:90,499,504`). | grep `app.(post|patch|put|get)(` in `src/server.ts`; grep `applyOverride` | Parent invariant I6 ("only an explicit operator review action sets READY_FOR_CAMPAIGN") has no implementation. **This plan must add a promotion route** as part of the operator workflow, and it doubles as the query-stats attribution hook. |
| F2 | `post_source_type` enum is `['PLAYWRIGHT','FIXTURE','MANUAL']` (`src/db/schema.ts:197`); `PostSourceType` in `src/types.ts:194` mirrors it. No `POST_URL_LIST` / `POST_KEYWORD_SEARCH` values. | `src/db/schema.ts:197`; `src/types.ts:194` | Migration must `ALTER TYPE post_source_type ADD VALUE` (outside a transaction) and extend the TS union. |
| F3 | `DBAdapter` surface (`src/db/db-adapter.ts`) has `insertProspect`, `insertIcpEvaluation`, `insertImportBatch`, `findProspectByTenantAndUrl`, `insertAuditEvent`, `applyOverride`; **no** discovery-run/item/signal or engagement-post insert methods. `DrizzleAdapter` and `MemoryStorage` both implement it. | `src/db/db-adapter.ts:15-26`; `drizzle-adapter.ts:27-61,216-238`; `memory-storage.ts:72-117,296-316` | New persistence for runs/items/signals/query-stats can use Drizzle directly (as `server.ts` does with `db.insert(...)`), but offline tests need `MemoryStorage` parity or PGlite. Plan: extend `DBAdapter` with the four new write/read methods so both implementations stay in sync. |
| F4 | `engagementPosts` insert pattern exists in `engagement-service.ts:376-391` (transactional, `onConflictDoNothing` on `tenant_canonical_post_idx`). | `engagement-service.ts:376-391` | Channel post persistence reuses this exact pattern; no new insert machinery needed. |
| F5 | `FEATURE_05_BROWSER_ENABLED` env-flag pattern confirmed (`src/server.ts:113,176,902,946,1078,1222`). | `src/server.ts` | New channel flags follow the same shape. |
| F6 | `structuredRefusal(code, message, correlationId)` is the error vocabulary (`src/server/request-context.ts:62`); `withRequestTenant` / `tenantOf` / `operatorOf` / `correlationOf` are the context helpers. | `src/server/request-context.ts` | New routes use these exclusively. |
| F7 | `deterministicFilter` (`src/services/icp/deterministic-filter.ts:8-73`) already implements geography, negative keywords, excluded titles, excluded companies, hard exclusions, company size — the jobhunter "company deny-list" maps to `excludedCompanies` + `hardExclusions` in `IcpCriteriaSchema` (`src/schemas/icp.ts:16-18`). | `deterministic-filter.ts`; `src/schemas/icp.ts` | No new blacklist table needed for slice 1; blacklist = ICP criteria fields, managed via a new UI + `PUT /api/discovery/blacklist`. |
| F8 | `canonicalPostIdentifier` (`post-identity.ts:5-20`) and `hashPostContent` / `normaliseRawPost` (`prospect-post-source.ts:34-57`) are the post-identity primitives. | `post-identity.ts`; `prospect-post-source.ts` | Reused verbatim by both channels. |
| F9 | Placeholder-post fallback confirmed at `engagement-service.ts:255-264` (parent conflict X6). | `engagement-service.ts:255-264` | Forbidden for channel-supplied posts (parent P4); existing-path fix is Decision D6. |
| F10 | GitNexus index is stale relative to HEAD (parent 5.4). | parent plan | Slice 0 step 0: refresh index before any edit. |

## 5. User journeys

### Journey J1 — Channel 2 (post URL list)

1. Operator opens the Discovery panel, selects "Import post URLs".
2. Pastes up to 25 LinkedIn post URLs (newline- or comma-separated) — e.g. posts from recruitment-agency owners complaining about manual sourcing.
3. Server validates each URL (LinkedIn host, parseable activity/post path), rejects malformed ones with explicit reasons, and refuses the run if the channel flag is off or a run is already active.
4. For each valid URL: OpenCLI opens the post, extracts author name + profile URL + full post text (expanding truncated text) + published time. Missing author profile URL → `EXTRACTION_INCOMPLETE`, never guessed.
5. Author → `PersistentIcpPipeline` (deterministic filter first, then AI evaluation). Post is persisted to `engagement_posts` (`sourceType = 'POST_URL_LIST'`) **only after** the author reaches `EVALUATED`.
6. Post is scored for buying signal (Archetype A or B per run). Score, categories, and verbatim quotes are stored in `prospect_signals`.
7. Operator sees a results table: URL → disposition → prospect stage → signal score + quote. Reviews and explicitly promotes qualified prospects to `READY_FOR_CAMPAIGN` (new promotion route, F1).
8. Engagement drafts are generated through the existing path, grounded in the real post text. No placeholder post is ever created.

### Journey J2 — Channel 4 (keyword search + buying signals)

1. Operator selects "Post keyword search", picks an archetype (Agency Owners / Hiring Managers), a recency window (past 24h / week / month), and a result budget.
2. Server offers 3–6 word query presets derived from the active ICP criteria + archetype (e.g. "recruitment agency owner clients", "sourcing candidates manually", "we are hiring recruiters"); operator may add custom queries.
3. Server builds `https://www.linkedin.com/search/results/content/?keywords=<encoded>&datePosted=["past-24h"]&sortBy=["date_posted"]` and drives it through OpenCLI; DOM extraction expands truncated posts and pulls author + canonical post URL.
4. Deterministic negative gate runs before any LLM call: blocks job seekers (`#OpenToWork`, "open to work"), blacklisted companies, job-ad text (for Archetype A), short/stale/repost/promoted/self/already-engaged posts.
5. Regex pre-extraction pulls emails/contacts from post bodies into evidence (never auto-used for outreach).
6. Surviving posts are LLM-scored by `BuyingSignalClassifier`; every claimed category requires a verbatim quote; invalid provider output → `SCORING_FAILED`, never a default score.
7. Authors are deduped, run through the ICP pipeline, and ranked by signal score for operator review.
8. Operator promotes qualified prospects; the run's queries are recorded in `discovery_query_stats` so zero-yield queries are visible and retired.

## 6. Architecture

### 6.1 Shared channel interface (parent plan 9.1, refined)

New file `src/services/discovery/channels/types.ts`:

```ts
export type DiscoveryChannelKey = 'PEOPLE_SEARCH' | 'POST_URL_LIST' | 'POST_KEYWORD_SEARCH';

export interface ChannelBudget {
  maxItems: number;        // C2: 25 URLs; C4: 25 search results
  maxScoringCalls: number; // 25 per run
}

export type RawSourceItem =
  | { kind: 'PROFILE'; profileUrl: string; name?: string; headline?: string; company?: string; location?: string; sourceEvidence: string }
  | { kind: 'POST'; postUrl: string; postText: string; authorName: string; authorProfileUrl: string; publishedAt?: Date; sourceEvidence: string; extractedContacts?: string[] };

export interface ProspectSourceChannel {
  readonly channelKey: DiscoveryChannelKey;
  readonly yields: 'PROFILES' | 'POSTS_WITH_AUTHORS';
  validateInput(raw: unknown): ChannelInput;   // Zod-validated, throws ChannelInputError
  fetch(input: ChannelInput, budget: ChannelBudget): Promise<RawSourceItem[]>;
}
```

Optional fields are genuinely optional — absent means absent, never a default literal (correcting `opencli-linkedin-source.ts:7-10`).

### 6.2 Channel registry + orchestrator

New file `src/services/discovery/channels/registry.ts`:

```ts
export interface ChannelRegistry {
  get(key: DiscoveryChannelKey): ProspectSourceChannel | null;
  isEnabled(key: DiscoveryChannelKey): boolean;   // env flags (A8)
  list(): { channelKey: DiscoveryChannelKey; enabled: boolean; yields: string }[];
}
```

Extend `ProspectDiscoveryService` (`prospect-discovery-service.ts:26-37`) — do **not** replace it. Add injected deps: `persistRun`, `persistItem`, `persistSignal`, `scoreSignal`, `upsertQueryStat`, `promoteProspect`. The existing people-search path keeps its current behavior (Slice 0 refactor is behavior-preserving; parent C1).

### 6.3 Data models (new)

| Model | Fields (key ones) | Notes |
| --- | --- | --- |
| `DiscoveryRun` | id, tenantId, channelKey, inputSnapshot (json), status (`CREATED|RUNNING|COMPLETED|PARTIAL|FAILED|REFUSED|RATE_LIMITED`), counts (itemsSeen, accepted, duplicatesInRun, duplicatesExisting, invalid, extractionIncomplete, preFiltered, parserRejected, scored, qualifiedSignals), errorCode, operatorId, correlationId | One row per operator-initiated run |
| `DiscoveryItem` | id, tenantId, runId, dedupeKey, disposition (10 values, parent 8.2), prospectId?, postId?, reason, sourceEvidence | Disposition assigned once, never mutated |
| `ProspectSignal` | id, tenantId, prospectId, postId, runId?, signalScore, confidence, archetypeDetected (`A|B|NONE`), categories (json: `[{category, strength, evidenceQuote}]`), disqualifiers (json), reasoning, promptVersion, status (`SCORED_QUALIFIED|SCORED_REVIEW|SCORED_BELOW_THRESHOLD|SCORING_FAILED|HALLUCINATED_EVIDENCE`), providerMeta | Re-scoring inserts a new row (prompt-precision history) |
| `DiscoveryQueryStat` | id, tenantId, channelKey, query, datePostedWindow, runs, itemsSeen, prospectsAccepted, prospectsApproved, zeroYield, lastRunAt | Closed-loop query performance (jobhunter pattern) |

### 6.4 Buying-signal engine (jobhunter two-layer hybrid, parent section 7)

New directory `src/services/discovery/signals/`:

```
signals/
  provider.ts            // BuyingSignalProvider interface + FakeBuyingSignalProvider
  schema.ts              // SignalScoreInputSchema / SignalScoreOutputSchema (Zod)
  deterministic-gate.ts  // Layer 1: job-seeker markers, blacklist, job-ad markers, length, recency, repost, promoted, self, already-engaged
  contact-extractor.ts   // Layer 2: email/phone/"DM me" regex pre-extraction
  quote-grounding.ts     // Layer 2b: verbatim-substring validator, HALLUCINATED_EVIDENCE
  classifier.ts          // BuyingSignalClassifier: composes gate -> extractor -> provider -> grounding -> threshold router
  prompt.ts              // signal-v1 prompt builder
  thresholds.ts          // 70 / 40 / 0.6 routing
```

`BuyingSignalProvider` (mirrors `EngagementAIProvider`, parent 7.3):

```ts
export interface BuyingSignalProvider {
  scoreSignal(input: SignalScoreInput): Promise<SignalScoreOutput>;
  readonly providerName: 'luna' | 'fake';
}
```

`SignalScoreOutput` (Zod-validated): `signalScore: 0-100`, `confidence: 0-1`, `categories: [{category, strength: 0-100, evidenceQuote}]`, `archetypeDetected: 'A'|'B'|'NONE'`, `reasoning`, `disqualifiers: string[]`, `providerMeta: {provider, model, promptVersion, latencyMs}`.

**Hard rules (parent 7.3-7.4, adopted):** invalid provider output is a scoring failure, never a default score; deterministic exclusions are final and never overridden by signal; archetype A and B never share one call; every persisted `evidenceQuote` must be a verbatim substring of `postText` after whitespace normalization; data transmitted externally is limited to post text, author name, author headline, publish date.

**Deterministic gate rules (jobhunter-informed, Layer 1):**

| Rule | Pattern | Disposition |
| --- | --- | --- |
| Job seeker | `#OpenToWork`, `#opentowork`, "open to work", "seeking new opportunities", "looking for a new role", "available for hire" | `PRE_FILTERED` (they are candidates, not buyers) |
| Company blacklist | author company matches `excludedCompanies` / `hardExclusions` (F7) | `PRE_FILTERED` |
| Job ad (Archetype A only) | "we are hiring", "we're hiring", "apply now", "join our team", "hiring for", "job opening" | `PRE_FILTERED` for A; Archetype B signal at most |
| Min length | `< 50` chars (reuse `post-filter.ts:30` default) | `PRE_FILTERED` |
| Recency | older than `maxAgeDays` (default 7, `post-filter.ts:29`) | `PRE_FILTERED` |
| Repost without commentary / promoted / self-authored / already-engaged | reuse `PostFilter` + `accountPostComments` check (`engagement-service.ts:222-232`) | `PRE_FILTERED` |

**Contact regex pre-extraction (Layer 2):** `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` for emails, plus phone and "DM me"/"contact me" markers. Stored on the item/signal as `extractedContacts` evidence. **Never** used to initiate outreach without operator approval.

**Signal taxonomy (parent 7.2, adopted):** Archetype A — `MANUAL_SOURCING_FATIGUE`, `INCONSISTENT_LEAD_FLOW`, `ATS_TOOLING_FRUSTRATION`, `FOUNDER_BURNOUT_CAPACITY`, `AGENCY_GROWTH_INTENT`, `OUTREACH_METHOD_SEEKING`, `MARGIN_PRESSURE`. Archetype B — `HIRING_SURGE`, `TALENT_ACQUISITION_GAP`, `RECRUITING_CAPACITY_GAP`.

### 6.5 Channel 2 — `PostUrlListChannel`

New file `src/services/discovery/channels/post-url-list-channel.ts`:

- `validateInput`: Zod schema `{ postUrls: string[] (1..25), icpDefinitionId?: string, targetArchetype: 'A'|'B' }`. Each URL must parse as `https://(www.)?linkedin.com/...` and contain a post/activity path (`/posts/`, `/feed/update/`, `urn:li:activity:`, `/pulse/`). Non-LinkedIn or unparseable → per-URL `INVALID_URL` with reason.
- `fetch`: for each URL, `PostByUrlSource` (new, `src/services/discovery/channels/post-by-url-source.ts`) opens the URL via OpenCLI (`browser <session> open <url>` then `eval`/`extract`) and returns `{ postUrl, postText (expanded), authorName, authorProfileUrl, publishedAt }`. Author profile URL mandatory; missing → `EXTRACTION_INCOMPLETE`.
- Dedupe: post by `canonicalPostIdentifier` (F8); author by `discoveryDedupeKey` (`prospect-discovery-service.ts:56-62`).
- Post persisted only after author reaches `EVALUATED` (A6), `sourceType = 'POST_URL_LIST'`, using the `engagement-service.ts:376-391` insert pattern with `onConflictDoNothing` on `tenant_canonical_post_idx`.

### 6.6 Channel 4 — `ContentSearchChannel`

New files:

- `src/services/discovery/channels/content-search-url.ts` — URL builder (jobhunter finding 1):

```ts
export type DatePostedWindow = 'past-24h' | 'past-week' | 'past-month';
export function buildContentSearchUrl(query: string, window: DatePostedWindow): string {
  const encoded = encodeURIComponent(query);
  const windowParam = encodeURIComponent(JSON.stringify([window])); // ["past-24h"]
  return `https://www.linkedin.com/search/results/content/?keywords=${encoded}&datePosted=${windowParam}&sortBy=${encodeURIComponent(JSON.stringify(['date_posted']))}`;
}
```

- `src/services/discovery/channels/query-presets.ts` — 3–6 word presets (jobhunter finding 1: short queries perform best). Derived from `IcpCriteria.positiveKeywords` + archetype; word-count enforced 3–6; examples: Archetype A — "recruitment agency owner clients", "sourcing candidates manually", "recruitment BD pipeline", "agency founder hiring", "staffing agency growth"; Archetype B — "we are hiring recruiters", "struggling to fill role", "talent acquisition overload".
- `src/services/discovery/channels/content-search-channel.ts` — `validateInput` (queries 1..5, each 3–6 words; `datePosted`; `resultBudget` 1..25; `targetArchetype`), `fetch` via OpenCLI against the built URL.
- `src/services/discovery/channels/post-dom-extractor.ts` — DOM extraction (jobhunter finding 2): click `button[data-testid="expandable-text-button"]` to expand truncated posts; read text from `span[data-testid="expandable-text-box"]`; author from `a[href*="/in/"]`; canonical post URL from the post card link; published time from the card timestamp. Versioned parser; unparseable output → `PARSER_REJECTED`, never silently dropped.

### 6.7 Company blacklist / negative filters

- Storage: reuse `IcpCriteriaSchema.excludedCompanies` + `hardExclusions` (F7) — no new table in slice 1 (Decision D12).
- New routes: `GET /api/discovery/blacklist` (read current `excludedCompanies`/`hardExclusions` from the active ICP definition) and `PUT /api/discovery/blacklist` (append/remove entries, persisted into `icp_definitions.criteria`).
- Enforcement: `deterministicFilter` already applies these to every prospect (F7); the signal gate applies them to post authors before any LLM call (6.4). A blacklisted company's prospect is never promoted regardless of signal score (parent I4).

### 6.8 Closed-loop query performance tracking (jobhunter finding 6)

- `discovery_query_stats` row upserted per (tenant, channelKey, query, datePostedWindow) at run end: `runs+1`, `itemsSeen += n`, `prospectsAccepted += n`, `zeroYield = (prospectsAccepted === 0)`.
- `prospectsApproved` increments when a prospect originating from that run is promoted via the new promotion route (F1): the promotion handler looks up `prospect_discovery_items` (disposition `ACCEPTED`) → run → query and updates the stat.
- New route `GET /api/discovery/query-stats` returns the table sorted by yield, so the operator can retire zero-yield queries.

## 7. Schema / migration approach

Migration `drizzle/0008_prospect_discovery_channels.sql` (forward-only; never rewrite `0000`–`0007`; parent 9.4):

1. **Enum values (must run outside a transaction — Postgres `ALTER TYPE ... ADD VALUE`):**
   ```sql
   ALTER TYPE post_source_type ADD VALUE IF NOT EXISTS 'POST_URL_LIST';
   ALTER TYPE post_source_type ADD VALUE IF NOT EXISTS 'POST_KEYWORD_SEARCH';
   ```
   Isolate in its own migration step (parent RK9). Drizzle `pgEnum` in `src/db/schema.ts` and the TS union in `src/types.ts:194` extended to match.
2. `CREATE TYPE discovery_channel_key AS ENUM ('PEOPLE_SEARCH','POST_URL_LIST','POST_KEYWORD_SEARCH');`
3. `prospect_discovery_runs` — columns per 6.3; `tenant_id NOT NULL`; index `(tenant_id, created_at)`.
4. `prospect_discovery_items` — `tenant_id NOT NULL`, `run_id REFERENCES prospect_discovery_runs`, `prospect_id REFERENCES prospects`, `post_id REFERENCES engagement_posts`; unique `(run_id, dedupe_key)`; index `(run_id, disposition)`.
5. `prospect_signals` — `tenant_id NOT NULL`, `prospect_id REFERENCES prospects`, `post_id REFERENCES engagement_posts`, `run_id REFERENCES prospect_discovery_runs`; index `(tenant_id, prospect_id, created_at)`.
6. `discovery_query_stats` — `tenant_id NOT NULL`; unique `(tenant_id, channel_key, query, date_posted_window)`.

Constraints (parent 9.4): tenant scoping is application-level plus explicit `tenant_id` predicates — **do not claim RLS** (parent X5). No raw HTML/cookies/credentials stored; bounded `sourceEvidence` text only. Test against clean isolated PGlite/pg-mem (already dev deps, `package.json:26,40`).

`DBAdapter` extension (F3): add `insertDiscoveryRun`, `insertDiscoveryItem`, `insertProspectSignal`, `upsertQueryStat`, `findDiscoveryItemsByProspect`, `incrementQueryStatApproved` to `src/db/db-adapter.ts`, `drizzle-adapter.ts`, and `memory-storage.ts` so offline tests stay possible.

## 8. API contract (additive)

| Route | Method | Purpose | Request | Response (201/200) |
| --- | --- | --- | --- | --- |
| `/api/prospects/import-post-urls` | POST | Channel 2 (user-named route) | `{ postUrls: string[], icpDefinitionId?, targetArchetype: 'A'\|'B' }` | `{ status: 'completed', runId, itemsSeen, accepted, duplicatesInRun, duplicatesExisting, invalid, extractionIncomplete, preFiltered, parserRejected, scored, qualifiedSignals, prospects: [{prospectId, name, linkedinUrl, stage, signalScore, categories}], correlationId }` |
| `/api/discovery/runs` | POST | Generic run start; dispatches by `channelKey` (`POST_URL_LIST` \| `POST_KEYWORD_SEARCH`); C2 alias for the route above | `{ channelKey, input, icpDefinitionId?, budget? }` | same shape as above |
| `/api/discovery/runs/:runId` | GET | Run status + reconciled counts | — | `{ runId, channelKey, status, counts, errorCode?, correlationId }` |
| `/api/discovery/runs/:runId/items` | GET | Paginated items with dispositions + signal summaries | `?page=&pageSize=` | `{ items: [{dedupeKey, disposition, reason, prospectId?, postId?, signal?: {score, archetype, categories, quote}}], total }` |
| `/api/discovery/channels` | GET | Channel list with enablement | — | `{ channels: [{channelKey, enabled, yields}] }` |
| `/api/prospects/:id/signals` | GET | Signal history for one prospect | — | `{ signals: [{signalScore, archetypeDetected, categories, promptVersion, status, createdAt}] }` |
| `/api/discovery/query-stats` | GET | Closed-loop query performance | — | `{ stats: [{query, datePostedWindow, runs, itemsSeen, prospectsAccepted, prospectsApproved, zeroYield, lastRunAt}] }` |
| `/api/discovery/blacklist` | GET / PUT | Read / update `excludedCompanies` + `hardExclusions` on the active ICP definition | PUT: `{ companies: string[], hardExclusions?: string[] }` | `{ companies, hardExclusions }` |
| `/api/prospects/:id/promote` | POST | **New (F1):** explicit operator promotion to `READY_FOR_CAMPAIGN`; calls `applyOverride` + increments `discovery_query_stats.prospectsApproved` | `{ reason?: string }` | `{ prospectId, currentStage: 'READY_FOR_CAMPAIGN' }` |

Error codes (extend `structuredRefusal` vocabulary, parent 9.3): `CHANNEL_DISABLED`, `CHANNEL_INPUT_INVALID`, `CHANNEL_BUDGET_EXCEEDED`, `DISCOVERY_ALREADY_RUNNING`, `SIGNAL_PROVIDER_UNAVAILABLE`, `SIGNAL_OUTPUT_INVALID`, `EXTRACTION_INCOMPLETE`, `OPENCLI_UNAVAILABLE`, `SESSION_EXPIRED`, `RATE_LIMITED`, `PROSPECT_NOT_FOUND`.

`POST /api/prospects/discover` (`src/server.ts:380`) stays untouched for backward compatibility with `UploadPanel.tsx:234` (parent C21).

## 9. Frontend contract

New component `src/components/DiscoveryPanel.tsx` (or a new tab in `UploadPanel.tsx`; builder picks the lower-risk option — prefer a new tab to avoid touching the working discovery flow):

- **C2 form:** textarea (newline/comma-separated URLs), live count + cap display (25), archetype toggle (Agency Owners / Hiring Managers), submit → results table (URL → disposition badge → prospect name/link → stage → signal score + verbatim quote). Disabled state during a run; no optimistic success.
- **C4 form:** archetype toggle, recency window select (24h/week/month), query preset chips (from `GET /api/discovery/channels` or a presets endpoint) + custom query input (3–6 word validation), result budget, submit → ranked results table (signal score desc, categories, quote, author, post link, disposition).
- **Blacklist panel:** list of `excludedCompanies` + `hardExclusions` with add/remove (PUT `/api/discovery/blacklist`).
- **Query stats panel:** table of queries with runs/itemsSeen/accepted/approved/zeroYield, sorted by yield.
- **Promotion:** per-prospect "Promote to campaign" button calling `POST /api/prospects/:id/promote` (F1) — this is the explicit review gate for both channels.

## 10. Implementation sequence (slices, dependency order)

### Slice 0 — Foundation (no new channel)

1. Refresh GitNexus index (`node .gitnexus/run.cjs analyze --index-only`).
2. Add `DiscoveryChannelKey`, `RawSourceItem`, `ChannelBudget`, `ProspectSourceChannel` types (`src/services/discovery/channels/types.ts`).
3. Migration `0008` (section 7) + `src/db/schema.ts` tables + `src/types.ts` enum union + `DBAdapter` extension (F3).
4. Channel registry + env flags (A8).
5. Refactor existing people-search path onto the interface with **no behavior change** (parent C1).
6. `POST /api/discovery/runs` skeleton (PEOPLE_SEARCH alias) + run/item persistence with reconciling counts (parent I3).
7. **New promotion route** `POST /api/prospects/:id/promote` (F1) — needed by every later slice.
*Testable:* existing discovery tests pass; runs/items persist with reconciling counts; promotion route sets `READY_FOR_CAMPAIGN` and writes a review decision + audit event.

### Slice 1 — Channel 2 (post URL list)

1. `PostByUrlSource` (OpenCLI open + extract) with `OpenCliRunner` seam.
2. `PostUrlListChannel` (validate → fetch → dedupe → author extraction with genuine optionality).
3. Post persistence (`sourceType = 'POST_URL_LIST'`) after author reaches `EVALUATED` (A6), reusing `engagement-service.ts:376-391` pattern.
4. `POST /api/prospects/import-post-urls` + `POST /api/discovery/runs` dispatch.
5. UI: C2 form + results table.
*Testable:* fixture OpenCLI output → expected prospects + posts; malformed URLs rejected with reasons; duplicate posts/authors suppressed; real post reaches `engagement_posts`; no placeholder generated.

### Slice 2 — Buying-signal engine (no new channel)

1. `BuyingSignalProvider` + `FakeBuyingSignalProvider` + Zod schemas (`signals/schema.ts`).
2. `deterministic-gate.ts` (6.4 rules), `contact-extractor.ts`, `quote-grounding.ts`, `thresholds.ts`, `prompt.ts` (`signal-v1`), `classifier.ts`.
3. `prospect_signals` persistence; apply to Slice 1 posts.
*Testable:* fake provider deterministic; fabricated quote dropped; all-dropped → `HALLUCINATED_EVIDENCE`; invalid JSON → `SCORING_FAILED` never default; deterministically excluded prospect never rescued by high score (parent C10); archetype A/B never merged (parent C11); scoring cap enforced (parent C12).

### Slice 3 — Channel 4 (post keyword search)

**Precondition: Decision D9 probe** — confirm OpenCLI `open` + `eval`/`extract` returns the content-search DOM (or a JSON extraction) reliably. If not, this slice is blocked and must be re-planned, not worked around.

1. `content-search-url.ts` + `query-presets.ts` (3–6 word enforcement).
2. `post-dom-extractor.ts` (expandable-text-button / expandable-text-box / `/in/` author / canonical URL).
3. `ContentSearchChannel` (validate → fetch → deterministic gate → contact extraction → signal scoring → dedupe → pipeline).
4. `discovery_query_stats` upsert at run end + `prospectsApproved` increment in the promotion route.
5. `GET /api/discovery/query-stats`, `GET/PUT /api/discovery/blacklist`.
6. UI: C4 form, ranked results, blacklist panel, query stats panel.
*Testable:* fixture search HTML → expected posts; pre-filters drop shorts/reposts/promoted/self/already-engaged/job-seekers/blacklisted; scoring cap enforced; archetype separation; query stats record zero-yield and approved-yield queries.

### Follow-on (NOT in this plan)

C5 (commenters/reactors, engagers, second-degree) and C3 (feed scan) reuse the foundation: `ProspectSourceChannel`, registry, signal engine, blacklist, query stats. Separate plans required; "channel 6" clarified via Decision D11.

## 11. Test plan

| Layer | Coverage | External access |
| --- | --- | --- |
| Unit: C2 input | URL parsing (newline/comma), non-LinkedIn rejection, 25-cap, in-list dedupe | None |
| Unit: C4 URL builder | Encoding, `datePosted` variants (`["past-24h"]` etc.), `sortBy` | None |
| Unit: query presets | 3–6 word bounds, archetype separation, derivation from `positiveKeywords` | None |
| Unit: DOM extraction | Fixture HTML: expandable-text-button click, expandable-text-box text, `/in/` author link, canonical post URL, missing author → `EXTRACTION_INCOMPLETE`, unparseable → `PARSER_REJECTED` | Fixtures only |
| Unit: deterministic gate | Job-seeker markers, blacklist companies, job-ad markers (A vs B), min length, recency, repost, promoted, self, already-engaged | None |
| Unit: contact regex | Email/phone/"DM me" extraction from post body | None |
| Unit: signal provider | Fake determinism, schema violation, non-JSON, timeout, transient classification, retry cap (max 2), quote grounding pass/fail, all-dropped path, threshold routing (70/40/0.6), archetype separation | Mocked fetch only |
| Unit: orchestrator | Run lifecycle, item dispositions, count reconciliation (I3), no auto-promotion, blacklist never rescued by signal, scoring cap | None |
| Unit: query stats | Zero-yield detection, approved attribution via promotion route | None |
| Integration (offline) | C2 fixture → pipeline → prospects + `engagement_posts` + `prospect_signals`; post persisted only after `EVALUATED`; cross-run dedupe; C4 fixture search HTML → ranked results; query stats rows; tenant predicates (cross-tenant read returns nothing) | MemoryStorage/PGlite only |
| Database | Migration `0008` on clean isolated PGlite/pg-mem; enum `ADD VALUE` outside transaction; unique constraints; count reconciliation | Isolated DB only |
| Regression | Existing suites: `tests/gates/*`, `tests/icp/*`, `tests/persistence/*`, `tests/unit/*`, colocated `src/**/*.test.ts` | None |
| Approved live smoke (separate approval) | One bounded, read-only, operator-observed run per channel; items seen + dispositions recorded; zero writes | Separate explicit approval per channel |

Commands after each slice: `npm test`, `npm run typecheck`, `npm run build` (`package.json:18,20,12`). Before any commit: `node .gitnexus/run.cjs analyze --index-only` then `detect_changes({scope:'all'})` per `AGENTS.md`. No migration against a shared/production database. Every live-run result labelled `NOT RUN` until actually performed.

## 12. Binary completion contract

Completion is YES only if **every** applicable item passes with the stated evidence. A working UI button, a 200 response, or a successful browser interaction is not evidence.

| # | Criterion | Required evidence |
| --- | --- | --- |
| C1 | Existing people-search discovery behaves identically after the Slice 0 refactor | TESTED_UNIT |
| C2 | Every run persists a `prospect_discovery_runs` row with terminal status and reconciling counts (I3) | TESTED_DATABASE |
| C3 | Every source item persists an item row with exactly one terminal disposition | TESTED_DATABASE |
| C4 | C2: N valid post URLs produce N posts and their distinct authors as prospects, with real post text | TESTED_UNIT + TESTED_DATABASE |
| C5 | C2: malformed/non-LinkedIn URL rejected with explicit reason, creates no prospect | TESTED_UNIT |
| C6 | C2: missing author profile URL → `EXTRACTION_INCOMPLETE`, no invented identity | TESTED_UNIT |
| C7 | C2: post persisted only after author reaches `EVALUATED`; no orphan posts | TESTED_DATABASE |
| C8 | No channel-supplied post ever triggers the synthetic-post fallback | TESTED_UNIT |
| C9 | C4: content-search URL built correctly for all three recency windows | TESTED_UNIT |
| C10 | C4: DOM extraction from fixture yields posts with author + canonical URL; truncated posts expanded | TESTED_UNIT |
| C11 | C4: deterministic gate blocks job seekers / blacklisted companies / job ads (A) before any LLM call | TESTED_UNIT |
| C12 | Signal scoring rejects invalid provider output → `SCORING_FAILED`, never a default score | TESTED_UNIT |
| C13 | Every persisted signal category quote is a verbatim substring of the scored post text | TESTED_UNIT |
| C14 | Archetype A and B never merged in one scoring call; archetype recorded per score | TESTED_UNIT |
| C15 | Signal scoring respects the per-run cap; exceeding refuses rather than silently truncating | TESTED_UNIT |
| C16 | A prospect failing `deterministicFilter` (incl. blacklist) is never promoted regardless of signal score (I4) | TESTED_UNIT + TESTED_DATABASE |
| C17 | No automatic `READY_FOR_CAMPAIGN` from any channel run; only `POST /api/prospects/:id/promote` promotes | TESTED_UNIT + TESTED_DATABASE |
| C18 | Query stats record zero-yield and approved-yield queries; promotion increments `prospectsApproved` | TESTED_DATABASE |
| C19 | Migration `0008` applies to a clean isolated database, incl. enum `ADD VALUE` handling | TESTED_DATABASE |
| C20 | Every new query carries an explicit `tenant_id` predicate; cross-tenant read returns nothing | TESTED_DATABASE |
| C21 | A disabled channel refuses with `CHANNEL_DISABLED` and performs no external call | TESTED_UNIT |
| C22 | Discovery writes nothing to `scheduled_actions`, `recommendation_approvals`, or `account_post_comments` (I8) | TESTED_DATABASE |
| C23 | Readiness, approval, budget, cooldown, kill-switch, lease gates unchanged | TESTED_UNIT (existing suites green) |
| C24 | `POST /api/prospects/discover` remains compatible with the current `UploadPanel.tsx` caller | TESTED_UNIT |
| C25 | `npm test`, `npm run typecheck`, `npm run build` all pass | recorded command output |
| C26 | GitNexus index refreshed; `detect_changes({scope:'all'})` reviewed with no unresolved HIGH/CRITICAL or `UNKNOWN` risk | recorded tool output |
| C27 | Every live-channel claim is either `VERIFIED_LIVE` with a recorded observed run, or explicitly `NOT RUN` | recorded evidence |

**Explicitly not completion criteria:** buying-signal accuracy/precision (unmeasurable before the labelling exercise), reply/conversion rate, and any claim that a channel is permitted by LinkedIn's terms.

## 13. Risks and rollback

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| RK1 | LinkedIn account restriction from content-search scanning (user prioritized C4) | HIGH | Channel flags default off; strict budgets (25 results/run); read-only; no UA/proxy/identity rotation; D1 confirmation required |
| RK2 | Buying-signal false positives drive irrelevant outreach | HIGH | Deterministic gate + quote grounding + human review before promotion; precision measured, never assumed |
| RK3 | Archetype A/B conflation targets hiring companies instead of agencies | HIGH | `targetArchetype` required per run; recorded per score; C14 gate |
| RK4 | LLM cost blowout | MEDIUM | Deterministic gate before any LLM call; hard per-run scoring cap; refuse rather than truncate |
| RK5 | LinkedIn DOM/markup drift breaks extraction | MEDIUM | Versioned parser; fixture tests per channel; unparseable → `PARSER_REJECTED`, never silent drop |
| RK6 | Enum `ALTER TYPE ... ADD VALUE` cannot run inside a transaction | MEDIUM | Isolate enum change in its own migration step; test on clean isolated DB (C19) |
| RK7 | OpenCLI cannot drive content search (U1) | MEDIUM | D9 probe before Slice 3; if blocked, re-plan rather than work around |
| RK8 | Placeholder-post fallback (X6) leaks into new channels | MEDIUM | P4 forbids it for channel-supplied posts; C8 gate |
| RK9 | Query-stats attribution drift (promotion not linked to run) | LOW | Promotion route is the single hook (F1); C18 gate |
| RK10 | GitNexus index stale | LOW | Refresh in Slice 0; C26 gate |

**Rollback:** migration `0008` is forward-only; enum values are permanent in Postgres (documented, not reversible). Code rollback = revert slices; channel flags default off make both channels inert with zero code change. No existing route or table is modified by this plan (additive only), so rollback never touches the current people-search/engagement paths.

## 14. Decisions requiring Tushar's review

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Platform-terms posture for C4 content-search scanning (parent D1). The user's rollout order prioritizes C4 — confirm this approves live content-search reads. | (a) approve C4; (b) approve C2 only | **(a)** per the stated order; flags stay default-off until explicitly enabled |
| D2 | Signal provider | (a) reuse `gpt-5.6-luna`; (b) Gemini; (c) new | **(a)** — credentials/error handling already exist |
| D3 | Budgets | — | 25 URLs / 25 results / 25 scoring calls / one active run per channel |
| D4 | Auto-promotion | (a) keep; (b) explicit review | **(b)** — new promotion route (F1) is the only bridge |
| D5 | Post persistence timing | (a) after `EVALUATED`; (b) always with flag | **(a)** — no orphan posts, no schema change to `engagement_posts.prospect_id` |
| D6 | Fix the existing placeholder-post fallback (`engagement-service.ts:255-264`) now or only for new channels | (a) both; (b) new channels only | **(b)** for this plan; (a) is a separate engagement plan |
| D9 | OpenCLI content-search capability probe before Slice 3 | (a) probe first; (b) assume | **(a)** — read-only probe; blocks Slice 3 if it fails |
| D10 | Signal thresholds | — | 70 / 40 / 0.6 |
| D11 | **"channel 6" in the rollout order** — parent plan defines channels 1–5 only | (a) C5-b engagers on own posts; (b) buying-signal engine as standalone; (c) other | Clarify before follow-on planning |
| D12 | Blacklist storage | (a) ICP criteria `excludedCompanies`/`hardExclusions`; (b) dedicated table | **(a)** for slice 1 — zero schema change, `deterministicFilter` already enforces it |

## 15. Definition of done

- Slices 0–3 implemented in dependency order; each slice's tests green (`npm test`, `npm run typecheck`, `npm run build`).
- C2 and C4 both usable end-to-end by the operator: input → extraction → deterministic gate → ICP pipeline → signal scoring → review → explicit promotion → grounded drafts, with zero placeholder posts.
- Migration `0008` applied to a clean isolated database; enum `ADD VALUE` handled; tenant predicates on every new query.
- Completion contract C1–C27 satisfied with recorded evidence; live claims `VERIFIED_LIVE` or `NOT RUN`.
- GitNexus `detect_changes({scope:'all'})` reviewed clean before commit.
- Follow-on plans for C5/C3 (and clarified "channel 6") reference this plan's foundation.

## 16. Handoff

**This plan is not approved and must not be implemented.**

After Tushar approves this exact plan and answers D1–D12:

| Step | Agent | Inputs required |
| --- | --- | --- |
| 1 | `coding-builder` | This plan; answers to D1–D12; approved slice scope (recommend Slice 0 alone first); refreshed GitNexus index |
| 2 | `coding-tester` | Slice scope; section 11 rows for that slice; section 12 rows in scope |
| 3 | `coding-reviewer` | Slice diff; test evidence; `detect_changes({scope:'all'})` output; in-scope completion-contract rows |
| 4 | this planning agent (`RELEASE_REVIEW` mode) | Delivered evidence vs sections 11 and 12 |

Implementation belongs to `coding-builder`. Verification belongs to `coding-tester` plus `coding-reviewer`. This agent neither implements nor approves its own plan.

Resolve D9 (OpenCLI content-search probe) before Slice 3 is scheduled. Slices 0–2 do not depend on it.

---

APPROVAL_STATUS: PENDING_USER_REVIEW

STOP: Review the plan with Tushar. Do not start implementation until Tushar explicitly approves this exact plan in a later message.