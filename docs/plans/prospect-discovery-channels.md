# Prospect Discovery Channels (Multi-Method Acquisition)

**Plan ID:** `prospect-discovery-channels`
**Mode:** FEATURE_PLANNING
**Active scope:** RecruitmentOS -> product / sales / engineering
**Status:** PROPOSED. This document authorizes planning only. It does not authorize application edits, migrations, live LinkedIn feed/keyword scanning, browser sessions, provider calls, or any external write.

## 1. Mode and scope

### In scope

Expand RecruitmentOS prospect acquisition from the current single automated path (LinkedIn people search via OpenCLI, with Google X-Ray fallback) into a set of explicitly separated, independently testable discovery channels, each producing prospects that flow through the same qualification and readiness gates that exist today.

Channels covered:

| # | Channel | Source of request |
| --- | --- | --- |
| 1 | Current state audit: how prospects are ingested today | REQUIRED (user asked to inspect) |
| 2 | Explicit LinkedIn post URL list -> author becomes prospect, post ingested directly | REQUIRED |
| 3 | LinkedIn feed scan (home / creator / network feed) for ICP-relevant posts | REQUIRED |
| 4 | LinkedIn post keyword search + AI Buying Signal detection tuned to RecruitmentOS | REQUIRED |
| 5 | Additional high-ROI channels ("what else?") | PROPOSED |

### Out of scope (explicit non-goals)

- No new live LinkedIn write actions. Like/Comment execution, approval, budget, cooldown, kill-switch, and lease semantics stay exactly as implemented; discovery must not touch them.
- No removal of CSV or manual intake. They remain fallback and regression paths.
- No LinkedIn connection requests, DMs, InMail, or follow-up sequencing added by this feature.
- No Sales Navigator paid-tier dependency in the first release.
- No bulk profile-page crawling, credential collection, CAPTCHA bypass, proxy rotation, user-agent rotation for evasion, or multi-account operation.
- No claim that LinkedIn's terms permit feed/keyword scraping. That remains an operational and legal decision for Tushar (see Decisions).
- No automatic promotion to `READY_FOR_CAMPAIGN` for signal-sourced prospects beyond what is explicitly decided in Decision D4.

## 2. Decision / intended outcome

A RecruitmentOS operator can acquire ICP-relevant prospects through five distinct, separately switchable channels instead of one, and every channel lands in the same audited funnel: `raw source item -> extracted identity -> deterministic exclusion -> ICP evaluation -> (optional buying-signal score) -> operator review -> READY_FOR_CAMPAIGN -> engagement drafts`. Channel choice changes only where prospects come from and what evidence is attached; it never changes who approves an external action.

## 3. Business contract

### 3.1 Who

Single operator (founder-operator of a boutique recruitment agency, or Tushar operating RecruitmentOS on their behalf). Single-user mode is the current runtime reality (`src/server.ts:199` returns `mode: 'single-user'`; `src/db/tenant-context.ts:11` falls back to a fixed tenant UUID).

### 3.2 Problem

Today the operator has exactly one automated acquisition motion: a LinkedIn people-search keyword query paginated one page at a time. That motion finds people who *look* like the ICP by title and industry, but carries no evidence that the person currently has the pain RecruitmentOS solves, and no evidence that they are active on LinkedIn right now. Two consequences:

1. Engagement targets are frequently inactive, so the engagement service manufactures a placeholder post to keep the pipeline moving (`src/services/engagement/engagement-service.ts:255-264` synthesises a post when `rawPosts.length === 0`). That is a real, evidenced product defect this plan must not extend to new channels.
2. Timing is blind. A recruitment agency owner complaining this week about manual sourcing is a far better target than one who matched a title filter.

### 3.3 Trigger

Operator opens the Prospects/Upload area and chooses a discovery channel, supplying channel-specific input (nothing, a URL list, a feed selection, or keywords). Every run is explicitly operator-initiated in this release; no scheduled or background discovery.

### 3.4 Inputs per channel

| Channel | Operator input | Machine input |
| --- | --- | --- |
| C1 people search (existing) | countries, positions, keyword, page | ICP criteria |
| C2 post URL list | 1..N LinkedIn post URLs (paste or newline list) | ICP criteria |
| C3 feed scan | feed kind (home / creator handles / network), scroll depth budget | ICP criteria, signal criteria |
| C4 keyword post search | keyword/phrase set, recency window, result budget | ICP criteria, signal criteria |
| C5 proposed channels | channel-specific seed (post URL for commenters, event URL, saved-search URL, company/job seed) | ICP criteria, signal criteria |

### 3.5 Workflow (channel-agnostic spine)

1. Operator selects channel and supplies input.
2. Server creates a `discovery run` record with channel, input snapshot, and budget.
3. Channel adapter returns raw source items (profile candidates, posts, or post+author pairs).
4. Extraction normalises to `{ prospect identity, optional post payload, optional signal payload }`.
5. Deduplication: canonical LinkedIn profile URL for prospects, canonical post identifier for posts.
6. Deterministic exclusion (existing `deterministicFilter`).
7. ICP evaluation (existing `PersistentIcpPipeline` + `ICPModelProvider`).
8. Optional buying-signal scoring for channels that carry post text (C2, C3, C4, and some C5).
9. Operator review; explicit promotion to `READY_FOR_CAMPAIGN`.
10. Post ingestion and draft generation via existing engagement path.

### 3.6 Outputs

- New or reconciled `prospects` rows with channel provenance.
- `engagement_posts` rows for channels that already carry post text, avoiding a second fetch.
- Per-run reconciled counts: `itemsSeen = accepted + duplicatesInRun + duplicatesExisting + invalid + parserRejected`.
- Signal evidence records for signal-scored channels.
- Audit events for every run and every stage transition.

### 3.7 Human approval points

1. Promotion of a prospect to `READY_FOR_CAMPAIGN` (already the only bridge to engagement; enforced at `src/services/engagement/engagement-service.ts:140-145` and `:698`).
2. Approval of a specific LIKE or COMMENT recommendation revision (`applyReviewDecision` / `requestAction`).
3. Enabling any channel that touches the live LinkedIn feed or post search (channel-level feature flag, default off).

### 3.8 Independently usable outcome

Each channel is shippable alone. Shipping only C2 (post URL list) already gives the operator a complete usable motion: paste 10 post URLs from recruitment-agency owners, get 10 qualified-or-rejected prospects with the real post already attached, review, promote, and draft — with zero placeholder posts.

## 4. Requirements

### 4.1 REQUIRED (explicitly asked)

| ID | Requirement |
| --- | --- |
| R1 | Document the current ingestion paths with exact file evidence. |
| R2 | Channel: accept a list of LinkedIn post URLs; extract post author as prospect; ingest the post directly for like/comment consideration. |
| R3 | Channel: scan a LinkedIn feed (home, specific creator feeds, or network feed) and select ICP-relevant posts. |
| R4 | Channel: keyword search over LinkedIn posts, plus AI Buying Signal detection tuned to RecruitmentOS pains. |
| R5 | Define the operator workflow per channel end to end: input -> extraction -> ICP qualification -> dedupe -> `READY_FOR_CAMPAIGN` -> draft generation. |
| R6 | Specify buying-signal detection: scoring prompt, RecruitmentOS criteria, false-positive filtering. |
| R7 | Recommend the highest-ROI additional channels. |
| R8 | Binary completion contract, exact files inspected, risks, open decisions. |

### 4.2 PROPOSED (recommended, needs approval)

| ID | Proposal | Why |
| --- | --- | --- |
| P1 | Unify all channels behind one `ProspectSourceChannel` interface plus one orchestrator, rather than adding four parallel code paths. | Four independent paths would each need their own dedupe, provenance, and error handling; the existing `ProspectDiscoveryService` already proves the shape. |
| P2 | Introduce durable relational provenance (`prospect_discovery_runs`, `prospect_discovery_items`) instead of stuffing channel data into `prospects.custom_attributes`. | Current code writes `campaignId`, `campaignName`, `page`, and `source` into `custom_attributes` (`src/server.ts:487-496`; `src/services/discovery/prospect-discovery-service.ts:46-51`), which is not queryable provenance. |
| P3 | Separate `signal` state from `icp fit` state. A prospect can be high-fit/no-signal or low-fit/high-signal; do not collapse into `currentStage`. | Constitution section 7 requires separate state dimensions. |
| P4 | Remove the synthetic placeholder post fallback for signal-sourced channels; a channel that supplies a real post must never fall back to a fabricated one. | `engagement-service.ts:255-264` currently fabricates post text. Extending that to new channels would produce comments grounded in invented content. |
| P5 | Add `POST_URL_LIST`, `FEED_SCAN`, `POST_KEYWORD_SEARCH` (and approved C5 values) to the post source enum, replacing today's misleading `PLAYWRIGHT` label. | `ProfileActivityPostSource` declares `sourceType = 'PLAYWRIGHT'` (`profile-activity-post-source.ts:15`) while actually using OpenCLI (`:37-42`) — provenance is already wrong. |
| P6 | Channel-level feature flags, all default off, following the existing `FEATURE_05_BROWSER_ENABLED` pattern (`src/server.ts:113`). | Keeps risky channels dark until approved. |
| P7 | Provider-independent `BuyingSignalProvider` interface with a deterministic fake, mirroring `EngagementAIProvider`. | Required for offline tests; the existing engagement provider proves the pattern (`engagement-ai-provider.ts:17-21`). |

