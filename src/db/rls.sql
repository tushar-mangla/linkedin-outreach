
-- Enable RLS for all tables that have a tenant_id column
ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_action_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_evaluations ENABLE ROW LEVEL SECURITY;

-- Create a policy that filters based on the current tenant_id
CREATE POLICY tenant_isolation_policy ON prospects
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_policy ON daily_action_budgets
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_policy ON icp_definitions
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_policy ON import_batches
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_policy ON icp_evaluations
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Force RLS for all users, including the table owner
ALTER TABLE prospects FORCE ROW LEVEL SECURITY;
ALTER TABLE daily_action_budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE icp_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE icp_evaluations FORCE ROW LEVEL SECURITY;
