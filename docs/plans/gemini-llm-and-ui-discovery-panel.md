# Gemini LLM Provider Wiring + Discovery Panel UI

**Plan ID:** `gemini-llm-and-ui-discovery-panel`
**Mode:** FEATURE_PLANNING
**Active scope:** RecruitmentOS -> sales / operations / product
**Target repository:** `/Users/tusharmangla/Dev/outreach/linkedin-outreach`
**Status:** PROPOSED. Planning only. This document does not authorize application edits, migrations, live LinkedIn reads, provider calls, or any external write.
**Parent plan:** `docs/plans/channels-2-and-4-prospect-discovery.md` (untracked, PENDING_USER_REVIEW). Channel 4 backend was implemented ahead of that plan's approval; see conflict X1.

---

## 1. Mode and scope

Two work packages, each independently usable and independently testable:

- **WP1 — Gemini LLM provider wiring.** Make the two existing OpenAI-compatible LLM providers able to talk to Google AI Studio's OpenAI-compatibility endpoint, and make server boot survive a missing/invalid key instead of crashing.
- **WP2 — Discovery Panel UI.** Give the operator a frontend surface to trigger `POST /api/discovery/content-search`, watch it run, read the results, and promote a discovered prospect with one click.

**In scope:** provider credential/model configuration, boot-time graceful fallback, one new React component, one new sidebar tab, and the tests for all of it.

**Explicitly out of scope (non-goals):** no new backend routes, no schema or migration changes, no changes to the buying-signal classifier's thresholds or grounding rules, no changes to queue/approval/budget/cooldown/kill-switch/lease semantics, no auto-promotion, no new LinkedIn write actions, no streaming responses, no provider retry/backoff redesign beyond what section 8 specifies, no removal of the codex-everywhere provider path.

---

## 2. Decision / intended outcome

Today the operator cannot run content-search discovery at all from the UI, and the AI path is either dead or crashing depending on env state. After this feature ships, the operator opens a Discovery tab, picks a query and a recency window, clicks one button, and sees real qualified prospects with verbatim evidence quotes that they can promote into a campaign — with Gemini doing the buying-signal classification.

---

## 3. Business contract

**User.** Tushar, single operator, single tenant (`SINGLE_USER_TENANT_ID` default `00000000-0000-0000-0000-000000000001`, `src/server.ts:43`).

**Problem.** Channel 4 (post keyword search + AI buying signals) is implemented on the server (`src/server.ts:1064-1097`) but has **zero frontend callers** — `src/components/` contains `DraftCard`, `UploadPanel`, `RolesPanel`, `ExportPanel`, `ProspectCard`, `EngagementReview`, `EngagementPanel` and none of them reference `content-search`, `buying-signals`, `content-insights`, or `promote` (searched: `src/components/**`, terms `content-search|DiscoveryPanel|buying-signals|content-insights|promote` — zero matches). So the capability is only reachable by hand-crafting an HTTP request. Separately, the LLM that scores buying signals is not actually reachable: the operator's `.env` has a typo'd key name, which both disables Gemini-quality scoring and crashes the server on boot.

**Trigger.** Operator opens the Discovery tab and clicks "Run Content Search".

**Inputs.**
- Query: either one preset from `getContentSearchQueryPresets()` (`src/services/discovery/content-search-queries.ts:35-37`, 12 presets: 9 BD + 3 candidate) or a custom free-text string.
- Recency: `past-24h` | `past-week` | `past-month` (`DatePostedWindow`, `content-search-queries.ts:9`).
- Archetype: `AGENCY_LEADERSHIP` | `HIRING_LEADER` (`ProspectArchetype`, `src/types.ts:275`).
- Optional `maxPostsPerQuery`, integer 1..25 (server-validated, `src/server.ts:1074-1077`).

**Workflow.**
1. Operator selects query source (preset dropdown or custom text), recency, archetype.
2. Operator clicks "Run Content Search". Button disables, spinner/status appears.
3. Server drives OpenCLI against the LinkedIn content-search URL, classifies each post, persists qualified signals/insights/prospects/posts.
4. Panel renders the run summary (`postsFound`, `signalsDetected`, `qualified`, `rejected`) and the prospect list.
5. For each prospect: headline/name, profile link, post link, signal score, category, verbatim evidence quote.
6. Operator clicks "Promote to Campaign" on a prospect. The row immediately reflects `READY_FOR_CAMPAIGN`.

**Outputs.** A rendered run summary, a prospect list with evidence, and (on promotion) a persisted stage change plus review decision plus audit event via `promoteProspect` (`src/services/discovery/promotion-service.ts:12-44`).

**Approval points.** Promotion is the human gate and stays human. `ContentSearchChannel` leaves new prospects at `EVALUATED` (`content-search-channel.ts:128-132`) and only `POST /api/prospects/:id/promote` sets `READY_FOR_CAMPAIGN`. This plan adds no automatic promotion and no bulk-promote-all button.

**Independently usable outcome.** WP1 alone: the server boots reliably and buying-signal scoring runs on Gemini rather than a keyword stub. WP2 alone: the operator can run and read a content search without touching curl. Together they make Channel 4 operator-usable end to end.

---

## 4. Requirements

### REQUIRED (explicit user decisions in this request)

