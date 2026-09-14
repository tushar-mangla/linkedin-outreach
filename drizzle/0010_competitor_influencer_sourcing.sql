-- Channel 5: competitor & influencer post-engager sourcing — target registry.
-- Run: npm run db:migrate
CREATE TYPE "public"."engager_target_type" AS ENUM('COMPETITOR', 'INFLUENCER');--> statement-breakpoint
CREATE TABLE "engagement_target_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_type" "engager_target_type" NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"linkedin_url" varchar(255) NOT NULL,
	"normalized_url" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "engager_target_tenant_url_idx" ON "engagement_target_sources" USING btree ("tenant_id","normalized_url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engager_target_tenant_active_idx" ON "engagement_target_sources" USING btree ("tenant_id","is_active");--> statement-breakpoint
-- RLS for the new tenant-scoped registry (mirrors src/db/rls.sql).
ALTER TABLE "engagement_target_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "engagement_target_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_policy" ON "engagement_target_sources"
	FOR ALL
	USING ("tenant_id" = current_setting('app.current_tenant_id', true)::uuid)
	WITH CHECK ("tenant_id" = current_setting('app.current_tenant_id', true)::uuid);