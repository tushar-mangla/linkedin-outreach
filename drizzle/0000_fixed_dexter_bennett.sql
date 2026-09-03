CREATE TYPE "public"."prospect_stage" AS ENUM('INGESTED', 'FILTERED_OUT', 'EVALUATED', 'REQUIRES_REVIEW', 'READY_FOR_CAMPAIGN', 'REJECTED');--> statement-breakpoint
CREATE TABLE "account_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"worker_id" varchar(255) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_action_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"action_type" varchar(50) NOT NULL,
	"budget_date" timestamp NOT NULL,
	"limit" integer NOT NULL,
	"reserved_count" integer DEFAULT 0 NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "icp_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"criteria" json NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "icp_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prospect_id" uuid,
	"icp_definition_id" uuid,
	"import_batch_id" uuid,
	"score" integer,
	"confidence" real,
	"fit_breakdown" json,
	"evidence" text,
	"reasoning" text,
	"status" varchar(50) NOT NULL,
	"evaluated_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"icp_definition_id" uuid,
	"filename" varchar(255) NOT NULL,
	"total_rows" integer NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"qualified_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"status" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"linkedin_url" varchar(255) NOT NULL,
	"normalized_linkedin_url" text NOT NULL,
	"current_stage" "prospect_stage" DEFAULT 'INGESTED' NOT NULL,
	"custom_attributes" json,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "icp_evaluations" ADD CONSTRAINT "icp_evaluations_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icp_evaluations" ADD CONSTRAINT "icp_evaluations_icp_definition_id_icp_definitions_id_fk" FOREIGN KEY ("icp_definition_id") REFERENCES "public"."icp_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icp_evaluations" ADD CONSTRAINT "icp_evaluations_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_icp_definition_id_icp_definitions_id_fk" FOREIGN KEY ("icp_definition_id") REFERENCES "public"."icp_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_id_account_id_idx" ON "account_leases" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_id_account_id_action_type_budget_date_idx" ON "daily_action_budgets" USING btree ("tenant_id","account_id","action_type","budget_date");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_id_normalized_url_idx" ON "prospects" USING btree ("tenant_id","normalized_linkedin_url");