### 4.3 OPTIONAL

| ID | Option |
| --- | --- |
| O1 | Signal decay: down-weight signals older than a configurable window. |
| O2 | Operator-tunable signal weights per pain category in the ICP definition. |
| O3 | Company-level signal aggregation (multiple people at one agency showing the same pain). |

### 4.4 DEFERRED

| ID | Deferred item | Reason |
| --- | --- | --- |
| D-a | Scheduled/background discovery runs | No durable worker/queue for discovery exists; `scheduledActions` covers engagement actions only. |
| D-b | Sales Navigator saved-search ingestion | Paid tier + stricter terms; needs its own approval. |
| D-c | Cross-channel identity resolution beyond canonical LinkedIn URL (name+company fuzzy match) | Adds false-merge risk; not needed for first release. |
| D-d | Multi-tenant channel configuration UI | Runtime is single-user today. |

## 5. Current-state evidence

**EVIDENCE_GATE: PASS.** Working directory `/Users/tusharmangla/Dev/outreach/linkedin-outreach` inspected. `git status --short` returned empty (clean worktree). `git log --oneline -12` inspected; HEAD is `a4a5343 changes`. GitNexus index is 3 commits behind HEAD (reported by `impact`), so graph findings below are planning guidance and must be refreshed before implementation.

### 5.1 Files actually read

| Path | What it proves |
| --- | --- |
| `src/db/schema.ts` (344 lines, full) | Prospect stages, prospects table + unique index, engagement posts/drafts/history, comment slots, campaigns, scheduled actions. |
| `src/services/icp/csv-importer.ts` (94 lines, full) | CSV intake path and header aliasing. |
| `src/services/icp/source-adapter.ts` (154 lines, full) | `ProspectSourceAdapter` interface, CSV + fixture adapters. |
| `src/services/icp/persistent-pipeline.ts` (241 lines, full) | Qualification pipeline: batch, normalise, insert-if-absent, deterministic filter, AI evaluate, stage assignment, override. |
| `src/services/icp/deterministic-filter.ts` (74 lines, full) | Six deterministic exclusion rules. |
| `src/services/icp/ai-provider.ts` (54 lines, full) | `ICPModelProvider` interface + `FakeAIProvider`. |
| `src/services/icp/gemini-evaluator.ts` (68 lines, full) | Gemini evaluator, prompt construction, retry. |
| `src/services/icp/url-normalizer.ts` (27 lines, full) | Canonical profile/company URL normalisation. |
| `src/services/icp/index.ts` (11 lines, full) | Pipeline wired to `FakeAIProvider` at module scope. |
| `src/schemas/icp.ts` (74 lines, full) | `IcpCriteria`, `ProspectInput`, `IcpScore` contracts. |
| `src/services/discovery/prospect-discovery-service.ts` (157 lines, full) | The one existing automated discovery orchestrator and its dependency seams. |
| `src/services/discovery/opencli-linkedin-source.ts` (286 lines, full) | OpenCLI LinkedIn people-search source, markdown parser, faceted search URL builder, geo URN map. |
| `src/services/discovery/google-xray-source.ts` (lines 1-120 read) | Fallback HTML search source, error classes, canonical URL unwrapping, stable UA policy. |
| `src/services/engagement/engagement-service.ts` (lines 1-1219 read) | Scan gating, single-active-comment rule, placeholder-post fallback, draft/revision/approval writes, action request gating, reconciliation. |
| `src/services/engagement/prospect-post-source.ts` (58 lines, full) | `ProspectPostSource` interface, `RawPost`, content hashing, normalisation. |
| `src/services/engagement/profile-activity-post-source.ts` (74 lines, full) | OpenCLI `linkedin posts --profile-url` post retrieval; mislabelled `sourceType`. |
| `src/services/engagement/post-filter.ts` (103 lines, full) | Age/length/keyword filtering and the keep-exactly-one selection rule. |
| `src/services/engagement/post-identity.ts` (20 lines, full) | Canonical post identifier from activity URN or normalised URL. |
| `src/services/engagement/engagement-ai-provider.ts` (21 lines, full) | `EngagementAIProvider` interface incl. optional `selectBestPosts`. |
| `src/services/engagement/luna-engagement-provider.ts` (188 lines, full) | Live LLM provider, comment prompt, `selectBestPosts` prompt and JSON-array parsing. |
| `src/executors/opencli.ts` (366 lines, full) | Browser like/comment execution, duplicate detection, verification. |
| `src/server.ts` (lines 60-259, 340-639 read; route inventory grepped) | Route surface, engagement service construction, discovery route, campaign auto-enrol, auto-scan on ingest. |
| `src/components/UploadPanel.tsx` (lines 220-289 read; other lines grepped) | Discovery UI trigger, response handling, tab navigation. |
| `src/db/db-adapter.ts` (42 lines, full) | `DBAdapter` surface available to the pipeline. |
| `src/db/tenant-context.ts` (19 lines, full) | AsyncLocalStorage tenant context with fixed fallback. |
| `src/types.ts` (lines 180-256 read) | `PostSourceType`, `LinkedInPost`, draft/history types. |
| `drizzle/meta/_journal.json` (62 lines, full) | 8 applied migrations, latest `0007_engagement_history_action_id`. |
| `drizzle/0000_fixed_dexter_bennett.sql`, `0002`, `0003`, `0004`, `0005`, `0006` (grepped for tenant/policy/index) | Tenant columns and unique indexes present; **no** `CREATE POLICY` / `ENABLE ROW LEVEL SECURITY` anywhere in `drizzle/`. |
| `package.json` (67 lines, full) | Vitest, Drizzle, Zod, Express, React, Playwright, Gemini SDK; scripts `test`, `typecheck`, `build`. |
| `docs/plans/0.7-automated-google-xray-prospect-sourcing-plan.md` (206 lines, full) | The canonical prior discovery plan and its documented boundaries. |
| `docs/ARCHITECTURE_DECISIONS.md` (29 lines, full) | ADR-003 tenant isolation intent, ADR-004 simulation-first, ADR-005 provider boundaries. |
| `~/.config/opencode/agency-os/projects/recruitmentos/ARCHITECTURE.md` (42 lines, full) | Scope routing rules; state vs memory vs action. |
| `~/.config/opencode/agency-os/projects/recruitmentos/STATE-MEMORY-ACTIONS.md` (77 lines, full) | Connector rule: ingest -> classify -> extract -> route to state/memory/action. |

### 5.2 Searches performed (for MISSING claims)

All searches rooted at `/Users/tusharmangla/Dev/outreach/linkedin-outreach` (and `src/` where noted), excluding `node_modules` and `dist`:

| Search term / pattern | Roots | Result |
| --- | --- | --- |
| `buying.?signal`, `BUYING_SIGNAL` | repo root | 0 matches |
| `feedScan`, `feed_scan` | repo root | 0 matches |
| `commenter`, `Commenter` | repo root | 0 matches |
| `eventAttendee` | repo root | 0 matches |
| `salesNavigator` | repo root | 0 matches (only a CSV-format label string in `UploadPanel.tsx:88,540`) |
| `hiring badge` | repo root | 0 matches |
| `postUrls` | repo root | 2 matches, both test fixtures (`engagement-service.test.ts:182,184`) |
| `search/results/content`, `search/results/posts` | `src/` | 0 matches |
| `/feed/` | `src/` | matches only `setup-linkedin.ts:19` (login navigation) and `urn:li:activity` post-identity tests |
| `discover|Discovery|xray|XRAY` | `src/` | matches confined to `services/discovery/*`, `server.ts` discovery route, `UploadPanel.tsx` |
| `GOOGLE_XRAY|OPENCLI|sourceType|discoverySource` | `src/` | 15 matches; `sourceType` only ever `PLAYWRIGHT`/`FIXTURE`/`MANUAL`; `GOOGLE_XRAY` only as a string literal in `custom_attributes` |
| `CREATE POLICY`, `ROW LEVEL SECURITY`, `POLICY` | `drizzle/` | 0 matches |
| glob `tests/**/*` (relative) vs `ls -R tests` | repo | Test suites exist at `tests/gates`, `tests/icp`, `tests/persistence`, `tests/unit` plus colocated `src/**/*.test.ts` |
| glob `docs/plans/prospect-discovery*` | repo | 0 matches — no prior plan for this feature |

### 5.3 Evidence ledger

#### EXISTING