| # | Requirement | Evidence level |
| --- | --- | --- |
| R1 | `.env` carries `GEMINI_API_KEY`, `GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`, `GEMINI_MODEL` | REQUIRED |
| R2 | `GEMINI_MODEL` defaults to `gemini-2.5-flash` and is overrideable to `gemini-3.8-flash` | REQUIRED |
| R3 | The Gemini key is used for this repository only | REQUIRED |
| R4 | `LunaEngagementProvider` and `LunaBuyingSignalProvider` read `GEMINI_API_KEY` / `GEMINI_BASE_URL` / `GEMINI_MODEL` when present | REQUIRED |
| R5 | The OpenAI-shaped `/chat/completions` request and `choices[0].message.content` parsing work against Google's OpenAI-compatibility endpoint | REQUIRED |
| R6 | `src/server.ts` instantiates providers with graceful fallback to fake providers when unset, instead of crashing on boot | REQUIRED |
| R7 | New `src/components/DiscoveryPanel.tsx`, integrated into `src/App.tsx` navigation | REQUIRED |
| R8 | Panel exposes preset-or-custom query, recency dropdown, archetype dropdown | REQUIRED |
| R9 | "Run Content Search" button calls `POST /api/discovery/content-search` | REQUIRED |
| R10 | Loading/status indicator while the OpenCLI run is in flight | REQUIRED |
| R11 | Summary displays `postsFound`, `signalsDetected`, `qualified`, `rejected` | REQUIRED |
| R12 | Prospect list shows headline, author, profile link, verified buying-signal evidence quote | REQUIRED |
| R13 | One-click "Promote to Campaign" calling `POST /api/prospects/:id/promote`, with immediate UI update | REQUIRED |

### PROPOSED (need Tushar's approval — see section 12)

| # | Proposal | Format |
| --- | --- | --- |
| P1 | Rotate the leaked Gemini key | PROPOSED DEFAULT: rotate before merge \| the key was transmitted in a chat prompt and this plan is a tracked file, so it must be treated as compromised \| trade-off: one manual step in Google AI Studio \| configuration point: `.env` `GEMINI_API_KEY` \| approval required |
| P2 | Provider selection precedence | PROPOSED DEFAULT: `GEMINI_API_KEY` > `CODEX_EVERYWHERE_API_KEY` > fake \| Gemini is the key the user just supplied, so it should win; codex-everywhere stays as a fallback rather than being deleted \| trade-off: a stale codex key silently loses priority \| configuration point: `buildEngagementService()` / `buildContentSearchChannel()` in `src/server.ts` \| approval required |
| P3 | Default model | PROPOSED DEFAULT: `gemini-2.5-flash` \| the user named it first and it is a broadly available stable id; `gemini-3.8-flash` appears in current Gemini OpenAI-compat docs but I have not verified this key's access to it \| trade-off: possibly not the newest model \| configuration point: `GEMINI_MODEL` \| approval required |
| P4 | Timeout | PROPOSED DEFAULT: keep the existing 30s `TIMEOUT_MS` and make it env-overrideable via `GEMINI_TIMEOUT_MS` \| 30s already ships in both providers \| trade-off: long tail requests still abort \| configuration point: `GEMINI_TIMEOUT_MS` \| approval required |
| P5 | Retries | PROPOSED DEFAULT: zero automatic retries for `scoreSignal`; classifier already routes failure to `SCORING_FAILED` \| retrying a scoring call multiplies cost and can mask systematic prompt failure \| trade-off: a single transient 429 rejects one post \| configuration point: `GEMINI_MAX_RETRIES`, default `0` \| approval required |
| P6 | `providerName` union | PROPOSED DEFAULT: widen `'luna' \| 'fake'` to `'luna' \| 'gemini' \| 'fake'` so persisted provider metadata is truthful \| calling a Gemini call "luna" makes audit data wrong \| trade-off: touches `BuyingSignalProvider`, `EngagementAIProvider`, `BuyingSignalClassification.provider` and their tests \| configuration point: `src/services/discovery/buying-signal-classifier.ts:127,211`, `src/services/engagement/engagement-ai-provider.ts:20` \| approval required |
| P7 | Polling vs single request | PROPOSED DEFAULT: single awaited `fetch` with no client timeout, plus an explicit warning that a 12-preset default run can take minutes \| the route is synchronous and there is no run-status endpoint to poll \| trade-off: a closed tab loses the result view (the data is still persisted) \| configuration point: panel defaults to exactly one query \| approval required |
| P8 | Frontend test tooling | PROPOSED DEFAULT: extract the panel's pure logic into a testable module and unit-test that; do not add jsdom/@testing-library \| the repo has `environment: 'node'` (`vitest.config.ts:8`) and zero `.test.tsx` files, so adding a DOM test stack is a new dependency decision \| trade-off: no render-level assertions \| configuration point: `vitest.config.ts` \| approval required |
| P9 | "Headline" field source | PROPOSED DEFAULT: render `signalCategory` + `whatTheyNeed` as the headline line, and label it as such \| `QualifiedProspectResult` (`content-search-channel.ts:41-50`) has no `headline` field and the runner never extracts one (`ContentSearchPost`, `content-search-channel.ts:12-19`) \| trade-off: not a LinkedIn profile headline \| configuration point: `DiscoveryPanel` render \| approval required |

### DEFERRED

