# Documentation Note: Project Configuration

This file records the configuration baseline used by the aligned plans. It is not a feature release.

## Current Baseline

- The project uses ESM through `package.json` and TypeScript NodeNext settings.
- Vite serves the current React frontend.
- Drizzle manages PostgreSQL schema and migrations.
- Vitest runs automated tests.
- `npm run db:migrate` applies reviewed migrations.
- `npm run db:push` is restricted to disposable development databases.

## Validation

Before implementation work, run `npm run typecheck`, `npm test`, and `npm run build`. API startup and database migration checks belong to the implementation task that owns those surfaces and must not be represented as already complete here.
