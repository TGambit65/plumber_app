-- Offline-sync support: auto-touch updated_at on syncable tables.
-- Run alongside rls.sql (any role that owns the tables works).

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;

DO $$
DECLARE
  tbl text;
  sync_tables text[] := ARRAY['jobs', 'job_photos', 'job_forms', 'time_entries', 'activities'];
BEGIN
  FOREACH tbl IN ARRAY sync_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', tbl || '_touch_updated_at', tbl);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
      tbl || '_touch_updated_at', tbl
    );
  END LOOP;
END $$;
