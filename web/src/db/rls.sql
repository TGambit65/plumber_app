-- Row-Level Security — tenant isolation spine.
--
-- Abort on the first error. Without this, psql happily continues past a failed
-- statement and exits 0, which previously let this script half-apply: the
-- REVOKEs below landed, the matching GRANTs did not, and the database came up
-- looking fine while login was impossible. Never remove this line.
\set ON_ERROR_STOP on
--
-- Every code path touching these tables runs through withTenant() (which sets
-- app.current_org). FORCE is required because the app's DB role owns the
-- tables and would otherwise bypass policies. Fail-safe: with no tenant
-- context, reads return zero rows and inserts fail NOT NULL — never a leak.
--
-- Deliberately NOT RLS-enabled:
--   • organizations    — the tenant roots themselves (no organization_id).
--   • trade_packs      — global catalog shared by all tenants.
--
-- users IS RLS-enabled. The one legitimate global path — login lookup by
-- email before any tenant context exists — goes through auth_user_by_email(),
-- a SECURITY DEFINER function created at the bottom of this file. RUN THIS
-- FILE AS A SUPERUSER (or a BYPASSRLS role) so that function's owner bypasses
-- RLS; everything else in the app reads users inside withTenant().

DO $$
DECLARE
  tbl text;
  rls_tables text[] := ARRAY[
    -- customer core
    'customers', 'properties', 'equipment', 'memberships',
    -- sales
    'leads', 'follow_ups', 'estimates', 'estimate_options', 'estimate_line_items',
    -- field
    'jobs', 'job_photos', 'job_forms', 'time_entries',
    -- projects
    'projects', 'milestones', 'change_orders', 'permits', 'cost_entries', 'subcontractors',
    -- money
    'invoices', 'invoice_line_items', 'payments',
    'commission_rules', 'commission_entries',
    -- inventory
    'price_book_items', 'inventory_locations', 'stock_levels', 'material_usages',
    'part_requests', 'purchase_orders', 'purchase_order_lines',
    -- knowledge & comms
    'kb_articles', 'activities', 'notifications',
    'conversations', 'conversation_participants', 'messages',
    -- approval-gated egress
    'outbound_messages',
    -- supplier punchout (buyer-cookie lookup goes through punchout_session_by_cookie below)
    'punchout_sessions',
    -- ICS calendar feeds (token lookup goes through calendar_feed_by_token below)
    'calendar_feeds',
    -- claims (PII-sensitive) & compliance
    'carriers', 'adjusters', 'claims', 'claim_supplements',
    'inspection_templates', 'inspections', 'certifications',
    -- admin
    'audit_logs', 'user_permission_overrides', 'integration_connections',
    'organization_trade_packs',
    -- identity (global login path served by auth_user_by_email below)
    'users'
  ];
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

-- Login bootstrap: the ONLY global read of users. SECURITY DEFINER runs as
-- this function's owner — create it as a superuser/BYPASSRLS role so it can
-- see across tenants for the email → user resolution at login time.
CREATE OR REPLACE FUNCTION auth_user_by_email(p_email text)
RETURNS SETOF users
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $fn$
  SELECT * FROM users WHERE lower(email) = lower(p_email) AND active = true LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION auth_user_by_email(text) FROM PUBLIC;

-- Punchout cart return: the supplier's BrowserFormPost arrives WITHOUT a user
-- session (cross-site POST strips sameSite cookies), so the unguessable
-- buyer_cookie is the capability token. This is the ONLY global read of
-- punchout_sessions — it resolves the cookie to (id, organization_id) and the
-- handler immediately re-enters withTenant(org) for everything else.
CREATE OR REPLACE FUNCTION punchout_session_by_cookie(p_cookie text)
RETURNS TABLE (id text, organization_id text, status text)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $fn$
  SELECT id, organization_id, status FROM punchout_sessions
  WHERE buyer_cookie = p_cookie LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION punchout_session_by_cookie(text) FROM PUBLIC;

-- ICS feed fetch: calendar clients subscribe with NO session — the unguessable
-- feed token is the capability. This is the ONLY global read of
-- calendar_feeds; the route immediately re-enters withTenant(org) for data.
CREATE OR REPLACE FUNCTION calendar_feed_by_token(p_token text)
RETURNS TABLE (id text, organization_id text, scope text, user_id text, revoked_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $fn$
  SELECT id, organization_id, scope, user_id, revoked_at FROM calendar_feeds
  WHERE token = p_token LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION calendar_feed_by_token(text) FROM PUBLIC;

-- C1: public proposal page — the customer opens their estimate with NO login;
-- the unguessable token is the capability. ONLY global read of estimates; the
-- page immediately re-enters withTenant(org) for everything else.
CREATE OR REPLACE FUNCTION estimate_by_public_token(p_token text)
RETURNS TABLE (id text, organization_id text)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $fn$
  SELECT id, organization_id FROM estimates
  WHERE public_token = p_token LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION estimate_by_public_token(text) FROM PUBLIC;

-- C1: public pay page — same capability pattern for invoices.
CREATE OR REPLACE FUNCTION invoice_by_public_token(p_token text)
RETURNS TABLE (id text, organization_id text)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $fn$
  SELECT id, organization_id FROM invoices
  WHERE public_token = p_token LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION invoice_by_public_token(text) FROM PUBLIC;

-- ── Grant the SECURITY DEFINER capabilities to the application role ─────────
--
-- These five functions are the only sanctioned cross-tenant reads, and every
-- one of them is load-bearing: auth_user_by_email IS login. They are REVOKEd
-- from PUBLIC above, so the app role must be granted EXECUTE explicitly or the
-- application cannot start a session at all.
--
-- The role name is DISCOVERED, not hardcoded. This file previously granted to
-- a literal role named "plumber"; any deployment whose role was named anything
-- else (staging, CI, a customer, a new dev machine) got "permission denied for
-- function auth_user_by_email" at login — after this script had already exited
-- 0. We grant to whoever owns the tables, which is the app's role by
-- construction, since the app created them.
DO $$
DECLARE
  app_role text;
  fn text;
BEGIN
  SELECT tableowner INTO app_role
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'users';

  IF app_role IS NULL THEN
    RAISE EXCEPTION 'Cannot determine the application role: table public.users not found. Run the schema migration (npm run db:push) before this script.';
  END IF;

  FOREACH fn IN ARRAY ARRAY[
    'auth_user_by_email',
    'punchout_session_by_cookie',
    'calendar_feed_by_token',
    'estimate_by_public_token',
    'invoice_by_public_token'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I(text) TO %I', fn, app_role);
  END LOOP;

  RAISE NOTICE 'Granted EXECUTE on 5 SECURITY DEFINER functions to role %', app_role;
END $$;

-- Fail loudly if any capability did not land. A silent half-grant here is
-- indistinguishable from a working install until someone tries to log in.
DO $$
DECLARE
  app_role text;
  fn text;
BEGIN
  SELECT tableowner INTO app_role FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users';
  FOREACH fn IN ARRAY ARRAY[
    'auth_user_by_email',
    'punchout_session_by_cookie',
    'calendar_feed_by_token',
    'estimate_by_public_token',
    'invoice_by_public_token'
  ] LOOP
    IF NOT has_function_privilege(app_role, format('%I(text)', fn), 'EXECUTE') THEN
      RAISE EXCEPTION 'Role % lacks EXECUTE on %() — the application would fail at runtime.', app_role, fn;
    END IF;
  END LOOP;
END $$;
