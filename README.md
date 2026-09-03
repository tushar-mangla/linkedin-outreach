# RecruitmentOS

RecruitmentOS is a TypeScript foundation for a multi-tenant, evidence-driven LinkedIn engagement and outreach system. The current implementation focuses on persistence primitives and the ICP qualification pipeline. Engagement, messaging, sequencing, browser execution, and analytics remain phased deliverables.

## Stack

- Node.js and TypeScript
- Express API dependencies
- React and Vite frontend
- PostgreSQL with Drizzle ORM
- Zod validation
- Vitest tests
- Gemini evaluator with offline test doubles
- FakeExecutor and ManualExecutor

## Repository Layout

- `src/db/`: schema, migrations, adapters, tenant context, and storage
- `src/services/`: budgets, leases, safety boundary, and ICP pipeline
- `src/executors/`: fake and manual execution contracts
- `src/schemas/`: runtime validation schemas
- `tests/`: unit, persistence, and release-gate tests
- `docs/`: canonical architecture and phase plans
- `drizzle/`: reviewed database migrations

## Local Setup

```bash
npm install
npm run typecheck
npm test
```

For PostgreSQL-backed work, provide `DATABASE_URL` in an untracked `.env` file. Use a local PostgreSQL instance or an approved development database.

```bash
npm run db:generate
npm run db:migrate
```

`db:push` is for disposable development databases only. Do not use destructive schema synchronization or drop-table scripts against shared or production data.

## Development Commands

```bash
npm run dev          # Vite frontend
npm run api:dev      # API entrypoint when implemented
npm run build        # Typecheck and frontend build
npm test             # Vitest suite
```

## Delivery Boundary

Features 0 through 4 must work without live LinkedIn activity. Human approval is required for generated engagement and outbound messages. Playwright-based supervised execution begins only in Feature 5, one capability at a time.

See [docs/README.md](docs/README.md) for the canonical release plan and [docs/PLANNING_APPROACH.md](docs/PLANNING_APPROACH.md) for delivery gates.
