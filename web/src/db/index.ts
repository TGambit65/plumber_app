import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __dbPool: Pool | undefined;
}

const pool =
  global.__dbPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
  });

if (process.env.NODE_ENV !== "production") global.__dbPool = pool;

/**
 * `db` — the base client. Used for system/unscoped work (auth lookup by email,
 * organization resolution) and, today, for modules not yet converted to the
 * tenant-scoped path. RLS is NOT enabled on those tables yet (see MULTI-TENANCY
 * in the architecture doc), so they continue to work during the incremental
 * conversion.
 */
export const db = drizzle(pool, { schema });
export * as t from "./schema";

export type TenantDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * withTenant — the correct tenant-scoped primitive. Runs `fn` inside a single
 * transaction with `SET LOCAL app.current_org`, so:
 *   • RLS policies filter every read to the org, and
 *   • the organization_id column default (current_setting('app.current_org'))
 *     auto-populates inserts,
 * all on the SAME connection, with the GUC auto-reset at commit. Safe with a
 * connection pool (no cross-request leakage).
 *
 * Usage:
 *   const rows = await withTenant(orgId, (tx) => tx.query.kbArticles.findMany());
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (tx: TenantDb) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config(..., true) = transaction-local; cleared automatically at commit.
    await tx.execute(sql`select set_config('app.current_org', ${organizationId}, true)`);
    return fn(tx as unknown as TenantDb);
  });
}
