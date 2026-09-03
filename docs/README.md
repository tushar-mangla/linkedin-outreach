# RecruitmentOS Documentation

RecruitmentOS is a multi-tenant, evidence-driven LinkedIn engagement and outreach system. It qualifies target prospects, prepares approved engagement and messaging, runs conditional sequences, stops outreach when a prospect replies or opts out, and measures commercial outcomes.

This repository is implementing the product incrementally. Documentation describes the intended contract for each release; it does not imply that every planned capability already exists in the codebase.

## Canonical Architecture

- **Runtime:** Node.js and TypeScript
- **API:** Express
- **Frontend:** React and Vite
- **Database:** PostgreSQL, locally or through Neon
- **ORM:** Drizzle ORM
- **Validation:** Zod
- **Testing:** Vitest
- **AI:** Provider interface, with Gemini initially and a fake provider for offline tests
- **Execution:** FakeExecutor and ManualExecutor first; Playwright begins only in Feature 5

The application is custom code. External repositories are behavioral or architectural references. Code may be adapted only when its license permits it, required notices are preserved, and provenance is recorded. GPL or restricted-license code is not incorporated into the proprietary core without explicit approval.

## Product Boundaries

- Features 0 through 4 must work without live LinkedIn activity.
- Human approval is required for generated engagement and outbound messages.
- Profile editing is advisory; the system does not automatically edit a LinkedIn profile.
- Feature 5 introduces supervised browser execution one capability at a time.
- Safety controls reduce operational risk but do not make automation undetectable or risk-free.
- Raw domain and audit events remain the source of truth for later analytics.

## Release Index

1. [Feature 0: Core Foundation](plans/0.0-foundation.md) - Multi-tenant persistence, isolation, audit, budgets, leases, approvals, and action infrastructure.
2. [Feature 1: ICP Pipeline](plans/0.1-icp.md) - Persistent prospect ingestion, deterministic filtering, AI qualification, review, and campaign readiness.
3. [Feature 2: Engagement](plans/0.2-engagement.md) - Profile audit and approved, evidence-grounded engagement recommendations.
4. [Feature 3: Messaging](plans/0.3-messaging.md) - Evidence-based connection notes, DMs, follow-ups, critique, and approval.
5. [Feature 4: Sequences](plans/0.4-sequences.md) - Versioned conditional campaigns, scheduled actions, and stop-on-reply behavior.
6. [Feature 5: Supervised Execution](plans/0.5-supervised-execution.md) - Controlled Playwright execution with leases, budgets, health checks, and kill switches.
7. [Feature 6: Analytics](plans/0.6-kpis-and-optimization.md) - Reproducible funnel metrics, rollups, experiments, and dashboard views.

## Current Milestone

The immediate milestone is to complete and verify Feature 0, then finish Feature 1 as a persistent, independently usable ICP pipeline. Features 2 through 6 begin only after their predecessor release gate passes.

## Supporting Documents

- [Planning and delivery model](PLANNING_APPROACH.md)
- [Architecture decisions](ARCHITECTURE_DECISIONS.md)
- [Licensing and provenance](LICENSING_AND_PROVENANCE.md)
- [Business traceability](TRACEABILITY.md)
- [Feature plans](plans/)
- [Current implementation](../src/)
- [Dependency and command baseline](../package.json)
