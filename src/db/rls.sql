
-- Enable RLS for all tables that have a tenant_id column
ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_action_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_target_sources ENABLE ROW LEVEL SECURITY;

-- Create a policy that filters based on the current tenant_id
CREATE POLICY tenant_isolation_policy ON prospects
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_policy ON daily_action_budgets
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_policy ON icp_definitions
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_policy ON import_batches
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_policy ON icp_evaluations
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'review_decisions', 'audit_events', 'account_leases', 'campaigns',
    'scheduled_actions',
    'engagement_posts', 'engagement_drafts', 'engagement_history',
    'recommendation_revisions', 'recommendation_approvals', 'manual_tasks',
    'engagement_controls', 'browser_accounts', 'execution_evidence',
    'engagement_target_sources'
  ] LOOP
    EXECUTE format('CREATE POLICY tenant_isolation_policy ON %I FOR ALL USING (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid)', table_name);
  END LOOP;
END $$;

-- Force RLS for all users, including the table owner
ALTER TABLE prospects FORCE ROW LEVEL SECURITY;
ALTER TABLE daily_action_budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE icp_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE icp_evaluations FORCE ROW LEVEL SECURITY;
ALTER TABLE review_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE account_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_actions FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement_posts FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement_history FORCE ROW LEVEL SECURITY;
ALTER TABLE recommendation_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE recommendation_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE manual_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement_controls FORCE ROW LEVEL SECURITY;
ALTER TABLE browser_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE execution_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement_target_sources FORCE ROW LEVEL SECURITY;
