# Architecture Decisions

## ADR-001: Product Boundary

RecruitmentOS is a custom multi-tenant application for evidence-driven LinkedIn outreach. External applications inform behavior and architecture but are not the implementation foundation.

## ADR-002: Application Stack

The repository uses TypeScript and Node.js, Express, React/Vite, PostgreSQL, Drizzle ORM, Zod, and Vitest. This matches the current source tree and package manifest. Prisma, Next.js, and Jest are not part of the canonical architecture.

## ADR-003: Tenant Isolation

Tenant isolation uses validated request context, tenant-scoped repositories, and PostgreSQL RLS. All tenant-owned records carry `tenant_id`. Database transactions set tenant context locally; a missing context fails closed.

## ADR-004: Simulation Before Live Execution

FakeExecutor and ManualExecutor support Features 0 through 4. PlaywrightExecutor begins in Feature 5 and is enabled one capability at a time after explicit approval and supervised testing.

## ADR-005: Provider Boundaries

Business services depend on `AIProvider`, `ProspectSourceAdapter`, and `LinkedInExecutor` contracts. Gemini, CSV, fixture, fake, manual, and Playwright implementations remain replaceable adapters.

## ADR-006: Event-Based Analytics

Raw domain and audit events are the source of truth. Daily rollups are reproducible performance artifacts. Cached campaign totals cannot replace event history.

## ADR-007: Data Safety

Credentials are configuration secrets, never documentation or audit payloads. Destructive schema synchronization is limited to disposable databases. Live migration and external execution require explicit approval.
