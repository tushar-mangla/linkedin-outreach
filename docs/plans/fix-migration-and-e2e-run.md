# Documentation Note: Migration and Application Verification

This file records verification expectations; it is not a replacement for a feature release plan.

## Migration Verification

1. Confirm `DATABASE_URL` points to an approved disposable or local PostgreSQL database.
2. Generate and inspect a Drizzle migration after schema changes.
3. Apply the migration to a fresh database.
4. Apply it again and confirm the migration runner reports no pending work.
5. Test RLS and tenant-scoped transactions separately; successful migration alone does not prove isolation.

Never publish or commit database credentials. Do not drop existing tables or use destructive synchronization against shared data.

## Application Verification

The frontend currently provides the Vite entrypoint and the API surface is still being built. A health endpoint, API wiring, and frontend-to-API check must be documented and tested when that implementation lands; they are not assumed to exist yet.
