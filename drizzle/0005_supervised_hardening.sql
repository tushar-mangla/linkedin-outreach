-- Forward-only hardening for supervised execution (plan 0.6, phase 0/2).
-- Preserves 0003/0004; additive only, idempotent guards for isolated clean/upgrade tests.
-- Do NOT apply to shared data without separate written approval.
ALTER TABLE "scheduled_actions" ADD COLUMN IF NOT EXISTS "claim_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_idempotency_key_idx" ON "scheduled_actions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "recommendation_approvals" ADD COLUMN IF NOT EXISTS "expires_at" timestamp;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_actions_status_check') THEN
    ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_status_check" CHECK ("status" IN ('PENDING','CLAIMED','COMPLETED','FAILED','UNCERTAIN','CANCELLED','BLOCKED'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_actions_outcome_check') THEN
    ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_outcome_check" CHECK ("outcome_label" IS NULL OR "outcome_label" IN ('pending','simulated','manual-confirmed','browser-executed','verified','uncertain','refused','failed'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'manual_tasks_status_check') THEN
    ALTER TABLE "manual_tasks" ADD CONSTRAINT "manual_tasks_status_check" CHECK ("status" IN ('PENDING_CONFIRMATION','COMPLETED','FAILED','UNCERTAIN','EXPIRED'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recommendation_approvals_state_check') THEN
    ALTER TABLE "recommendation_approvals" ADD CONSTRAINT "recommendation_approvals_state_check" CHECK ("state" IN ('APPROVED','REJECTED','SUPERSEDED','INVALIDATED','EXPIRED'));
  END IF;
END $$;