| Capability | Label | Evidence |
| --- | --- | --- |
| Prospect stage machine: `INGESTED`, `FILTERED_OUT`, `EVALUATED`, `REQUIRES_REVIEW`, `READY_FOR_CAMPAIGN`, `APPROVED_FOR_OUTREACH`, `REJECTED` | IMPLEMENTED | `src/db/schema.ts:4-12` |
| Tenant-scoped canonical prospect uniqueness | IMPLEMENTED | `src/db/schema.ts:14-27` (`tenant_id_normalized_url_idx`); `drizzle/0000_fixed_dexter_bennett.sql:82` |
| **Ingestion path A — CSV upload** | IMPLEMENTED | `src/services/icp/csv-importer.ts:62-94`; routes `src/server.ts:225-238` (`POST /api/imports`), `:240-253` (`POST /api/imports/:id/process`) |
| **Ingestion path B — CSV/fixture source adapters** | IMPLEMENTED | `src/services/icp/source-adapter.ts:22-114` (CSV), `:116-152` (fixture) |
| **Ingestion path C — automated LinkedIn people search (OpenCLI, X-Ray fallback)** | IMPLEMENTED | `src/services/discovery/prospect-discovery-service.ts:64-156`; `src/services/discovery/opencli-linkedin-source.ts:240-283`; route `src/server.ts:380-616` |
| **Ingestion path D — manual single prospect add** | IMPLEMENTED | UI handler `src/components/UploadPanel.tsx:220-225` (posts to prospects API) |
| Qualification pipeline (batch, normalise, insert-if-absent, deterministic filter, AI evaluate, stage) | IMPLEMENTED | `src/services/icp/persistent-pipeline.ts:21-196` |
| Deterministic exclusions: geography, negative keywords, excluded titles, excluded companies, hard exclusions, company size | IMPLEMENTED | `src/services/icp/deterministic-filter.ts:8-73` |
| Threshold routing (`qualificationThreshold` 80, `reviewThreshold` 50) | IMPLEMENTED | `src/services/icp/persistent-pipeline.ts:144-157`; defaults `src/schemas/icp.ts:21-22` |
| Provider-independent ICP scoring + deterministic fake | IMPLEMENTED / TESTED_UNIT | `src/services/icp/ai-provider.ts:3-53`; `tests/icp/gemini-evaluator.test.ts`, `tests/icp/deterministic-filter.test.ts` |
| In-run + cross-run dedupe by canonical profile URL | IMPLEMENTED / TESTED_UNIT | `prospect-discovery-service.ts:56-62,111-130`; `src/services/discovery/prospect-discovery-service.test.ts:34-142` |
| Canonical post identity (activity URN preferred) | IMPLEMENTED / TESTED_UNIT | `src/services/engagement/post-identity.ts:5-20`; `post-identity.test.ts:7-41` |
| Post retrieval for a known prospect profile via OpenCLI | IMPLEMENTED | `src/services/engagement/profile-activity-post-source.ts:36-72` |
| Post filtering (age, min length, optional keyword allow-list, keep-one rule) | IMPLEMENTED | `src/services/engagement/post-filter.ts:34-102` |
| LLM post selection (`selectBestPosts`) with recruitment-relevance prompt | IMPLEMENTED | `luna-engagement-provider.ts:124-187` |
| Readiness gate before any engagement scan | IMPLEMENTED / TESTED_UNIT | `engagement-service.ts:140-145`, `:698`; `engagement-service.test.ts` |
| Comment slot uniqueness per (tenant, account, post) | IMPLEMENTED | `src/db/schema.ts:330-344`; `drizzle/0006_comment_slot_claims.sql:41` |
| Approval / revision / budget / cooldown / kill-switch / lease gating | IMPLEMENTED | `engagement-service.ts:675-793`; `src/server.ts:126-189` |
| Auto-enrol discovered prospects into a campaign and auto-promote to `READY_FOR_CAMPAIGN` | IMPLEMENTED | `src/server.ts:484-514` |
| Audit events for discovery runs | IMPLEMENTED | `src/server.ts:559-581` (`discovery.run.completed`) |
| Discovery pagination state persisted in ICP criteria | IMPLEMENTED | `src/server.ts:541-557`; read at `:347-372` |

#### MISSING

Each row below is backed by the searches in 5.2.

| Capability | Label | Search that found nothing |
| --- | --- | --- |
| Post-URL-list ingestion channel | MISSING | `postUrls` (repo, only test fixtures); no route matching `post` + `urls` in the 31 routes grepped from `src/server.ts` |
| Feed scan channel (home/creator/network) | MISSING | `feedScan`, `feed_scan`, `/feed/` in `src/` |
| Post keyword search channel | MISSING | `search/results/content`, `search/results/posts` in `src/` |
| AI buying-signal detection of any kind | MISSING | `buying.?signal`, `BUYING_SIGNAL`, `signal|Signal` in `src/services` (only `AbortSignal` matches) |
| Commenter/reactor harvesting | MISSING | `commenter`, `Commenter` |
| Event attendee harvesting | MISSING | `eventAttendee` |
| Sales Navigator saved-search ingestion | MISSING | `salesNavigator`, `Sales Navigator` (only a CSV format label) |
| Hiring-badge / job-poster channel | MISSING | `hiring badge` |
| Durable discovery run/item provenance tables | MISSING | `src/db/schema.ts` read in full — no discovery tables; `drizzle/meta/_journal.json` lists 8 migrations, none discovery-related |
| Row-level security policies | MISSING | `POLICY`, `ROW LEVEL SECURITY` across `drizzle/` — 0 matches, despite ADR-003 (`docs/ARCHITECTURE_DECISIONS.md:13`) stating RLS is part of tenant isolation |
| Any prior plan for this feature | MISSING | glob `docs/plans/prospect-discovery*` |

#### CONFLICTING

| # | Conflict | Evidence | Resolution under source-of-truth order |
| --- | --- | --- | --- |
| X1 | `docs/plans/0.7-...md:29` states discovery must never grant campaign readiness by itself; `src/server.ts:488-496` sets `currentStage: 'READY_FOR_CAMPAIGN'` for every ingested discovery prospect. | Plan (rank 6) vs implementation (rank 7) | Plan wins. Decision D4 must confirm whether auto-promotion is now intended; if yes, the plan document must be corrected rather than the rule silently dropped. New channels must not copy the auto-promotion until D4 is answered. |
| X2 | `docs/plans/0.7-...md:84` specifies discovery under `src/services/icp/`; actual code is `src/services/discovery/`. | Plan vs implementation | Implementation wins for naming (extend `src/services/discovery/`); the plan text is stale. |
| X3 | `docs/plans/0.7-...md` names Google X-Ray as primary; `src/server.ts:459-473` uses OpenCLI LinkedIn primary with X-Ray fallback, and commit `d594cfd` reads "standardize post discovery to use only OpenCLI". | Plan vs implementation + commit | Implementation wins; treat OpenCLI as the primary browser seam for new channels. |
| X4 | `ProfileActivityPostSource.sourceType = 'PLAYWRIGHT'` (`profile-activity-post-source.ts:15`) but the implementation shells out to OpenCLI (`:37-42`). Enum lacks an OpenCLI value (`src/db/schema.ts:197`). | Implementation self-conflict | Provenance is wrong today. P5 proposes fixing the enum as part of this feature; flagged, not silently reused. |
| X5 | ADR-003 (`docs/ARCHITECTURE_DECISIONS.md:13`) claims PostgreSQL RLS; no policy exists in `drizzle/`. | Canonical doc vs migrations | Do not claim RLS as an isolation control for new tables. Tenant scoping is application-level (`tenant-context.ts`) plus explicit `tenant_id` predicates. Raised as risk RK7. |
| X6 | `engagement-service.ts:255-264` fabricates post text when no real post is found, contradicting the grounded-comment requirement in `luna-engagement-provider.ts:38-48` ("Reference a SPECIFIC detail from the post text"). | Implementation self-conflict | P4 forbids extending this to new channels; existing behaviour change requires Decision D6. |

#### UNKNOWN

| # | Unknown | Why it cannot be resolved from the repo |
| --- | --- | --- |
| U1 | Whether `opencli` exposes commands for feed reading, post keyword search, post commenters/reactors, or event attendees. Only `browser <session> open/eval/extract`, `linkedin posts --profile-url`, `linkedin connect`, and `browser linkedin open/extract` appear in code (`executors/opencli.ts:32-42`, `profile-activity-post-source.ts:37-42`, `opencli-linkedin-source.ts:255,271`). | OpenCLI is an external binary; its capability surface is not in this repository. Must be probed before C3/C4/C5 slices are estimated. |
| U2 | Whether the tenant's LinkedIn account has Sales Navigator or Recruiter entitlements. | Not represented in `browser_accounts` (`src/db/schema.ts:288-296`). |
| U3 | Current live test status of the whole suite. | `npm test` was not run; bash execution is restricted to read-only inspection commands in this session. All test labels above are read from test file contents, not from a run. |
| U4 | Whether existing production data has prospects whose `custom_attributes.source` is set, and how many. | Requires a database query, not performed. |
| U5 | LinkedIn's current enforcement behaviour against feed/keyword scraping at the intended volume. | External, and a legal/ops decision (Decision D1). |

### 5.4 Graph impact (planning guidance only; index 3 commits stale)

- `EngagementService.scanProspect` upstream: 2 direct callers, risk LOW, epistemic `exact`, 1 affected process (`ingest` in `src/server.ts`).
- `ProspectDiscoveryService` upstream: 1 direct caller, risk LOW, epistemic `exact`.

Both must be re-derived after `node .gitnexus/run.cjs analyze --index-only` before implementation.

## 6. Channel specifications

### 6.0 Channel 1 — current state (IMPLEMENTED, documented for contrast)

