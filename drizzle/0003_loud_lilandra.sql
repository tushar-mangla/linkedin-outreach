CREATE TYPE "public"."draft_status" AS ENUM('PENDING', 'APPROVED', 'EDITED', 'SKIPPED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."engagement_action_type" AS ENUM('LIKE', 'COMMENT');--> statement-breakpoint
CREATE TYPE "public"."post_source_type" AS ENUM('PLAYWRIGHT', 'FIXTURE', 'MANUAL');--> statement-breakpoint
ALTER TYPE "public"."prospect_stage" ADD VALUE 'APPROVED_FOR_OUTREACH' BEFORE 'REJECTED';--> statement-breakpoint
CREATE TABLE "campaign_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"status" varchar(50) DEFAULT 'ENROLLED' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"role_id" uuid,
	"status" varchar(50) DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"action_type" "engagement_action_type" DEFAULT 'COMMENT' NOT NULL,
	"comment_text" text NOT NULL,
	"edited_text" text,
	"status" "draft_status" DEFAULT 'PENDING' NOT NULL,
	"provider" varchar(50) DEFAULT 'fake' NOT NULL,
	"provider_metadata" json,
	"validation_report" json,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"action_type" "engagement_action_type" NOT NULL,
	"interacted_at" timestamp DEFAULT now() NOT NULL,
	"operator_id" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"post_url" text NOT NULL,
	"post_text" text NOT NULL,
	"author_name" varchar(255) DEFAULT '' NOT NULL,
	"published_at" timestamp,
	"source_type" "post_source_type" DEFAULT 'FIXTURE' NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_enrollment_id" uuid,
	"prospect_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"action_type" varchar(50) NOT NULL,
	"payload" json,
	"scheduled_for" timestamp NOT NULL,
	"status" varchar(50) DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"claimed_by" varchar(255),
	"claimed_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_actions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "sequence_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_order" integer NOT NULL,
	"action_type" varchar(50) NOT NULL,
	"delay_days" integer DEFAULT 0 NOT NULL,
	"template" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_leases" ADD COLUMN "lease_token" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_leases" ADD COLUMN "heartbeat_at" timestamp;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_role_id_icp_definitions_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."icp_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_drafts" ADD CONSTRAINT "engagement_drafts_post_id_engagement_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."engagement_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_drafts" ADD CONSTRAINT "engagement_drafts_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_history" ADD CONSTRAINT "engagement_history_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_history" ADD CONSTRAINT "engagement_history_post_id_engagement_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."engagement_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_posts" ADD CONSTRAINT "engagement_posts_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_campaign_enrollment_id_campaign_enrollments_id_fk" FOREIGN KEY ("campaign_enrollment_id") REFERENCES "public"."campaign_enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_definitions" ADD CONSTRAINT "sequence_definitions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_post_url_idx" ON "engagement_posts" USING btree ("tenant_id","post_url");