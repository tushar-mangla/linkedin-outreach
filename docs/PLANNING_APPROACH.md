# RecruitmentOS Planning & Delivery Model

This document is the governing delivery model for RecruitmentOS. It defines the release order, technical boundaries, and approval gates. Feature plans must follow this model and must not introduce a competing stack or lifecycle vocabulary.

## The 7-Release Delivery Model

RecruitmentOS is delivered through seven sequential releases:

- **Feature 0: Core Foundation** (`v0.0-foundation`)
- **Feature 1: Target Audience & ICP Qualification** (`v0.1-icp`)
- **Feature 2: Profile Foundation & ICP Engagement** (`v0.2-engagement`)
- **Feature 3: AI-Personalized Messaging** (`v0.3-messaging`)
- **Feature 4: Outreach & Multi-Touch Sequencing** (`v0.4-sequences`)
- **Feature 5: Safety & Supervised Execution** (`v0.5-supervised-execution`)
- **Feature 6: Tracking, KPIs & Optimization** (`v1.0-linkedin`)

## Sequential Release Rule

Work on Feature N+1 cannot begin until Feature N has passed its completion gate. Documentation may identify future dependencies, but implementation and release work remain gated.

## Feature Lifecycle

Every release follows the same lifecycle:

1. **Specification:** Scope, contracts, risks, and acceptance criteria are written in `docs/plans/`.
2. **Implementation:** Code is added within the owning abstraction and existing repository conventions.
3. **Database migration:** Schema changes are reviewed and committed as versioned Drizzle migrations.
4. **Tests:** Unit, database, concurrency, integration, and offline end-to-end tests are added according to risk.
5. **Offline demonstration:** The feature works with FakeExecutor, ManualExecutor, fake AI, and local data where applicable.
6. **Human review:** The project lead reviews code, behavior, safety, licensing, and the demonstration.
7. **Release tag:** The approved release tag is created only after all criteria pass.

## Simulation-First Approach

- **`FakeExecutor`:** A deterministic simulation mode that never touches LinkedIn.
- **`ManualExecutor`:** A human-in-the-loop mode that creates operator tasks and records confirmed outcomes.
- **`PlaywrightExecutor`:** Introduced only in Feature 5, after the business workflows and safety controls pass their gates.

Features 0 through 4 must be useful without live LinkedIn activity.

## AI Integration Strategy

- **Provider boundary:** Business services depend on an `AIProvider`; Gemini is one implementation and fake or local providers support offline operation.
- **Deterministic-first:** Hard exclusions and inexpensive rules run before AI calls. AI cannot override a hard exclusion.
- **Structured I/O:** Provider responses are validated with Zod and retain model, prompt, schema, evidence, and usage metadata.

## Executor Boundary

All execution modes conform to one `LinkedInExecutor` interface. Domain services never call Playwright directly. The interface supports the action and synchronization methods required by the current release, with explicit result and uncertainty semantics.

## Canonical Technical Baseline

- TypeScript and Node.js
- Express API
- React and Vite frontend
- PostgreSQL with Drizzle ORM
- Zod runtime validation
- Vitest testing
- Gemini through an AI-provider interface

The repository is multi-tenant. Tenant context, tenant-scoped repositories, and PostgreSQL RLS are layered controls. No document may describe the product as a single-tenant agent or as a fork of an external repository.

## Documentation Rule

Every feature plan must use the same sections: intention, user outcome, scope, domain states, contracts, persistence and migrations, implementation boundaries, tests, offline demonstration, human approval, and release gate. Planned capabilities must be labeled as planned when they are not present in the current codebase.
