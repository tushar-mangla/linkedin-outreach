ALTER TABLE "engagement_history" ADD COLUMN IF NOT EXISTS "scheduled_action_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_history_scheduled_action_id_scheduled_actions_id_fk') THEN
    ALTER TABLE "engagement_history" ADD CONSTRAINT "engagement_history_scheduled_action_id_scheduled_actions_id_fk" FOREIGN KEY ("scheduled_action_id") REFERENCES "public"."scheduled_actions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "engagement_history_scheduled_action_id_idx" ON "engagement_history" USING btree ("scheduled_action_id");
