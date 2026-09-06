CREATE TABLE "recommendation_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "draft_id" uuid NOT NULL REFERENCES "engagement_drafts"("id"),
  "revision" integer NOT NULL,
  "action_type" "engagement_action_type" NOT NULL,
  "post_hash" varchar(64) NOT NULL,
  "comment_text" text NOT NULL,
  "evidence" json NOT NULL,
  "validation_report" json NOT NULL,
  "state" varchar(30) DEFAULT 'PENDING' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_draft_revision_unique" UNIQUE("tenant_id", "draft_id", "revision")
);--> statement-breakpoint
CREATE TABLE "recommendation_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL REFERENCES "recommendation_revisions"("id"),
  "action_type" "engagement_action_type" NOT NULL,
  "operator_id" varchar(255) NOT NULL,
  "state" varchar(30) DEFAULT 'APPROVED' NOT NULL,
  "reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp
);--> statement-breakpoint
CREATE TABLE "manual_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "scheduled_action_id" uuid REFERENCES "scheduled_actions"("id"),
  "action_type" "engagement_action_type" NOT NULL,
  "status" varchar(30) DEFAULT 'PENDING_CONFIRMATION' NOT NULL,
  "outcome_label" varchar(30),
  "confirmation_actor" varchar(255),
  "confirmation_metadata" json,
  "error_code" varchar(80),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);--> statement-breakpoint
CREATE TABLE "engagement_controls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "action_type" "engagement_action_type" NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "kill_switch_active" boolean DEFAULT false NOT NULL,
  "cooldown_until" timestamp,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_account_action_control_unique" UNIQUE("tenant_id", "account_id", "action_type")
);--> statement-breakpoint
CREATE TABLE "browser_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "label" varchar(255) NOT NULL,
  "key_version" varchar(50),
  "health" varchar(30) DEFAULT 'PAUSED' NOT NULL,
  "session_expires_at" timestamp,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "execution_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "scheduled_action_id" uuid NOT NULL REFERENCES "scheduled_actions"("id"),
  "executor_mode" varchar(20) NOT NULL,
  "outcome_label" varchar(30) NOT NULL,
  "evidence_hash" varchar(64),
  "selector_version" varchar(50),
  "redacted_reference" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
ALTER TABLE "scheduled_actions" ADD COLUMN IF NOT EXISTS "revision_id" uuid;
ALTER TABLE "scheduled_actions" ADD COLUMN IF NOT EXISTS "post_hash" varchar(64);
ALTER TABLE "scheduled_actions" ADD COLUMN IF NOT EXISTS "mode" varchar(20);
ALTER TABLE "scheduled_actions" ADD COLUMN IF NOT EXISTS "outcome_label" varchar(30);
ALTER TABLE "scheduled_actions" ADD COLUMN IF NOT EXISTS "error_code" varchar(80);