| Aspect | Current behaviour | Evidence |
| --- | --- | --- |
| Input | `countries[]`, `positions[]`, `keyword`, `page` | `src/server.ts:393-400` |
| Source | Faceted LinkedIn people search URL opened via OpenCLI, markdown extracted and parsed; Google/DuckDuckGo HTML fallback on OpenCLI failure | `opencli-linkedin-source.ts:203-238,251-283`; `src/server.ts:459-473` |
| Extraction | Name, title, company, location, canonical profile URL; hard-coded defaults substituted when absent (`DEFAULT_TITLE`, `DEFAULT_COMPANY`, `DEFAULT_LOCATION`) | `opencli-linkedin-source.ts:7-10,147-153` |
| Dedupe | In-run map keyed on lowercased canonical URL, then tenant lookup | `prospect-discovery-service.ts:111-127` |
| Qualification | `PersistentIcpPipeline.run` | `src/server.ts:482` |
| Stage after run | Forced to `READY_FOR_CAMPAIGN`, enrolled in an auto-created campaign, then auto-scanned for posts | `src/server.ts:451-457,488-513` |
| Signal | None | search evidence 5.2 |
| Provenance | `custom_attributes.source = 'GOOGLE_XRAY'` (a fixed literal, even when OpenCLI was the actual source) plus `campaignId`, `campaignName`, `page` | `prospect-discovery-service.ts:46-51`; `src/server.ts:487-496` |

Two defects worth naming: the source literal is wrong for OpenCLI runs, and default title/company/location strings are invented facts rather than evidence gaps (contradicting `docs/plans/0.7-...md:47`, which requires missing fields be represented as empty).

### 6.1 Channel 2 — LinkedIn post URL list (REQUIRED, R2)

Highest-ROI first slice: no feed access, no search access, no scraping volume, deterministic input, real post text guaranteed.

**Workflow**

1. Operator pastes N post URLs (newline or comma separated). Server caps N (Decision D3).
2. For each URL: compute `canonicalPostIdentifier` (existing function). Reject non-LinkedIn and unparseable URLs with an explicit reason.
3. Fetch the post via a `PostByUrlSource` (PROPOSED) that opens the post URL through OpenCLI and extracts author name, author profile URL, post text, and published time. Author profile URL is mandatory; if it cannot be extracted the item is `EXTRACTION_INCOMPLETE`, not guessed.
4. Normalise the author to `ProspectInput`. Fields not extractable stay empty strings — never default literals (correcting the Channel 1 defect).
5. Dedupe author by canonical profile URL; dedupe post by canonical post identifier against `engagement_posts.tenant_canonical_post_idx` (`src/db/schema.ts:213-215`).
6. Run the author through `PersistentIcpPipeline`.
7. Score the post for buying signal (section 7).
8. Persist the post into `engagement_posts` with `sourceType = 'POST_URL_LIST'` and the real `postText` — this is the point of the channel, and it removes any need for the placeholder fallback.
9. Operator reviews fit + signal; explicit promotion to `READY_FOR_CAMPAIGN`.
10. Draft generation proceeds through the existing engagement path, grounded in the real post.

**Non-goals for C2:** no fetching of *other* posts by the same author; no comment-thread harvesting (that is C5-a).

**Ordering note:** the post is fetched before the author is qualified, so a rejected author leaves an orphan post. The post must be persisted only after the author reaches at least `EVALUATED`, or persisted with an explicit `authorQualified = false` marker. Decision D5.

### 6.2 Channel 3 — feed scan (REQUIRED, R3)

**Sub-modes** (each independently switchable):

| Mode | Target | Notes |
| --- | --- | --- |
| C3-home | `linkedin.com/feed/` | Algorithmic; content depends on who the operator already follows. Lowest precision. |
| C3-creator | `linkedin.com/in/<handle>/recent-activity/all/` for a configured list of recruitment-industry creators | Highest precision of the three; the operator curates the creator list. Reuses the existing profile-activity retrieval shape (`profile-activity-post-source.ts:36-72`). |
| C3-network | Network/following feed | Middle precision. |

**Workflow**

1. Operator selects mode, supplies creator handles for C3-creator, and a scroll-depth budget (bounded server-side).
2. Feed adapter returns raw items: `{ postUrl, postText, authorName, authorProfileUrl, publishedAt }`. Items missing `authorProfileUrl` are discarded with reason, never inferred.
3. Deterministic pre-filter before any AI call: post age within window, minimum text length, exclude reposts without commentary, exclude promoted/sponsored items, exclude the operator's own posts and already-engaged posts. Reuse and extend `PostFilter` (`post-filter.ts:34-102`) rather than writing a second filter — but note its current keep-exactly-one rule is prospect-scoped and must not be applied to a feed batch. This requires either a mode flag or a separate selection step. Flagged as an implementation constraint, not a silent reuse.
4. Author -> `ProspectInput` -> `PersistentIcpPipeline`.
5. Post -> buying-signal scoring.
6. Rank surviving items by `signalScore` then `icpScore`; surface top K to the operator.
7. Operator reviews and promotes.

**Cost control:** signal scoring is an LLM call per post. Feed scans can return hundreds of items. The deterministic pre-filter and a hard per-run scoring cap are mandatory, not optional (Decision D3).

### 6.3 Channel 4 — post keyword search + buying-signal detection (REQUIRED, R4, R6)

**Workflow**

1. Operator supplies keyword/phrase set, recency window, and result budget. Server may also derive keywords from `IcpCriteria.positiveKeywords` (`src/schemas/icp.ts:14`).
2. Search adapter opens LinkedIn's post/content search results and extracts post items in the same shape as C3. The exact OpenCLI capability is UNKNOWN (U1) and must be probed first.
3. Deterministic pre-filter, identical to C3.
4. Buying-signal scoring (section 7) — this is the channel's core value.
5. Author extraction, dedupe, `PersistentIcpPipeline`.
6. Operator reviews ranked by signal; promotes.

**Critical distinction:** a post matching "we are hiring" identifies a company *with* a hiring need. RecruitmentOS sells to *recruitment agencies*, so the buyer is the agency owner, not the hiring company. Both are valid but they are different ICPs. The signal taxonomy in section 7 separates them, and the ICP definition must decide which one a given run targets. Getting this wrong is the single largest false-positive source in this channel.

### 6.4 Channel 5 — recommended additional channels (PROPOSED, R7)

Ranked by expected ROI per unit of implementation and platform risk.

| Rank | Channel | Why it is high ROI | Implementation cost | Platform risk | Recommendation |
| --- | --- | --- | --- | --- | --- |
| 1 | **C5-a: commenters and reactors on recruitment-influencer / competitor posts** | People who publicly comment on a post about agency growth pain have self-selected for both the topic and active LinkedIn presence. Highest intent-per-item of any channel here. Seed is a single post URL, so input is as cheap as C2. | Low-medium — reuses C2's post-open path, adds comment/reaction list extraction and pagination. | Medium (reading a public comment list). | **Build immediately after C2.** Best ratio in the set. |
| 2 | **C5-b: engagers on the operator's own posts** | Warmest possible audience: already aware, already engaged, no cold-start. Zero discovery risk since it is the operator's own content. | Low — same extraction as C5-a, seeded from the operator's own post URLs. | Low. | **Build.** Cheapest meaningful win. |
| 3 | **C5-c: LinkedIn event attendees (recruitment/staffing events)** | Attendee lists are topically pre-qualified and often list agency owners explicitly. | Medium — event page structure differs from feed/post; attendee visibility varies by event. | Medium-high (attendee lists are often gated). | Prototype after C3/C4. Verify attendee visibility first. |
| 4 | **C5-d: second-degree connections of existing qualified prospects** | Agency owners cluster; a qualified prospect's network is dense with similar owners. Reuses existing people-search infrastructure with a network filter. | Low — the faceted search URL builder already exists (`opencli-linkedin-source.ts:203-238`); needs a network-degree facet. | Low-medium (standard people search). | **Build.** Cheap extension of an existing capability. |
| 5 | **C5-e: LinkedIn company-page followers of ATS / recruitment-tooling vendors** | Following an ATS or sourcing tool vendor is a strong proxy for being in the recruitment business and tooling-aware. | Medium — follower lists are frequently gated. | Medium-high. | Defer; validate visibility before committing. |
| 6 | **C5-f: agencies posting job ads at high frequency** | High job-post volume indicates an active agency with delivery load — a proxy for growth pain. Deterministic and countable, needing no LLM. | Medium — job search extraction is a new surface. | Medium. | Consider after C4. Attractive because the signal is deterministic. |
| 7 | **C5-g: Sales Navigator saved searches** | Best filtering available (headcount growth, tenure, function) if the entitlement exists. | Low if entitlement exists. | Terms risk is materially higher; automation of Sales Navigator is explicitly restricted. | **DEFERRED (D-b).** Requires its own approval and U2 resolution. |

Recommended build order across everything: **C2 -> C5-a -> C5-b -> C5-d -> C4 -> C3 -> (C5-c / C5-f)**. Rationale: C2 delivers a complete usable motion with the least platform exposure and immediately fixes the placeholder-post defect for its own prospects; C5-a/C5-b/C5-d each reuse machinery C2 or Channel 1 already establishes; C4 and C3 need the buying-signal engine plus an unresolved OpenCLI capability question (U1), so they carry the most schedule risk.

## 7. AI Buying Signal detection (REQUIRED, R6)

### 7.1 Position in the pipeline

Buying signal is a **post-level** score attached to a **prospect-level** evidence trail. It is a distinct dimension from ICP fit, and both are distinct from readiness:

