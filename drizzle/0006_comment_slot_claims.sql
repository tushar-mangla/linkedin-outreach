-- Canonical post identity and durable comment-slot ownership.
-- Existing rows use their stored URL as a conservative fallback; application
-- code writes provider activity identifiers when source URLs contain one.
ALTER TABLE "engagement_posts" ADD COLUMN IF NOT EXISTS "canonical_post_identifier" text;--> statement-breakpoint
UPDATE "engagement_posts"
SET "canonical_post_identifier" = CASE
  WHEN substring("post_url" FROM '(?i)(?:urn:li:activity:|activity[-:/])([0-9]+)') IS NOT NULL
  THEN 'linkedin:activity:' || substring("post_url" FROM '(?i)(?:urn:li:activity:|activity[-:/])([0-9]+)')
  WHEN substring("post_url" FROM '(?i)(#post-[0-9]+)') IS NOT NULL
  THEN 'linkedin:url:' || lower(regexp_replace(regexp_replace(regexp_replace("post_url", '^(?:https?://)?(?:www\.)?', ''), '[?#].*$', ''), '/+$', '')) || lower(substring("post_url" FROM '(?i)(#post-[0-9]+)'))
  ELSE 'linkedin:url:' || lower(regexp_replace(regexp_replace(regexp_replace("post_url", '^(?:https?://)?(?:www\.)?', ''), '[?#].*$', ''), '/+$', ''))
END
WHERE "canonical_post_identifier" IS NULL;--> statement-breakpoint
ALTER TABLE "engagement_posts" ALTER COLUMN "canonical_post_identifier" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "tenant_post_url_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_canonical_post_idx" ON "engagement_posts" ("tenant_id", "canonical_post_identifier");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_post_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "post_hash" varchar(64) NOT NULL,
  "canonical_post_identifier" text NOT NULL,
  "post_url" text NOT NULL,
  "status" varchar(20) DEFAULT 'PENDING' NOT NULL,
  "scheduled_action_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "account_post_comments" ADD COLUMN IF NOT EXISTS "canonical_post_identifier" text;--> statement-breakpoint
UPDATE "account_post_comments"
SET "canonical_post_identifier" = CASE
  WHEN substring("post_url" FROM '(?i)(?:urn:li:activity:|activity[-:/])([0-9]+)') IS NOT NULL
  THEN 'linkedin:activity:' || substring("post_url" FROM '(?i)(?:urn:li:activity:|activity[-:/])([0-9]+)')
  WHEN substring("post_url" FROM '(?i)(#post-[0-9]+)') IS NOT NULL
  THEN 'linkedin:url:' || lower(regexp_replace(regexp_replace(regexp_replace("post_url", '^(?:https?://)?(?:www\.)?', ''), '[?#].*$', ''), '/+$', '')) || lower(substring("post_url" FROM '(?i)(#post-[0-9]+)'))
  ELSE 'linkedin:url:' || lower(regexp_replace(regexp_replace(regexp_replace("post_url", '^(?:https?://)?(?:www\.)?', ''), '[?#].*$', ''), '/+$', ''))
END
WHERE "canonical_post_identifier" IS NULL;--> statement-breakpoint
ALTER TABLE "account_post_comments" ALTER COLUMN "canonical_post_identifier" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "account_post_hash_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_canonical_post_unique_idx" ON "account_post_comments" ("tenant_id", "account_id", "canonical_post_identifier");