- Fixing the `post_source_type` enum gap (X3) — separate plan.
- Adding a run-status/history endpoint so the panel can survive a page reload.
- Gemini structured output via `response_format` json_schema (current code parses JSON out of free text; Gemini's OpenAI-compat layer supports `response_format` but adopting it is a prompt-contract change).
- Query-stats and blacklist panels from the parent plan (`GET /api/discovery/query-stats`, `GET/PUT /api/discovery/blacklist` — neither route exists).

---

## 5. Current-state evidence

**EVIDENCE_GATE: PASS.** Working directory `/Users/tusharmangla/Dev/outreach/linkedin-outreach` inspected. `git status --short` and `git log --oneline -8` read. Files read in full or in part: `package.json`, `.env`, `.gitignore`, `index.html`, `vite.config.ts`, `vitest.config.ts`, `src/server.ts` (all 1415 lines), `src/App.tsx` (all 652 lines), `src/components/EngagementPanel.tsx`, `src/components/UploadPanel.tsx` (partial), `src/services/engagement/luna-engagement-provider.ts`, `src/services/discovery/luna-buying-signal-provider.ts`, `src/services/discovery/buying-signal-classifier.ts`, `src/services/discovery/content-search-channel.ts`, `src/services/discovery/content-search-queries.ts`, `src/services/discovery/opencli-content-search-runner.ts`, `src/services/discovery/promotion-service.ts`, `src/services/icp/gemini-evaluator.ts`, `src/services/engagement/engagement-ai-provider.ts`, `src/types.ts:255-314`, `src/services/discovery/content-search-channel.test.ts` (partial), `docs/plans/channels-2-and-4-prospect-discovery.md`. Directory listings taken for `src/`, `tests/`, `docs/plans/`, `~/.config/opencode/agency-os/projects/`. Repository-wide greps recorded in the MISSING rows below.

### 5.1 Existing

| # | Fact | Evidence | Level |
| --- | --- | --- | --- |
| E1 | `POST /api/discovery/content-search` exists and validates `queries` (max 5), `maxPostsPerQuery` (int 1..25), `recency` (3 values), `archetype` (2 values); refuses with `DISCOVERY_INVALID`, fails with `DISCOVERY_FAILED` | `src/server.ts:1064-1097` | IMPLEMENTED |
| E2 | `POST /api/prospects/:id/promote` exists, takes optional `reason`, returns 404 `PROSPECT_NOT_FOUND` / 500 `PROMOTION_FAILED` | `src/server.ts:1121-1135` | IMPLEMENTED |
| E3 | `GET /api/discovery/content-insights` and `GET /api/discovery/buying-signals` exist | `src/server.ts:1099-1119` | IMPLEMENTED |
| E4 | `buildContentSearchChannel()` already selects `LunaBuyingSignalProvider` when `CODEX_EVERYWHERE_API_KEY` is set, else `FakeBuyingSignalProvider` | `src/server.ts:1050-1062` | IMPLEMENTED |
| E5 | Both providers already speak OpenAI `/chat/completions` with `Authorization: Bearer`, `messages`, `temperature`, `max_tokens`, and parse `data.choices[0].message.content` | `luna-engagement-provider.ts:61-104`, `luna-buying-signal-provider.ts:78-119` | IMPLEMENTED |
| E6 | Both providers already accept constructor overrides `{ apiKey, baseUrl }` | `luna-engagement-provider.ts:23-33`, `luna-buying-signal-provider.ts:40-50` | IMPLEMENTED |
| E7 | `MODEL` is a module-level `const 'gpt-5.6-luna'` in both files — not injectable | `luna-engagement-provider.ts:14`, `luna-buying-signal-provider.ts:18` | IMPLEMENTED |
| E8 | `parseSignalOutput` strips ``` fences and validates score/confidence/category/urgency, throwing on invalid output | `luna-buying-signal-provider.ts:137-185` | IMPLEMENTED |
| E9 | Classifier catches provider throw and returns `status: 'SCORING_FAILED'` with score 0 — never a default score | `buying-signal-classifier.ts:278-293` | IMPLEMENTED |
| E10 | Ungrounded quotes are capped at 39, below the 70 qualification threshold | `buying-signal-classifier.ts:9-12,296-305` | IMPLEMENTED |
| E11 | `ContentSearchRunResult` provides exactly the four summary counters the UI needs plus `prospects[]` | `content-search-channel.ts:52-61` | IMPLEMENTED |
| E12 | `QualifiedProspectResult` carries `prospectId, name, linkedinUrl, stage, signalScore, signalCategory, evidenceQuote, postUrl` | `content-search-channel.ts:41-50` | IMPLEMENTED |
| E13 | `App.tsx` tab state is a 5-value union `'roles'\|'upload'\|'pipeline'\|'export'\|'engagement'`, mirrored in `UploadPanel`'s `setActiveTab` prop type | `src/App.tsx:26`, `src/components/UploadPanel.tsx:10` | IMPLEMENTED |
| E14 | Panels are plain function components taking `setStatusMessage` and refresh callbacks; styling is inline + class names, no CSS module or UI library | `EngagementPanel.tsx:1-137` | IMPLEMENTED |
| E15 | Vite proxies `/api` and `/health` to the backend port read from `.server-port` | `vite.config.ts:24-29` | IMPLEMENTED |
| E16 | `@google/generative-ai@^0.15.0` is already a dependency, used by `GeminiEvaluator` for the ICP path (native SDK, not OpenAI-compat) | `package.json:50`, `src/services/icp/gemini-evaluator.ts:1-27` | IMPLEMENTED |
| E17 | `GEMINI_API_KEY` is already an established env name, read by `GeminiEvaluator` | `gemini-evaluator.ts:19`, `.env:3` | IMPLEMENTED |
| E18 | Channel-4 offline tests exist and pass a `FakeBuyingSignalProvider` through `MemoryStorage` | `src/services/discovery/content-search-channel.test.ts:26-60` | TESTED_UNIT |
| E19 | Google's OpenAI-compatibility endpoint is `https://generativelanguage.googleapis.com/v1beta/openai/`, accepts `Authorization: Bearer <key>` on `POST /chat/completions` with `model` + `messages`, and returns `choices[0].message` | Context7 `/websites/ai_google_dev_gemini-api`, source `https://ai.google.dev/gemini-api/docs/openai` | DOCUMENTED |
| E20 | `gemini-3.8-flash` is the model id used throughout current Gemini OpenAI-compat docs examples | same source | DOCUMENTED |

### 5.2 Missing

Every row records the searched roots and the search term.

| # | Missing | Searched roots | Term / pattern |
| --- | --- | --- | --- |
| M1 | No frontend caller for content search, promotion, buying signals, or insights | `src/components/**` | `content-search\|DiscoveryPanel\|buying-signals\|content-insights\|promote` → zero matches |
| M2 | No `DiscoveryPanel.tsx` | `src/**/*.{ts,tsx}` glob (100 files enumerated) | filename `DiscoveryPanel.tsx` → absent |
| M3 | No `GEMINI_BASE_URL` or `GEMINI_MODEL` anywhere | whole repo, `*.ts`; plus `.env` | `GEMINI` → only `GEMINI_API_KEY` at `gemini-evaluator.ts:19,21` and `.env:3` |
| M4 | No provider test for either Luna provider | `src/**`, `tests/**` | `luna\|Luna` in `tests/` → zero matches; no `luna-*.test.ts` in the 100-file glob |
| M5 | No frontend/component test of any kind | `src/**`, `tests/**` | zero `*.test.tsx` files in the glob; `vitest.config.ts:8` sets `environment: 'node'` |
| M6 | No DOM test tooling installed | `package.json` | `jsdom\|@testing-library\|happy-dom` → matches only inside `package-lock.json` as transitive vitest peer hints, not as declared deps |
| M7 | No run-status or run-history endpoint for content search | `src/server.ts` | `/api/discovery/` → only `content-search`, `content-insights`, `buying-signals` |
| M8 | No `query-stats` or `blacklist` route despite the parent plan specifying them | `src/server.ts` | `query-stats\|blacklist` → absent |
| M9 | Agency OS RecruitmentOS memory documents contain no Channel-4/Gemini/LLM-provider state | `~/.config/opencode/agency-os/projects/recruitmentos/` (`ARCHITECTURE.md`, `STATE-MEMORY-ACTIONS.md`) | `Gemini\|Channel 4\|content.search\|buying.signal\|LLM` → zero matches |

### 5.3 Conflicting

| # | Conflict | Evidence | Consequence |
| --- | --- | --- | --- |
| **X1** | **`.env:9` reads `CODEX_EVERYWHERE_API_KE=` — the trailing `Y` is missing.** So `process.env.CODEX_EVERYWHERE_API_KEY` is `undefined`. `buildEngagementService()` calls `new LunaEngagementProvider()` unconditionally at module scope (`server.ts:96-108`), and that constructor throws when the key is empty (`luna-engagement-provider.ts:27-32`). The comment at `server.ts:93` claims a fake-provider fallback that the code does not implement. | `.env:9`; `src/server.ts:93,96-97,108`; `luna-engagement-provider.ts:27-32` | **The server currently cannot boot as configured.** Meanwhile `buildContentSearchChannel()` does branch correctly (`server.ts:1052-1054`), so content search would silently run on `FakeBuyingSignalProvider` — keyword stub scoring, not AI. This is exactly what R6 asks to fix, and it must be fixed before the UI is worth building. |
| **X2** | Channel 4 backend is fully implemented and shipped as untracked files, but its governing plan is still `PENDING_USER_REVIEW` and states "This plan is not approved and must not be implemented." Decision D2 in that plan recommends the codex-everywhere provider; this request overrides it with Gemini. | `docs/plans/channels-2-and-4-prospect-discovery.md:7,405,426-445`; `git status --short` showing `?? src/services/discovery/content-search-channel.ts` etc. | Treat the shipped implementation as the source of truth for interfaces (precedence rule 7 over rule 6), and record the Gemini choice as the latest explicit user decision (precedence rule 1) superseding D2. |
| **X3** | `ContentSearchChannel` writes `sourceType: 'POST_KEYWORD_SEARCH'` (`content-search-channel.ts:143`), but the parent plan's evidence F2 records the `post_source_type` enum as `['PLAYWRIGHT','FIXTURE','MANUAL']` and migration `0009` is untracked/unverified against the live DB. | `content-search-channel.ts:143`; parent plan F2 line 65; `git status` showing `?? drizzle/0008_...sql`, `?? drizzle/0009_...sql`, ` M drizzle/meta/_journal.json` | A live run may fail at insert time with an enum violation. **This is a WP2 blocker for `TESTED_DATABASE` and live evidence** and must be checked before the UI is called "working". Not fixed by this plan (DEFERRED). |
| X4 | The panel's required "headline" field has no source in the data contract. | `content-search-channel.ts:12-19,41-50` | Resolved by P9, not by inventing a field. |
| X5 | The parent plan's Channel-4 design specifies deterministic gates (job-ad markers, recency, repost, promoted, self-authored, already-engaged) that the shipped `runNegativeGate` does not implement — it covers job-seeker markers and company blacklist only. | parent plan 6.4 table; `buying-signal-classifier.ts:51-67` | Not this plan's scope. Do not describe the shipped gate as complete. |

### 5.4 Unknown

| # | Unknown | Why it matters | How to resolve |
| --- | --- | --- | --- |
| U1 | Whether the supplied key grants access to `gemini-2.5-flash` and/or `gemini-3.8-flash` | Determines P3 | `GET {GEMINI_BASE_URL}models` with the Bearer key; requires approval for a live call |
| U2 | Whether Gemini's OpenAI-compat layer honours `max_tokens: 300` well enough for `parseSignalOutput` to receive complete JSON, and whether it emits ``` fences | A truncated or fenced body means `SCORING_FAILED` on every post | Approved live smoke test against one fixture post |
| U3 | Whether migration `0008`/`0009` are actually applied to the Neon database in `.env:2` | Gates X3 and every live claim | Inspect applied migrations on an isolated copy — never write to the shared Neon DB to find out |
| U4 | Whether `opencli` is installed and the LinkedIn session is live | The panel cannot produce results without it; `OpenCliContentSearchRunner` throws `OPENCLI_NO_PAGE_TARGET` | Read-only probe, operator-observed |
| U5 | Real-world duration of a content-search run | Drives P7 and the UX warning copy | Measure during the approved smoke test |
| U6 | Whether the leaked Gemini key has already been used elsewhere | Security | Google AI Studio usage view |

---

## 6. Domain model

No new entities, no new statuses, no new transitions. This feature reads and renders existing ones.

**Entities touched (all existing):** `Prospect` (`src/types.ts:30`), `ProspectBuyingSignal` (`types.ts:277-291`), `MarketContentInsight` (`types.ts:293-304`), `DiscoveryQueryStat` (`types.ts:306-314`), `EngagementPost`.

**Separate state dimensions — must not be collapsed in the UI:**

| Dimension | Values | Owner |
| --- | --- | --- |
| Signal classification status | `QUALIFIED` \| `REVIEW` \| `BELOW_THRESHOLD` \| `REJECTED` \| `SCORING_FAILED` | `buying-signal-classifier.ts:197` |
| Quote grounding | `grounded: boolean`, independent of score | `buying-signal-classifier.ts:296` |
| Prospect stage | `EVALUATED` after a run; `READY_FOR_CAMPAIGN` only after promotion | `content-search-channel.ts:128-132`; `promotion-service.ts:22` |
| Provider identity | `gemini` \| `luna` \| `fake` (P6) | provider `providerName` |
| Run outcome | `postsFound` / `signalsDetected` / `qualified` / `rejected` | `content-search-channel.ts:52-61` |

**Invariants this feature must not break.**
- I1. A qualified signal is not an approved prospect. The UI must not label `EVALUATED` as ready, approved, or safe to contact.
- I2. `rejected` counts posts dropped by the negative gate **and** posts below threshold **and** scoring failures (`content-search-channel.ts:106-109` treats all non-`QUALIFIED` alike). The UI must label it "not qualified", not "rejected by AI".
- I3. Tenant and operator identity come only from request context (`server.ts:49-59`); the panel never sends them.
- I4. Promotion is per-prospect and explicit.

---

## 7. Interfaces and persistence

### 7.1 Backend contracts consumed (no changes)

`POST /api/discovery/content-search` — request `{ queries?: string[] (≤5), recency?: 'past-24h'|'past-week'|'past-month', archetype?: 'AGENCY_LEADERSHIP'|'HIRING_LEADER', maxPostsPerQuery?: 1..25 }`; response `201 { status: 'completed', queries, recency, archetype, postsFound, signalsDetected, qualified, rejected, prospects: QualifiedProspectResult[], correlationId }`; errors `400 DISCOVERY_INVALID`, `500 DISCOVERY_FAILED`. (`server.ts:1064-1097`)

`POST /api/prospects/:id/promote` — request `{ reason?: string }`; response `200 { prospectId, currentStage: 'READY_FOR_CAMPAIGN', correlationId }`; errors `404 PROSPECT_NOT_FOUND`, `500 PROMOTION_FAILED`. (`server.ts:1121-1135`)

### 7.2 Provider contract changes (WP1)

Both provider constructors widen to `{ apiKey?, baseUrl?, model?, timeoutMs? }`, and `MODEL` (E7) becomes an instance field. Resolution order per field:

```
apiKey   := opts.apiKey   ?? GEMINI_API_KEY ?? CODEX_EVERYWHERE_API_KEY ?? ''
baseUrl  := opts.baseUrl  ?? (GEMINI_API_KEY ? GEMINI_BASE_URL ?? GOOGLE_OPENAI_DEFAULT : CODEX_EVERYWHERE_BASE_URL ?? CODEX_DEFAULT)
model    := opts.model    ?? (GEMINI_API_KEY ? GEMINI_MODEL ?? 'gemini-2.5-flash' : 'gpt-5.6-luna')
```

Base URL join must stay `baseUrl.replace(/\/+$/,'') + '/chat/completions'` so the trailing slash in R1's value is harmless (already the shape at `luna-engagement-provider.ts:61`).

`providerMeta` must report the real provider and model, replacing the hardcoded `{ model: MODEL, provider: 'codex-everywhere' }` at `luna-engagement-provider.ts:120`.

Per P6, `providerName` widens to `'luna' | 'gemini' | 'fake'` in `engagement-ai-provider.ts:20`, `buying-signal-classifier.ts:127`, and `BuyingSignalClassification.provider` (`buying-signal-classifier.ts:211`).

### 7.3 Boot-time factory changes (WP1, R6)

`buildEngagementService()` (`server.ts:96-106`) gains the same guarded shape `buildContentSearchChannel()` already has: construct the HTTP provider only when a key is present, wrap construction in try/catch, log which provider was selected, and fall back to a fake engagement provider otherwise. This requires a `FakeEngagementProvider` — one does not exist for the engagement path (`FakeAIProvider` at `src/services/icp/ai-provider.ts:7` implements `ICPModelProvider`, a different interface). Adding it is part of WP1 slice 3.

`buildContentSearchChannel()` (`server.ts:1050-1062`) changes its condition from `CODEX_EVERYWHERE_API_KEY` to "either key present", per P2.

### 7.4 Frontend contract (WP2)

New `src/components/DiscoveryPanel.tsx`, props mirroring existing panels:

```ts
interface DiscoveryPanelProps {
  setStatusMessage: (msg: string) => void;
  refreshProspects: (cId?: string) => Promise<void>;
  refreshCampaigns: () => Promise<void>;
}
```

`src/App.tsx` changes: extend the tab union at line 26 to include `'discovery'`, add one `nav-item` button, render `<DiscoveryPanel .../>`. The identical union in `UploadPanel.tsx:10` must be widened in the same commit or `npm run typecheck` fails.

Per P8, pure logic lives in a sibling module `src/components/discovery-panel-logic.ts` (request-body builder, response normalizer, promotion state reducer) so it is unit-testable under `environment: 'node'`.

### 7.5 Persistence

No schema change, no migration, no new table, no new index. Tenant isolation is unchanged because no new query is introduced.

### 7.6 Secret handling

`.env` is gitignored (`.gitignore:4`), so R1's values stay out of version control. The plan file and any test fixture must reference `GEMINI_API_KEY` by name only — never the literal value. P1 (rotation) applies because the literal was transmitted in a prompt.

---

## 8. Failure and safety behaviour

| Condition | Required behaviour | Where |
| --- | --- | --- |
| No `GEMINI_API_KEY` and no `CODEX_EVERYWHERE_API_KEY` | Server boots. Both factories select fake providers and log the selection explicitly. No throw. | `server.ts` factories |
| Key present but provider constructor throws | Catch, log the reason, fall back to fake, continue booting | `server.ts` factories |
| Gemini returns non-2xx | Surface `Gemini API error (HTTP <status>): <message>` — existing shape at `luna-buying-signal-provider.ts:110-113` | provider |
| Gemini returns non-JSON or fenced JSON | `parseSignalOutput` fence-strip then throw on invalid (`:137-147`); classifier maps to `SCORING_FAILED` | provider + classifier |
| Gemini returns a fabricated quote | Grounding check caps score at 39, so it cannot qualify | `buying-signal-classifier.ts:296-300` |
| Request exceeds timeout | `AbortController` aborts; error names the timeout (`:120-124`) | provider |
| Fake provider active | The panel must display which provider scored the run, so a stub run is never mistaken for AI scoring. This requires the provider name to be visible; the current response does not expose it — see D5. | UI + response |
| `POST /api/discovery/content-search` returns 400 | Render the `DISCOVERY_INVALID` message verbatim; do not retry | panel |
| Returns 500 `DISCOVERY_FAILED` | Render the message and `correlationId`; do not claim partial success | panel |
| OpenCLI unavailable / session expired | Arrives as `DISCOVERY_FAILED`; the panel must not present zero results as "no prospects found" | panel |
| Fetch rejects (server down) | Explicit "cannot reach server" state, matching `App.tsx:181-183` | panel |
| Promotion 404 | Show not-found; leave the row un-promoted | panel |
| Promotion 500 | Show failure; leave the row un-promoted. **No optimistic promotion:** update the row only after a 200. | panel |
| Double-click on Run or Promote | Disable the control while in flight; no duplicate request | panel |
| Run in progress | Inputs disabled, spinner visible, and a warning that closing the tab loses the view but not the data | panel |

Safety notes carried forward: this feature performs **no** LinkedIn write. Content search is a read. Promotion writes only prospect stage, a review decision, and an audit event (`promotion-service.ts:22-36`). Queue, approval, budget, cooldown, kill-switch, and lease paths are untouched.

---

## 9. Implementation slices

Ordered by dependency. Each is independently testable. **Slice 1 must land first — the server does not boot without it.**

### WP1

**Slice 1 — Restore bootability (smallest possible fix).**
Correct `.env:9` `CODEX_EVERYWHERE_API_KE` → `CODEX_EVERYWHERE_API_KEY`, or remove the line, and add R1's three `GEMINI_*` variables.
*Testable:* `npm run api:dev` starts and `GET /health` returns `{status:'ok'}`. This is currently impossible (X1).

**Slice 2 — Provider configurability.**
Widen both provider constructors to `{ apiKey, baseUrl, model, timeoutMs }`; make `MODEL` an instance field; implement section 7.2 resolution; fix `providerMeta`; widen `providerName` per P6; update comment headers naming the env vars.
*Testable:* injected-fetch unit tests assert endpoint, `Authorization` header, and `model` in the body for a Gemini config, a codex config, and a constructor-override config — no network.

**Slice 3 — Graceful boot fallback.**
Add `FakeEngagementProvider` implementing `EngagementAIProvider`. Guard `buildEngagementService()`; update `buildContentSearchChannel()` to P2 precedence; log the selected provider once at boot; delete the now-false comment at `server.ts:93`.
*Testable:* factory unit tests across all four env permutations (both keys, Gemini only, codex only, neither) assert the selected provider name and that no throw escapes.

### WP2

**Slice 4 — Panel logic module.**
`src/components/discovery-panel-logic.ts`: request-body builder (omit empty fields, clamp `maxPostsPerQuery` to 1..25, trim custom query, refuse >5 queries), response normalizer, promotion-state reducer.
*Testable:* pure unit tests under `environment: 'node'`.

**Slice 5 — DiscoveryPanel component.**
Render form (preset dropdown from `getContentSearchQueryPresets()`, custom input, recency, archetype), Run button with disabled/loading state, summary tiles for the four counters, prospect list with name, profile link, post link, score, category, evidence quote, and per-row Promote button. Wire `refreshProspects` / `refreshCampaigns` after a successful promotion.
*Testable:* logic covered by slice 4; render verified by operator walkthrough plus `npm run build`.

**Slice 6 — App integration.**
Extend the tab union in `App.tsx:26` and `UploadPanel.tsx:10`; add the nav button; render the panel.
*Testable:* `npm run typecheck` and `npm run build` pass; existing tabs still render.

**Slice 7 — Evidence run (requires separate approval).**
Resolve U3/X3 (migrations) and U4 (OpenCLI/session) first. Then one bounded operator-observed run with `maxPostsPerQuery: 1` and exactly one query, followed by one promotion.
*Testable:* recorded output; until performed, every live claim stays `NOT RUN`.

---

## 10. Verification plan

| Layer | Coverage | External access |
| --- | --- | --- |
| Unit — provider config | Endpoint built from `GEMINI_BASE_URL` with and without trailing slash; Bearer header; `model` from `GEMINI_MODEL`; default `gemini-2.5-flash`; override to `gemini-3.8-flash`; constructor args beat env; codex path unchanged when only the codex key is set | Injected fake fetch only |
| Unit — provider parsing | `choices[0].message.content` extracted; fenced JSON stripped; empty content throws; non-JSON throws; HTTP error message surfaced; abort produces a timeout error | Injected fake fetch only |
| Unit — `parseSignalOutput` | Out-of-range `signalScore`/`confidence`, unknown `signalCategory`, bad `urgency` each throw (regression on `:153-168`) | None |
| Unit — classifier integration | Provider throw → `SCORING_FAILED` with score 0; fabricated quote capped at 39 and never `QUALIFIED` | None |
| Unit — boot factories | Four env permutations select the right provider and never throw | None |
| Unit — panel logic | Body builder omits empties, clamps `maxPostsPerQuery`, trims custom query, refuses >5 queries; normalizer tolerates a missing `prospects` array; reducer promotes only the targeted row and only on success | None |
| Regression | `npm test` across `tests/gates/*`, `tests/icp/*`, `tests/persistence/*`, `tests/unit/*`, and colocated `src/**/*.test.ts` — with attention to `content-search-channel.test.ts` and any test asserting `providerName` (P6 widening) | None |
| Build | `npm run typecheck` and `npm run build` | None |
| Database | **Cannot be claimed from this plan.** X3/U3 must be resolved on an isolated PGlite/pg-mem database first. Never run a migration against the Neon URL in `.env:2` to find out. | Isolated DB only |
| Live Gemini | Approved single call to resolve U1/U2: list models, then one `scoreSignal` against a fixture post | Separate explicit approval |
| Live E2E | Approved single content-search run + one promotion (slice 7) | Separate explicit approval |

Commands: `npm test`, `npm run typecheck`, `npm run build` (`package.json:18,20,12`). Per `AGENTS.md`, run `node .gitnexus/run.cjs analyze --index-only` then `detect_changes({scope:'all'})` before any commit, and run `impact()` before editing any shared symbol — `providerName` (P6) is exactly such a symbol.

---

## 11. Completion contract

Binary. A rendered button, a 201 response, or a green build is not evidence of the claim next to it.

| # | Criterion | Required evidence |
| --- | --- | --- |
| C1 | `npm run api:dev` boots and `/health` returns ok with **no** LLM key set | recorded command output |
| C2 | Boot succeeds with only `GEMINI_API_KEY` set | recorded command output |
| C3 | Boot succeeds with only `CODEX_EVERYWHERE_API_KEY` set | recorded command output |
| C4 | No code path constructs an HTTP LLM provider at module scope without a guard | IMPLEMENTED + TESTED_UNIT |
| C5 | Both providers send `model` from `GEMINI_MODEL`, defaulting to `gemini-2.5-flash` | TESTED_UNIT |
| C6 | `GEMINI_MODEL=gemini-3.8-flash` is honoured | TESTED_UNIT |
| C7 | Endpoint is `<GEMINI_BASE_URL>/chat/completions` with no double slash, trailing slash present or absent | TESTED_UNIT |
| C8 | `Authorization: Bearer <GEMINI_API_KEY>` sent; key never logged | TESTED_UNIT + code read |
| C9 | `providerMeta` records the actual provider and model, not the hardcoded `codex-everywhere` | TESTED_UNIT |
| C10 | Invalid Gemini output yields `SCORING_FAILED`, never a default score | TESTED_UNIT |
| C11 | Ungrounded quote capped at ≤39 and cannot reach `QUALIFIED` | TESTED_UNIT |
| C12 | Discovery tab reachable; existing five tabs unaffected | operator walkthrough + `npm run build` |
| C13 | Panel offers all 12 presets plus a custom query, three recency values, two archetypes | TESTED_UNIT (logic) + walkthrough |
| C14 | Run button issues exactly one `POST /api/discovery/content-search` and is disabled while in flight | TESTED_UNIT (logic) + walkthrough |
| C15 | Summary renders `postsFound`, `signalsDetected`, `qualified`, `rejected` from the response, unmodified | TESTED_UNIT (logic) |
| C16 | Each prospect row shows name, profile link, post link, score, category, and the verbatim `evidenceQuote` | TESTED_UNIT (logic) |
| C17 | Promote issues `POST /api/prospects/:id/promote` for that prospect only, and the row updates only after a 200 | TESTED_UNIT (logic) |
| C18 | Promotion failure leaves the row un-promoted with the error shown | TESTED_UNIT (logic) |
| C19 | The UI never labels an `EVALUATED` prospect as approved, ready, verified, or safe to contact (I1) | code read + walkthrough |
| C20 | `rejected` is labelled "not qualified", covering gate rejections, below-threshold, and scoring failures (I2) | code read |
| C21 | The panel discloses which provider scored the run, so fake-provider runs are unmistakable | IMPLEMENTED (needs D5) |
| C22 | No new backend route, table, column, or migration introduced | `git diff` review |
| C23 | Queue, approval, budget, cooldown, kill-switch, lease behaviour unchanged | existing suites green |
| C24 | No auto-promotion anywhere in the new code | code read + TESTED_UNIT |
| C25 | `npm test`, `npm run typecheck`, `npm run build` all pass | recorded output |
| C26 | GitNexus index refreshed; `detect_changes({scope:'all'})` reviewed with no unresolved HIGH/CRITICAL and no unexamined `UNKNOWN` | recorded tool output |
| C27 | The Gemini API key appears in no tracked file, no log, no test fixture, and no error message | repo-wide grep of the literal |
| C28 | Leaked key rotated (P1) | Tushar's confirmation |
| C29 | Gemini live reachability (U1/U2) is either `VERIFIED_LIVE` with recorded output or explicitly `NOT RUN` | recorded evidence |
| C30 | X3 (`post_source_type` enum) resolved on an isolated DB, or the live-run claim is explicitly `NOT RUN` | TESTED_DATABASE or `NOT RUN` |

**Explicitly not completion criteria:** buying-signal precision or accuracy, that Gemini scores better than the fake provider, reply or conversion rates, and any claim that LinkedIn content-search scanning is permitted by LinkedIn's terms.

---

## 12. Decisions required

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | **Rotate the Gemini key.** It was sent in a chat prompt. | (a) rotate now; (b) accept the risk | **(a)** — assume compromised |
| D2 | Provider precedence (P2) | (a) Gemini > codex > fake; (b) codex first; (c) explicit `LLM_PROVIDER` selector | **(a)**; (c) is cleaner long-term |
| D3 | Default model (P3), given U1 is unverified | (a) `gemini-2.5-flash`; (b) `gemini-3.8-flash` | **(a)** until a live model list confirms access |
| D4 | Widen `providerName` to include `'gemini'` (P6)? It touches shared interfaces and their tests. | (a) widen; (b) keep calling Gemini "luna" | **(a)** — (b) writes false audit data |
| D5 | Expose the scoring provider in the content-search response so C21 is satisfiable. This is the **one** additive backend field this plan would need. | (a) add `provider` to the response; (b) add `GET /api/discovery/provider`; (c) drop C21 | **(a)** — one field, no schema change. Needs your approval since it breaks the "no backend changes" non-goal |
| D6 | Default query count in the panel (P7) | (a) one query; (b) all 12 presets | **(a)** — 12 presets × up to 25 posts is a long run and a large LLM bill |
| D7 | Frontend test tooling (P8) | (a) logic-only tests, no jsdom; (b) add jsdom + @testing-library | **(a)** for this feature; (b) is a standalone tooling decision |
| D8 | Should slice 1 (`.env` fix) ship immediately as a standalone hotfix, ahead of the rest? | (a) yes; (b) bundle | **(a)** — the server cannot boot today |
| D9 | Rename the providers, since "Luna" will no longer describe what they do | (a) rename to `OpenAiCompatible*Provider`; (b) keep names | **(b)** for this plan — renaming needs `rename`-aware refactoring per `AGENTS.md`; (a) as a follow-up |
| D10 | Approve the two live probes (U1/U2 Gemini call; U4 OpenCLI/session) | (a) approve both; (b) Gemini only; (c) neither | **(b)** first — the Gemini probe is cheap and unblocks C29 |

---

## 13. Handoff

**This plan is not approved and must not be implemented.**

After Tushar approves this exact plan and answers D1–D10:

| Step | Agent | Required inputs |
| --- | --- | --- |
| 1 | `coding-builder` | This plan; answers to D1–D10; approved slice scope (recommend slice 1 alone first, then slices 2–3, then 4–6); refreshed GitNexus index; `impact()` output for `providerName` if D4 is (a) |
| 2 | `coding-tester` | Slice scope; section 10 rows for that slice; section 11 rows in scope |
| 3 | `coding-reviewer` | Slice diff; test evidence; `detect_changes({scope:'all'})` output; in-scope completion-contract rows |
| 4 | this planning agent (`RELEASE_REVIEW`) | Delivered evidence versus sections 10 and 11 |

Implementation belongs to `coding-builder`. Verification belongs to `coding-tester` plus `coding-reviewer`. This agent neither implements nor approves its own plan.

Blockers to clear before WP2 can claim a working live run: X3 plus U3 (migration state) and U4 (OpenCLI session).

---

APPROVAL_STATUS: PENDING_USER_REVIEW

STOP: Review the saved plan with Tushar. Do not implement until Tushar explicitly approves this exact plan.