| Dimension | Question | Where it lives today |
| --- | --- | --- |
| ICP fit | Is this the right kind of person/company? | `icp_evaluations.score` (`src/db/schema.ts:86-100`) |
| Buying signal | Does this person show the pain we solve, recently? | **MISSING** — proposed `prospect_signals` |
| Readiness | Has a human approved contacting them? | `prospects.current_stage` |
| Action approval | Has a human approved this specific comment? | `recommendation_approvals` |

Collapsing signal into `current_stage` or into `icp_evaluations.score` is forbidden (P3, and constitution section 7).

### 7.2 RecruitmentOS signal taxonomy

Two buyer archetypes must stay separate. `targetArchetype` is a required field on the signal criteria; a run declares which it seeks.

**Archetype A — recruitment agency owner/operator (primary RecruitmentOS ICP)**

| Category | What counts as evidence | Illustrative language |
| --- | --- | --- |
| `MANUAL_SOURCING_FATIGUE` | Author describes time lost to manual candidate/client sourcing | "spent all day on Boolean searches", "sourcing is eating my week" |
| `INCONSISTENT_LEAD_FLOW` | Feast-or-famine pipeline, referral dependence, BD anxiety | "pipeline dried up", "all our business is referrals", "need to fix BD" |
| `ATS_TOOLING_FRUSTRATION` | Named dissatisfaction with ATS/CRM/tooling | "our ATS is fighting us", "evaluating alternatives to X" |
| `FOUNDER_BURNOUT_CAPACITY` | Owner is the bottleneck; cannot scale personally | "wearing every hat", "I am the only one billing" |
| `AGENCY_GROWTH_INTENT` | Actively trying to scale the agency | "hiring our first BD", "opening a second desk" |
| `OUTREACH_METHOD_SEEKING` | Explicitly asking how others generate agency clients | "how are you all finding clients right now?" |
| `MARGIN_PRESSURE` | Rate/fee compression, clients pushing back | "clients cutting fees", "margins are thin" |

**Archetype B — company with hiring need (secondary; only if the ICP targets direct employers)**

| Category | Evidence |
| --- | --- |
| `HIRING_SURGE` | Multiple roles announced, "we're hiring" with volume |
| `TALENT_ACQUISITION_GAP` | Cannot fill a role, struggling with a hard requisition |
| `RECRUITING_CAPACITY_GAP` | No in-house recruiter, or TA team overloaded |

### 7.3 Provider interface (PROPOSED)

Mirror the existing `EngagementAIProvider` shape (`engagement-ai-provider.ts:17-21`):

```
interface BuyingSignalProvider {
  scoreSignal(input: SignalScoreInput): Promise<SignalScoreOutput>;
  readonly providerName: string;
}
```

`SignalScoreInput`: `postText`, `authorName`, `authorHeadline`, `publishedAt`, `targetArchetype`, `enabledCategories`, `promptVersion`.

`SignalScoreOutput` (Zod-validated, mirroring `IcpScoreSchema` discipline at `src/schemas/icp.ts:42-55`):

- `signalScore`: 0-100
- `confidence`: 0-1
- `categories`: array of `{ category, strength: 0-100, evidenceQuote }` where `evidenceQuote` must be a **verbatim substring of `postText`**
- `archetypeDetected`: `A` | `B` | `NONE`
- `reasoning`: string
- `disqualifiers`: string array
- `providerMeta`: `{ provider, model, promptVersion, latencyMs }`

Requirements, following the constitution's AI section:

- Provider-independent interface; a `FakeBuyingSignalProvider` gives deterministic keyword-based scoring for offline tests (pattern: `FakeAIProvider` at `ai-provider.ts:7-53`).
- Configurable model, timeout, bounded retry (max 2 attempts, matching `generateCommentWithRetry` at `engagement-service.ts:332-346`).
- Structured output validated by Zod; invalid output is a scoring **failure**, never a default score. A failed scoring leaves the item `SIGNAL_UNSCORED`, and an unscored item is never presented as low-signal.
- Rate-limit and transient-error classification reusing `isTransientLLMError` (`engagement-service.ts:37-62`).
- Prompt version persisted with every score.
- Data transmitted externally: post text, author name, author headline, publish date. Explicitly **not** transmitted: tenant identifiers, operator identity, other prospects, internal scores, credentials.
- **AI must not override deterministic exclusions.** A post from a prospect who failed `deterministicFilter` is never rescued by a high signal score. The deterministic filter runs first and is final.

### 7.4 Scoring prompt (PROPOSED, version `signal-v1`)

System prompt, structured as explicit instruction blocks:

1. Role: "You classify whether a LinkedIn post shows evidence that its author has a specific business pain. You are a classifier, not a salesperson."
2. Target archetype description, injected per run (A or B, never both in one call).
3. Enabled category list with a one-line definition each.
4. Hard rules:
   - Score only what the post text states or directly implies. Do not infer from the author's job title alone.
   - Every claimed category requires a verbatim quote from the post. No quote means no category.
   - If the post shows no enabled category, return `signalScore: 0`, `archetypeDetected: NONE`, `categories: []`. Zero is a valid and expected answer.
   - Do not treat generic motivational, celebratory, or thought-leadership content as signal.
   - Do not treat a person *offering* recruitment services as a person *needing* RecruitmentOS unless they also express one of the enabled pains.
   - Distinguish first-person pain ("I am struggling") from third-person observation ("the market is struggling"). Third-person commentary scores materially lower.
5. Output contract: JSON only, conforming to the schema; no prose outside JSON.

User prompt: author name, author headline, publish date, and the post text in a delimited block.

Temperature: low (0.1-0.2), matching the existing classification call (`luna-engagement-provider.ts:158` uses 0.2 for `selectBestPosts`) rather than the creative drafting call (0.75 at `:80`).

### 7.5 False-positive filtering

Layered, cheapest first. Every layer is deterministic except layer 3.

**Layer 1 — deterministic pre-filters (before any LLM call)**

| Filter | Rule | Rationale |
| --- | --- | --- |
| Minimum length | reuse `minTextLength` (default 50, `post-filter.ts:30`) | Short posts carry no assessable evidence |
| Recency | reuse `maxAgeDays` (default 7, `post-filter.ts:29`) | Stale pain is not actionable |
| Repost without commentary | discard | Not the author's own statement |
| Promoted/sponsored | discard | Advertising, not pain |
| Self-authored | discard operator's own posts | Obvious |
| Already engaged | discard posts with an existing comment slot | Reuse `accountPostComments` check (`engagement-service.ts:222-232`) |
| Vendor/competitor author | discard authors matching `excludedCompanies` / `hardExclusions` | Reuse `deterministicFilter` (`deterministic-filter.ts:40-57`) |

**Layer 2 — quote grounding (deterministic, post-LLM)**

Every `evidenceQuote` must appear verbatim in `postText` after whitespace normalisation. Any category whose quote fails this check is dropped and the score recomputed from surviving categories. If all categories are dropped, the result becomes `signalScore: 0` with an explicit `HALLUCINATED_EVIDENCE` marker recorded for prompt-quality tracking. This mirrors the grounding discipline of `CommentValidator` (`src/services/engagement/comment-validator.ts`, used at `engagement-service.ts:488`).

**Layer 3 — semantic disqualifiers (LLM-declared, human-auditable)**

The provider returns `disqualifiers`; known patterns to catch:

| Pattern | Why it is a false positive |
| --- | --- |
| Recruiter marketing their own services using pain language | They are selling, not buying |
| Job advertisement text | A req is not a buying signal for Archetype A |
| Industry commentary or news reshare | Not the author's own pain |
| Hiring announcement for a role at the author's own company | Archetype B at most, never A |
| Congratulatory or milestone content | No pain |
| Content marketing by an ATS/tooling vendor | Competitor, not buyer |

**Layer 4 — confidence and threshold gating**

- `signalScore >= signalQualificationThreshold` (PROPOSED default 70) and `confidence >= minimumSignalConfidence` (PROPOSED default 0.6) to count as a qualified signal.
- Between review and qualification thresholds -> operator review.
- Below review threshold -> recorded, not surfaced. Records are kept so prompt precision can be measured over time.

**Layer 5 — human review**

The operator always sees `signalScore`, `categories`, and the verbatim quote before promotion. A signal score never promotes a prospect on its own (subject to Decision D4).

**Measuring precision:** persist every score with its prompt version. After a bounded pilot, the operator labels a sample as true/false positive. That gives a real precision number instead of an assumed one. No precision claim may be made before this labelling exists.

## 8. Domain model

### 8.1 Entities

| Entity | Status | Notes |
| --- | --- | --- |
| `prospects` | EXISTING, unchanged | `src/db/schema.ts:14-27` |
| `icp_definitions` | EXISTING, extended | Add `signalCriteria` to the `criteria` JSON, or a sibling column (Decision D7) |
| `icp_evaluations` | EXISTING, unchanged | `src/db/schema.ts:86-100` |
| `engagement_posts` | EXISTING, extended | New `source_type` enum values (P5) |
| `prospect_discovery_runs` | PROPOSED (new) | One row per operator-initiated run |
| `prospect_discovery_items` | PROPOSED (new) | One row per raw source item with disposition |
| `prospect_signals` | PROPOSED (new) | One row per (prospect, post, prompt version) score |
| `discovery_channel_configs` | PROPOSED (new) | Per-channel enablement and budgets; could be env-only in slice 1 (Decision D8) |

