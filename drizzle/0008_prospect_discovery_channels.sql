ALTER TYPE "public"."post_source_type" ADD VALUE IF NOT EXISTS 'POST_KEYWORD_SEARCH';--> statement-breakpoint
CREATE TYPE "public"."prospect_buying_signal_category" AS ENUM('BD_PIPELINE_FEAST_FAMINE', 'COLD_OUTREACH_FATIGUE', 'CONTINGENCY_VS_RETAINER', 'FEE_EROSION', 'CLIENT_GHOSTING', 'TIRED_OF_COLD_CALLING', 'MANUAL_SOURCING_FATIGUE', 'CANDIDATE_GHOSTING', 'ATS_LIMITATIONS', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."prospect_buying_signal_urgency" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TABLE "prospect_buying_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"post_id" uuid,
	"tenant_id" text NOT NULL,
	"archetype" text NOT NULL,
	"signal_category" "prospect_buying_signal_category" NOT NULL,
	"signal_score" integer NOT NULL,
	"urgency" "prospect_buying_signal_urgency" NOT NULL,
	"extracted_emails" json,
	"extracted_links" json,
	"what_they_need" text,
	"evidence_quote" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prospect_buying_signals_tenant_prospect_idx" ON "prospect_buying_signals" USING btree ("tenant_id","prospect_id");--> statement-breakpoint
CREATE TABLE "market_content_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"source_post_id" text,
	"author_profile_url" text NOT NULL,
	"category" text NOT NULL,
	"raw_verbatim_quote" text NOT NULL,
	"emotional_sentiment" text,
	"suggested_content_hook" text,
	"tools_mentioned" json,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_content_insights_tenant_idx" ON "market_content_insights" USING btree ("tenant_id");--> statement-breakpoint
CREATE TABLE "discovery_query_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"query" text NOT NULL,
	"posts_found" integer DEFAULT 0 NOT NULL,
	"signals_detected" integer DEFAULT 0 NOT NULL,
	"prospects_promoted" integer DEFAULT 0 NOT NULL,
	"last_searched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_query_stats_tenant_query_idx" ON "discovery_query_stats" USING btree ("tenant_id","query");