# LinkedIn Outreach Agent: Production Architecture Specification

This documentation suite provides a granular, engineering-focused overview of the LinkedIn Outreach Agent system. It is intended for developers, architects, and technical stakeholders.

## 1. System Overview & Boundaries

The LinkedIn Outreach Agent is a specialized system for executing targeted, risk-reduced, and effective outreach campaigns on LinkedIn. It is a fork of the `linkedin-outreach-agent` project, heavily modified to incorporate robust safety mechanisms, production-grade concurrency patterns, advanced AI-driven content generation, and a sophisticated, decoupled state-machine architecture.

### Core Technical Pillars:

*   **Infrastructure**:
    *   **Compute**: Node.js / TypeScript runtime.
    *   **Database**: Neon Serverless PostgreSQL, accessed via Drizzle ORM for type-safe queries.
    *   **AI Layer**: Local Ollama instance running a fine-tuned LLaMA-3-8B-Instruct model, with strict Zod-based schema validation for all inputs and outputs.
    *   **Automation**: Playwright for reliable, persistent browser automation.

*   **System Boundaries**:
    *   This system is a **standalone agent**, not a SaaS platform, designed for single-tenant operation.
    *   It operates with a **"human-in-the-loop"** philosophy, requiring explicit approval for all generated outreach actions before execution.
    *   It is framed as **risk-reduced, human-in-the-loop automation**, not "undetectable" automation. The goal is to minimize risk through multiple layers of safety, not to eliminate it entirely.

*   **Core Architectural Principles**:
    *   **Decoupled State**: The lifecycle state of a prospect in a campaign (`CampaignMember`) is strictly separated from the state of an executable task (`OutreachAction`). This prevents state corruption and allows for robust error recovery and retries.
    *   **Transactional Integrity**: All state changes and resource allocations (like daily action budgets) are performed within atomic database transactions to ensure consistency, even under concurrent operation.
    *   **Idempotency**: Actions are designed to be idempotent, using unique keys to prevent duplicate execution.
    *   **Immutability**: An `audit_ledger` provides an immutable, append-only record of every significant event in the system.

## 2. MVP Scope & Phasing

The project is phased to deliver a stable core product first, followed by iterative enhancements.

### MVP Scope:
*   **Single Account Operation**: Manages one LinkedIn account.
*   **Core Pipeline**: Includes CSV import, a full profile acquisition pipeline, deterministic and AI-based ICP scoring.
*   **Basic Campaign**: Supports one active campaign with a sequence of (1) Connection Request + (2) Two Follow-up Messages.
*   **Human-in-the-Loop**: All outreach actions require human approval via a simple UI before being queued for execution.
*   **Core Safety**: Implements working hours enforcement and atomic daily action limits.
*   **Stop-on-Reply**: A robust, multi-layered mechanism to immediately halt outreach upon receiving a reply.
*   **Auditing & Dry-Run**: Includes an immutable audit ledger for all actions and a "dry-run" mode for safe testing.

### Post-MVP Phasing:
*   Features like automated feed commenting, post liking, and multi-campaign management are planned for later phases (e.g., Phase 8), after the core outreach engine is fully stabilized and battle-tested.

## 3. Navigation Index

1.  [**Target Audience and ICP**](./01_TARGET_AUDIENCE_AND_ICP.md) - Data ingestion, validation, AI-driven scoring, and campaign staging.
2.  [**Profile Foundation and Engagement**](./02_PROFILE_FOUNDATION_AND_ENGAGEMENT.md) - Proactive profile optimization.
3.  [**AI Messaging and Copywriting**](./03_AI_MESSAGING_AND_COPYWRITING.md) - The decoupled AI pipeline for generating and validating outreach copy.
4.  [**Outreach Strategy and Sequencing**](./04_OUTREACH_STRATEGY_AND_SEQUENCING.md) - The decoupled state machines governing the outreach lifecycle and action execution.
5.  [**Safety Limits and Operations**](./05_SAFETY_LIMITS_AND_OPERATIONS.md) - The multi-layered safety system and core database schemas.
6.  [**Tracking, KPIs, and Iteration**](./06_TRACKING_KPIS_AND_ITERATION.md) - Data logging, analytics, and the transactional outbox pattern for integrations.
