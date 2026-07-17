/**
 * RLS-coverage guard. Auto-discovers every tenant table (any table with an
 * `organization_id` column) and asserts each has:
 *   • row security ENABLED and FORCED (owner can't bypass), and
 *   • a tenant-isolation policy.
 *
 * This catches the classic multi-tenant footgun: adding a new tenant table and
 * forgetting to put it under RLS. It fails LOUDLY (exit 1) if any tenant table
 * is unprotected. The two intentional non-RLS tables (organizations,
 * trade_packs) have no organization_id, so they're correctly out of scope.
 *
 * Run: npm run db:verify-rls   (needs DATABASE_URL)
 */
import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Every table that carries organization_id === a tenant table.
    const { rows: tenantTables } = await pool.query<{ table_name: string }>(`
      SELECT c.relname AS table_name
      FROM information_schema.columns col
      JOIN pg_class c ON c.relname = col.table_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = col.table_schema
      WHERE col.column_name = 'organization_id'
        AND col.table_schema = 'public'
        AND c.relkind = 'r'
      ORDER BY c.relname
    `);

    const { rows: flags } = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r'
    `);
    const flagByTable = new Map(flags.map((f) => [f.relname, f]));

    const { rows: policies } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_policies WHERE schemaname = 'public'`
    );
    const tablesWithPolicy = new Set(policies.map((p) => p.tablename));

    const failures: string[] = [];
    for (const { table_name } of tenantTables) {
      const f = flagByTable.get(table_name);
      if (!f?.relrowsecurity) failures.push(`${table_name}: RLS not ENABLED`);
      else if (!f.relforcerowsecurity) failures.push(`${table_name}: RLS not FORCED (owner bypasses)`);
      if (!tablesWithPolicy.has(table_name)) failures.push(`${table_name}: no RLS policy`);
    }

    console.log(`Checked ${tenantTables.length} tenant tables (have organization_id).`);
    if (failures.length > 0) {
      console.error(`\n❌ RLS COVERAGE FAILED (${failures.length}):`);
      for (const f of failures) console.error(`   • ${f}`);
      console.error(`\nRun \`npm run db:rls\` (as a superuser) after adding a tenant table.`);
      process.exitCode = 1;
      return;
    }
    console.log("✅ All tenant tables are RLS-enabled, FORCED, and have an isolation policy.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