### 8.2 Distinct status dimensions (kept separate)

| Dimension | Values | Owner |
| --- | --- | --- |
| Run status | `CREATED`, `RUNNING`, `COMPLETED`, `PARTIAL`, `FAILED`, `REFUSED`, `RATE_LIMITED` | `prospect_discovery_runs` |
| Item disposition | `ACCEPTED`, `DUPLICATE_IN_RUN`, `DUPLICATE_EXISTING`, `INVALID_URL`, `NON_PROFILE`, `EXTRACTION_INCOMPLETE`, `PRE_FILTERED`, `PARSER_REJECTED`, `PIPELINE_REJECTED` | `prospect_discovery_items` |
| Signal state | `UNSCORED`, `SCORED_QUALIFIED`, `SCORED_REVIEW`, `SCORED_BELOW_THRESHOLD`, `SCORING_FAILED`, `HALLUCINATED_EVIDENCE` | `prospect_signals` |
| ICP fit | existing evaluation status | `icp_evaluations.status` |
| Prospect stage | existing 7-value enum | `prospects.current_stage` |
| Draft status | existing | `engagement_drafts.status` |
| Approval state | existing | `recommendation_approvals.state` |
| Account health | existing | `browser_accounts.health` |

### 8.3 Transitions

Run: `CREATED -> RUNNING -> {COMPLETED | PARTIAL | FAILED | RATE_LIMITED}`; `CREATED -> REFUSED` when a gate rejects before work starts. Terminal states never revert.

Item: `(created with disposition) -> terminal`. Dispositions are assigned once and never mutated; a re-run creates new items.

Signal: `UNSCORED -> {SCORED_* | SCORING_FAILED | HALLUCINATED_EVIDENCE}`. Re-scoring under a new prompt version inserts a new row rather than mutating the old one, preserving prompt-precision history.

### 8.4 Invariants

| # | Invariant |
| --- | --- |
| I1 | One prospect per `(tenant_id, normalized_linkedin_url)` — existing DB index is authoritative. |
| I2 | One post per `(tenant_id, canonical_post_identifier)` — existing DB index is authoritative. |
| I3 | Counts reconcile: `itemsSeen = accepted + duplicatesInRun + duplicatesExisting + invalid + extractionIncomplete + preFiltered + parserRejected`. |
| I4 | A prospect failing `deterministicFilter` is never promoted, regardless of signal score. |
| I5 | Every persisted signal category carries a verbatim quote from the scored post. |
| I6 | Only an explicit operator review action sets `READY_FOR_CAMPAIGN` (subject to D4, and noting conflict X1). |
| I7 | A post persisted by a channel carries that channel's real text; no channel may fabricate post content. |
| I8 | Discovery never writes to `scheduled_actions`, `recommendation_approvals`, or `account_post_comments`. |
| I9 | A failed or partial run never reports its accepted items as qualified without evaluation evidence. |
| I10 | Tenant id and operator id always come from request context, never the request body (existing pattern, `src/server.ts:382-383`). |

## 9. Interfaces and persistence

### 9.1 Channel interface (PROPOSED)

```
interface ProspectSourceChannel {
  readonly channelKey: DiscoveryChannelKey;
  readonly yields: 'PROFILES' | 'POSTS_WITH_AUTHORS';
  validateInput(raw: unknown): ChannelInput;          // Zod
  fetch(input: ChannelInput, budget: ChannelBudget): Promise<RawSourceItem[]>;
}

type RawSourceItem =
  | { kind: 'PROFILE'; profileUrl: string; name?: string; headline?: string; company?: string; location?: string; sourceEvidence: string }
  | { kind: 'POST'; postUrl: string; postText: string; authorName: string; authorProfileUrl: string; publishedAt?: Date; sourceEvidence: string };
```

Optional fields are genuinely optional — absent means absent, never a default literal (correcting `opencli-linkedin-source.ts:7-10`).

`DiscoveryChannelKey`: `PEOPLE_SEARCH` (existing), `POST_URL_LIST`, `FEED_HOME`, `FEED_CREATOR`, `FEED_NETWORK`, `POST_KEYWORD_SEARCH`, plus approved C5 keys.

### 9.2 Orchestrator (PROPOSED)

Extend the existing `ProspectDiscoveryService` dependency-seam pattern (`prospect-discovery-service.ts:26-37`) rather than replacing it: keep `findExisting`, `ingest`, `countStages`, `loadCriteria` as injected functions so offline tests stay possible, and add `scoreSignal`, `persistRun`, `persistItems`.

### 9.3 API contract (PROPOSED, additive)

| Route | Purpose |
| --- | --- |
| `GET /api/discovery/channels` | List channels with enablement, budgets, required inputs |
| `POST /api/discovery/runs` | Start a run: `{ channelKey, input, icpDefinitionId?, budget? }` |
| `GET /api/discovery/runs/:runId` | Run status, reconciled counts, sanitized errors |
| `GET /api/discovery/runs/:runId/items` | Paginated items with dispositions and signal summaries |
| `GET /api/prospects/:id/signals` | Signal history for one prospect |

`POST /api/prospects/discover` (`src/server.ts:380`) stays as-is for backward compatibility with `UploadPanel.tsx:234`; it becomes a thin alias for `channelKey: 'PEOPLE_SEARCH'`.

Error codes extend the existing structured-refusal vocabulary (`structuredRefusal` used throughout `src/server.ts`): `CHANNEL_DISABLED`, `CHANNEL_INPUT_INVALID`, `CHANNEL_BUDGET_EXCEEDED`, `DISCOVERY_ALREADY_RUNNING`, `SIGNAL_PROVIDER_UNAVAILABLE`, `SIGNAL_OUTPUT_INVALID`, `EXTRACTION_INCOMPLETE`, plus the existing `SEARCH_RATE_LIMITED` / `SEARCH_BLOCKED` / `SEARCH_PROVIDER_UNAVAILABLE` (`google-xray-source.ts:15-39`).

### 9.4 Schema changes (PROPOSED, forward-only)

Migration `0008_prospect_discovery_channels`:

1. New enum `discovery_channel_key`.
2. New enum values on `post_source_type` (Postgres `ALTER TYPE ... ADD VALUE`, which cannot run inside a transaction — handle explicitly).
3. `prospect_discovery_runs`, `prospect_discovery_items`, `prospect_signals` with `tenant_id NOT NULL` on each.
4. Indexes: `(tenant_id, created_at)` on runs; `(run_id, disposition)` and unique `(run_id, dedupe_key)` on items; `(tenant_id, prospect_id, scored_at)` on signals.
5. Foreign keys to `prospects`, `engagement_posts`, `icp_definitions`.

Constraints:

- Forward-only. Never rewrite `0000`-`0007` or touch `prospects`.
- Tenant scoping is application-level plus explicit `tenant_id` predicates. **Do not claim RLS** — conflict X5 established that no policies exist in `drizzle/`.
- Test against a clean isolated database (`@electric-sql/pglite` and `pg-mem` are already dev dependencies, `package.json:26,40`).
- Do not store raw HTML, cookies, session data, or credentials. Store bounded `sourceEvidence` text or a hash.

## 10. Failure and safety behaviour

| Failure | Behaviour | Recovery |
| --- | --- | --- |
| OpenCLI binary absent | `CHANNEL_UNAVAILABLE`; run `FAILED`. Reuse `OpenCliUnavailableError` (`opencli-linkedin-source.ts:18-25`). | Operator installs/authenticates; retry. |
| OpenCLI returns no page target | Run `FAILED`, never a successful empty run. Existing precedent at `opencli-linkedin-source.ts:262`. | Retry. |
| LinkedIn session expired / authwall | `SESSION_EXPIRED`; run `FAILED`. Detection precedent: `executors/opencli.ts:206-208`. | Operator re-authenticates (`npm run linkedin:login`). |
| Rate limited / blocked | `RATE_LIMITED` with server-declared backoff; no retry until backoff elapses. Never an empty success. | Operator retries after backoff. |
| Extraction incomplete (no author profile URL) | Item `EXTRACTION_INCOMPLETE`; run continues. Never guess identity. | Operator may supply the profile URL manually. |
| Signal provider timeout / non-JSON / schema violation | Item `SCORING_FAILED`; item still surfaces with `signal: unscored`. Never a default score. | Re-score later. |
| Signal quote fails grounding | Category dropped; if all drop, `HALLUCINATED_EVIDENCE` recorded. | Prompt revision. |
| Pipeline throws mid-run | Run `PARTIAL` with accurate counts. Already-created prospects persist; unprocessed items stay `PENDING`. | Explicit operator resume. |
| Duplicate concurrent run for one channel | `DISCOVERY_ALREADY_RUNNING`; return the active run. | Wait. |
| DB transient error | Reuse `withDbRetry` / `isTransientDbError` (`src/db/retry.ts`, used at `engagement-service.ts:21,380`). | Automatic bounded retry. |
| Run exceeds server timeout | `PARTIAL`, not a false success. No background continuation is claimed — no durable discovery worker exists (D-a). | Operator resumes. |
| Signal scoring cost overrun | Hard per-run cap enforced before scoring begins. | Operator raises budget explicitly. |

