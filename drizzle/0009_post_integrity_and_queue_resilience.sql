-- Post integrity and queue resilience: add attempt_count for retry ceiling
-- Run: npm run db:migrate
ALTER TABLE "scheduled_actions" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;

-- Repair: extend status check constraint (added in 0005) to include PAUSED_BUDGET
-- which is required for budget-exceeded pause semantics. Idempotent DROP+ADD.
ALTER TABLE "scheduled_actions" DROP CONSTRAINT IF EXISTS "scheduled_actions_status_check";
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_status_check"
  CHECK ("status" IN ('PENDING','CLAIMED','COMPLETED','FAILED','UNCERTAIN','CANCELLED','BLOCKED','PAUSED_BUDGET'));
