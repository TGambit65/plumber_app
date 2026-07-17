-- Row-Level Security — tenant isolation spine.
--
-- RLS is enabled incrementally, one table per converted module. A table is
-- enabled here ONLY once every code path that touches it runs through
-- withTenant() (which sets app.current_org). FORCE is required because the
-- app's DB role owns the tables and would otherwise bypass policies.
--
-- Converted so far: kb_articles (Knowledge Base module).
-- TODO (tracked in docs/strategy/architecture.md): jobs, customers, properties,
-- leads, estimates, invoices, projects, price_book_items, inventory,
-- commissions, activities, notifications, integration_connections, messaging.

DO $$
DECLARE
  tbl text;
  rls_tables text[] := ARRAY['kb_articles'];
BEGIN
  FOREACH tbl IN ARRAY rls_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant_isolation', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (organization_id = current_setting(''app.current_org'', true)) WITH CHECK (organization_id = current_setting(''app.current_org'', true))',
      tbl || '_tenant_isolation', tbl
    );
  END LOOP;
END $$;