Safety boundaries that must remain untouched: approval-before-action, budget, cooldown, kill-switch, lease, working-hours, session-health, and comment-slot uniqueness — all currently enforced at `engagement-service.ts:675-793` and `src/server.ts:126-189`.

## 11. Implementation slices

Each slice is independently testable and independently shippable. No slice depends on a later one.

### Slice 0 — foundation, no new channel

Refresh the GitNexus index. Add `ProspectSourceChannel` and `RawSourceItem` types, `DiscoveryChannelKey` enum, and Zod input schemas. Refactor the existing people-search path to implement the interface **with no behaviour change**. Add `prospect_discovery_runs` and `prospect_discovery_items` plus migration `0008`. Wire run/item persistence into the existing route.
*Testable:* existing discovery tests still pass; runs and items are now persisted with reconciling counts.

### Slice 1 — Channel 2 (post URL list)

`PostByUrlSource` via OpenCLI. URL validation and canonicalisation. Author extraction with genuine optionality. Post persistence with `source_type = 'POST_URL_LIST'`. Route `POST /api/discovery/runs` with `channelKey: 'POST_URL_LIST'`. Minimal UI: textarea, submit, results table.
*Testable:* fixture OpenCLI output produces the expected prospects and posts; malformed URLs are rejected with reasons; duplicate posts and authors are suppressed; a real post reaches `engagement_posts` and no placeholder is generated.

### Slice 2 — buying-signal engine (no new channel)

`BuyingSignalProvider` interface, `FakeBuyingSignalProvider`, `SignalScoreOutput` Zod schema, `prompt signal-v1`, quote-grounding validator, threshold gating, `prospect_signals` table and migration. Apply to Channel 2 posts.
*Testable:* fake provider scoring is deterministic; a fabricated quote is dropped; all-dropped becomes `HALLUCINATED_EVIDENCE`; invalid JSON becomes `SCORING_FAILED` and never a default score; a deterministically excluded prospect is never rescued by a high score.

### Slice 3 — C5-a and C5-b (commenters/reactors)

Comment and reaction list extraction from a seed post URL, with pagination bounds. Same downstream path as Slice 1.
*Testable:* fixture comment lists yield the expected distinct authors; the post author is not double-counted as a commenter; pagination respects the budget.

### Slice 4 — C5-d (second-degree network expansion)

Add a network-degree facet to the existing faceted search URL builder; seed from qualified prospects.
*Testable:* URL builder emits the network facet; already-known prospects are excluded from results.

### Slice 5 — Channel 4 (keyword post search)

**Precondition: resolve U1** — confirm whether OpenCLI can drive LinkedIn post search. If not, this slice is blocked and must be re-planned, not worked around. Then: keyword input, search adapter, deterministic pre-filter, signal scoring, ranked review UI.
*Testable:* fixture search HTML/markdown yields expected posts; pre-filters drop shorts/reposts/promoted/self/already-engaged; scoring cap is enforced; archetype A and B are not conflated.

### Slice 6 — Channel 3 (feed scan)

Three sub-modes behind separate flags. Scroll-depth budget. Reuse Slice 5's pre-filter and scoring. Resolve the `PostFilter` keep-one-per-prospect constraint explicitly (section 6.2 step 3).
*Testable:* fixture feed output; budget respected; own posts excluded; creator mode restricted to configured handles; batch selection does not inherit the prospect-scoped keep-one rule.

### Slice 7 — provenance correction and placeholder removal

Add correct `post_source_type` values (P5). For channels supplying real posts, remove the synthetic-post fallback (P4, pending D6). Backfill or explicitly mark historical rows with the wrong `GOOGLE_XRAY` / `PLAYWRIGHT` provenance.
*Testable:* new posts carry accurate source; no synthetic post is created for a channel-supplied post; existing engagement tests still pass.

## 12. Verification plan

| Layer | Coverage | External access |
| --- | --- | --- |
| Unit: channel input validation | URL list parsing, malformed URLs, size caps, keyword validation, feed-mode validation, budget clamping | None |
| Unit: extraction | Fixture OpenCLI markdown/JSON per channel; missing author URL; missing headline stays empty (not defaulted); non-profile URLs rejected | Fixtures only |
| Unit: dedupe | In-run duplicates, cross-run duplicates, canonical post identity variants, author appearing in multiple channels | None |
| Unit: signal provider | Fake determinism, schema violation, non-JSON, timeout, transient classification, retry cap, quote grounding pass/fail, all-dropped path, threshold routing, archetype separation | Mocked fetch only |
| Unit: pre-filters | Age, length, repost, promoted, self-authored, already-engaged, excluded company | None |
| Integration: pipeline | Channel items reach `PersistentIcpPipeline`; deterministic exclusion precedes AI; no automatic `READY_FOR_CAMPAIGN` (per D4); existing prospects unchanged on re-discovery; signal never overrides exclusion | Fake provider + isolated DB |
| Database | Migration `0008` on clean isolated PGlite/pg-mem; enum `ADD VALUE` outside a transaction; unique constraints; count reconciliation; tenant predicates on every new query | Isolated DB only |
| Concurrency | Two simultaneous runs for one channel; two channels discovering the same prospect; two runs racing on the same post identifier; unique-constraint resolution rather than read-then-write | Isolated DB |
| Integration: routes | Channel list, run start/status/items, validation refusals, budget refusal, disabled-channel refusal, backward compatibility of `POST /api/prospects/discover` | Mocked adapters |
| UI integration | Per-channel input forms, disabled state during a run, reconciled counts, signal display with quote, error/backoff states, no optimistic success | Mocked API |
| Regression: engagement | Readiness still gates scanning; approval still gates action; budget/cooldown/kill-switch/lease unchanged; comment-slot uniqueness holds; channel-supplied posts produce grounded drafts with no placeholder | Fixtures only |
| Regression: existing suites | `tests/gates/*`, `tests/icp/*`, `tests/persistence/*`, `tests/unit/*`, and colocated `src/**/*.test.ts` all pass | None |
| Approved live smoke (separate approval) | One bounded, read-only, operator-observed run per new channel, recording items seen, dispositions, and zero writes | Separate explicit approval per channel |

Commands after each slice: `npm test`, `npm run typecheck`, `npm run build` (`package.json:18,20,12`). Plus `node .gitnexus/run.cjs analyze --index-only` then `detect_changes({scope:'all'})` before any commit, per `AGENTS.md`.

No migration against a shared or production database. Every live-run result is labelled `NOT RUN` until actually performed.

## 13. Completion contract (binary)

Completion is YES only if **every** applicable item passes with the stated evidence. A working UI button, a 200 response, or a successful browser interaction is not evidence.

**Per-slice gates**

| # | Criterion | Required evidence |
| --- | --- | --- |
| C1 | Existing people-search discovery behaves identically after the Slice 0 refactor | TESTED_UNIT + TESTED_DATABASE |
| C2 | Every run persists a `prospect_discovery_runs` row with a terminal status and reconciling counts (I3) | TESTED_DATABASE |
| C3 | Every source item persists an item row with exactly one terminal disposition | TESTED_DATABASE |
| C4 | Channel 2: N valid post URLs produce N posts and their distinct authors as prospects, with real post text | TESTED_UNIT + TESTED_DATABASE |
| C5 | Channel 2: a malformed or non-LinkedIn URL is rejected with an explicit reason and creates no prospect | TESTED_UNIT |
| C6 | Channel 2: an author whose profile URL cannot be extracted yields `EXTRACTION_INCOMPLETE` and no invented identity | TESTED_UNIT |
| C7 | No channel that supplies a real post ever triggers the synthetic-post fallback | TESTED_UNIT |
| C8 | Signal scoring rejects invalid provider output; the item becomes `SCORING_FAILED`, never a default score | TESTED_UNIT |
| C9 | Every persisted signal category quote is a verbatim substring of the scored post text | TESTED_UNIT |
| C10 | A prospect failing `deterministicFilter` is never promoted regardless of signal score (I4) | TESTED_UNIT + TESTED_DATABASE |
| C11 | Archetype A and archetype B are never merged in one scoring call, and archetype is recorded per score | TESTED_UNIT |
| C12 | Signal scoring respects the per-run cap; exceeding it refuses rather than silently truncating | TESTED_UNIT |
| C13 | Cross-channel dedupe: the same person found by two channels yields one prospect and two provenance items | TESTED_DATABASE + TESTED_CONCURRENCY |
| C14 | Concurrent runs on the same post identifier resolve via the DB unique constraint with no duplicate rows | TESTED_CONCURRENCY |
| C15 | Migration `0008` applies to a clean isolated database, including enum `ADD VALUE` handling | TESTED_DATABASE |
| C16 | Every new query carries an explicit `tenant_id` predicate, and a cross-tenant read returns nothing | TESTED_DATABASE |
| C17 | Rate limit, block, session expiry, and provider failure each produce `FAILED`/`PARTIAL`/`RATE_LIMITED`, never an empty success | TESTED_UNIT |
| C18 | A disabled channel refuses with `CHANNEL_DISABLED` and performs no external call | TESTED_UNIT |
| C19 | Discovery writes nothing to `scheduled_actions`, `recommendation_approvals`, or `account_post_comments` (I8) | TESTED_DATABASE |
| C20 | Readiness, approval, budget, cooldown, kill-switch, and lease gates are unchanged | TESTED_UNIT (existing suites green) |
| C21 | `POST /api/prospects/discover` remains compatible with the current `UploadPanel.tsx` caller | TESTED_UNIT |
| C22 | `npm test`, `npm run typecheck`, `npm run build` all pass | recorded command output |
| C23 | GitNexus index refreshed; `detect_changes({scope:'all'})` reviewed with no unresolved HIGH/CRITICAL or `UNKNOWN` risk | recorded tool output |
| C24 | Every live-channel claim is either `VERIFIED_LIVE` with a recorded observed run, or explicitly `NOT RUN` | recorded evidence |

**Explicitly not completion criteria:** buying-signal accuracy or precision (unmeasurable before the labelling exercise in 7.5), reply or conversion rate, and any claim that a channel is permitted by LinkedIn's terms.

## 14. Decisions required

| # | Decision | Options | Recommendation | Trade-off |
| --- | --- | --- | --- | --- |
| D1 | Platform-terms posture for feed scanning (C3) and post keyword search (C4). Both read LinkedIn content at volume through an authenticated session. | (a) Approve both; (b) approve C4 only; (c) approve neither, ship C2 + C5-a/b/d only | **PROPOSED DEFAULT: (c) for the first release.** Rationale: C2 + C5-a/b/d deliver most of the intent-based value with the least account exposure. Trade-off: gives up broad discovery of people outside the operator's network. Configuration point: per-channel feature flag. Approval required. | Account restriction risk vs reach |
| D2 | Buying-signal LLM provider and model. | (a) Reuse codex-everywhere / `gpt-5.6-luna` (already wired, `luna-engagement-provider.ts:14`); (b) Gemini (SDK already present, `package.json:50`); (c) new provider | **PROPOSED DEFAULT: (a)**, since credentials and error handling already exist. Trade-off: couples signal scoring to the same provider as drafting, so one outage degrades both. Configuration point: `SIGNAL_PROVIDER` env var behind the interface. Approval required. | Reuse vs blast-radius isolation |
| D3 | Per-run budgets: max post URLs (C2), max feed items (C3), max search results (C4), max LLM scoring calls per run. | — | **PROPOSED DEFAULT: 25 post URLs, 50 feed items scanned / 20 scored, 25 search results / 25 scored, 25 scoring calls per run, one active run per channel.** Rationale: matches the existing `maxResults` cap of 25 (`src/server.ts:403`). Trade-off: conservative, so large batches need multiple runs. Configuration point: `discovery_channel_configs` or env. Approval required. | Cost and exposure vs throughput |
| D4 | **Conflict X1.** Should discovery auto-promote to `READY_FOR_CAMPAIGN` (current code) or require explicit review (canonical plan)? | (a) Keep auto-promotion for all channels; (b) explicit review for all channels; (c) auto-promote only above both ICP and signal thresholds | **PROPOSED DEFAULT: (b) for all new channels**, and correct the plan document if (a) is intentionally retained for people search. Rationale: `docs/plans/0.7-...md:29` and `:50` state readiness must be explicit; the constitution forbids automatic enrolment policy without approval. Trade-off: more operator clicks. Approval required. | Safety vs operator effort |
| D5 | For C2, is a post persisted before or after its author qualifies? | (a) After the author reaches `EVALUATED` (no orphans); (b) always, with `authorQualified` flag | **PROPOSED DEFAULT: (a)**. Rationale: avoids orphan posts referencing rejected prospects, and `engagement_posts.prospect_id` is `NOT NULL` (`src/db/schema.ts:204`) so (b) needs schema change. Trade-off: a re-qualification requires re-fetching the post. Approval required. | Data cleanliness vs refetch cost |
| D6 | **Conflict X5/X4 remediation scope.** Should this feature also fix the synthetic-post fallback (`engagement-service.ts:255-264`) and the wrong `sourceType` label for the *existing* people-search path? | (a) Fix both now (Slice 7); (b) fix only for new channels; (c) separate plan | **PROPOSED DEFAULT: (a)**. Rationale: leaving a fabricated-post path alive undermines every grounded-comment claim in the product. Trade-off: touches existing engagement behaviour, so regression risk rises. Approval required. | Correctness vs change surface |
| D7 | Where do signal criteria live? | (a) Inside `icp_definitions.criteria` JSON (matches existing `lastDiscoveredPage` pattern at `src/server.ts:543-552`); (b) new column; (c) new table | **PROPOSED DEFAULT: (a)** for slice 2, migrating to (c) if per-channel criteria are needed. Trade-off: JSON criteria are not queryable or schema-validated at the DB layer. Configuration point: `IcpCriteriaSchema` extension. Approval required. | Speed vs queryability |
| D8 | Channel enablement mechanism. | (a) Env flags only, mirroring `FEATURE_05_BROWSER_ENABLED` (`src/server.ts:113`); (b) `discovery_channel_configs` table with UI | **PROPOSED DEFAULT: (a)** for the first release. Trade-off: requires a restart to change, and no per-tenant differentiation. Approval required. | Simplicity vs flexibility |
| D9 | Resolve U1 before committing to C3/C4 schedules: probe OpenCLI's feed and post-search capability. | (a) Probe first, then plan those slices; (b) plan on assumption | **PROPOSED DEFAULT: (a)**. A read-only capability probe is cheap; assuming capability risks a blocked slice mid-implementation. Approval required (the probe itself touches a live LinkedIn session). | Schedule certainty vs one probe |
| D10 | Signal thresholds: `signalQualificationThreshold`, `signalReviewThreshold`, `minimumSignalConfidence`. | — | **PROPOSED DEFAULT: 70 / 40 / 0.6**, mirroring the shape of the existing ICP defaults (80/50/0.7, `src/schemas/icp.ts:21-23`) but slightly looser since signal is advisory rather than gating. Trade-off: looser thresholds surface more false positives for review. Configuration point: ICP criteria. Approval required. | Recall vs review load |

## 15. Risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| RK1 | LinkedIn account restriction from feed/search scanning volume | HIGH | Channel flags default off; strict budgets; D1 gates C3/C4 entirely; no UA/proxy/identity rotation. |
| RK2 | Buying-signal false positives drive irrelevant outreach and damage the operator's reputation | HIGH | Five-layer filtering (7.5); verbatim-quote grounding; human review before promotion; precision measured, never assumed. |
| RK3 | Archetype A/B conflation targets hiring companies instead of recruitment agencies | HIGH | `targetArchetype` required per run; archetype recorded per score; C11 is a completion gate. |
| RK4 | LLM cost blowout from unbounded feed/search scanning | MEDIUM | Deterministic pre-filter before any LLM call; hard per-run scoring cap (D3); refuse rather than truncate. |
| RK5 | LinkedIn DOM/markup drift breaks extraction | MEDIUM | Version parsers; fixture tests per channel; classify unparseable output rather than dropping it silently. |
| RK6 | Four parallel code paths cause dedupe and provenance divergence | MEDIUM | Single channel interface and single orchestrator (P1); Slice 0 refactors the existing path onto it first. |
| RK7 | ADR-003 claims RLS but no policies exist (X5), so new tables inherit only application-level isolation | MEDIUM | Explicit `tenant_id` predicates on every new query; C16 as a completion gate; do not claim RLS anywhere. |
| RK8 | Synthetic-post fallback silently grounds comments in fabricated text (X6) | MEDIUM | P4 forbids it for new channels; D6 decides whether to remove it from the existing path. |
| RK9 | Enum `ALTER TYPE ... ADD VALUE` cannot run inside a transaction and can break migration runs | MEDIUM | Isolate the enum change in its own migration step; test on a clean isolated database (C15). |
| RK10 | GitNexus index 3 commits stale, so impact conclusions may be wrong | LOW | Refresh in Slice 0 before any edit; C23 gate. |
| RK11 | Orphan posts if an author is rejected after post persistence | LOW | D5 default (a) persists the post only after the author reaches `EVALUATED`. |
| RK12 | Long-running runs exceed the HTTP timeout and appear to succeed | LOW | Explicit `PARTIAL` status; no background continuation claimed (D-a deferred). |

## 16. Handoff

**This plan is not approved and must not be implemented.**

After Tushar approves this exact plan and answers D1-D10:

| Step | Agent | Inputs required |
| --- | --- | --- |
| 1 | `coding-builder` | This plan; answers to D1-D10; approved slice scope (recommend Slice 0 alone first); refreshed GitNexus index |
| 2 | `coding-tester` | Slice scope; the verification-plan rows for that slice; the completion-contract rows in scope |
| 3 | `coding-reviewer` | Slice diff; test evidence; `detect_changes({scope:'all'})` output; the in-scope completion-contract rows |
| 4 | this planning agent (`RELEASE_REVIEW` mode) | Delivered evidence vs sections 12 and 13 |

Implementation belongs to `coding-builder`. Verification belongs to `coding-tester` plus `coding-reviewer`. This agent neither implements nor approves its own plan.

Resolve D9 (OpenCLI capability probe) before Slices 5 and 6 are scheduled. Slices 0 through 4 do not depend on it.

---

APPROVAL_STATUS: PENDING_USER_REVIEW

STOP: Review the saved plan with Tushar. Do not implement until Tushar explicitly approves this exact plan.

