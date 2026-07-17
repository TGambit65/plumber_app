import { NextResponse } from "next/server";
import { t, withTenant, type TenantDb } from "@/db";
import { getSession, type Session } from "@/lib/auth";
import { and, eq, inArray, isNull } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * GET /api/sync/initial
 *
 * Full snapshot the caller is authorised to see, plus a `serverTimestamp`
 * cursor the client stores and later passes to /api/sync/delta.
 *
 * Tenant scope: the whole read runs inside `withTenant` so Postgres RLS filters
 * every row to the caller's org. Within the org we additionally scope by role:
 *   - TECH               → only jobs assigned to them (+ their forms/time)
 *   - OFFICE/ADMIN/SALES_PM → everything in the org
 *
 * Only non-deleted rows are returned (initial snapshot has no tombstones;
 * tombstones flow through the delta endpoint).
 */

/** Lightweight customer columns the field UI binds to. */
const customerCols = { id: true, name: true, phone: true, email: true, type: true } as const;
/** Lightweight property columns the field UI binds to. */
const propertyCols = {
  id: true,
  label: true,
  address: true,
  city: true,
  state: true,
  zip: true,
  gateCode: true,
  accessNotes: true,
  parkingNotes: true,
  petNotes: true,
  shutoffLocation: true,
} as const;

function isTech(session: Session): boolean {
  return session.role === "TECH";
}

async function loadScopedSnapshot(tx: TenantDb, session: Session) {
  const tech = isTech(session);

  const jobs = await tx.query.jobs.findMany({
    where: and(
      isNull(t.jobs.deletedAt),
      tech ? eq(t.jobs.assignedToId, session.userId) : undefined
    ),
    with: {
      customer: { columns: customerCols },
      property: { columns: propertyCols },
    },
  });

  const jobIds = jobs.map((j) => j.id);

  // jobForms: forms for the in-scope jobs (RLS already org-scopes them).
  const jobForms =
    jobIds.length === 0
      ? []
      : await tx.query.jobForms.findMany({
          where: and(isNull(t.jobForms.deletedAt), inArray(t.jobForms.jobId, jobIds)),
        });

  // timeEntries: TECH sees only their own; office/admin/sales see all in org.
  const timeEntries = await tx.query.timeEntries.findMany({
    where: and(
      isNull(t.timeEntries.deletedAt),
      tech ? eq(t.timeEntries.userId, session.userId) : undefined
    ),
  });

  return { jobs, jobForms, timeEntries };
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Capture the cursor BEFORE reading so a concurrent write during this request
  // is caught by the next delta (since = this timestamp), never missed.
  const serverTimestamp = new Date().toISOString();

  const snapshot = await withTenant(session.organizationId, (tx) =>
    loadScopedSnapshot(tx, session)
  );

  return NextResponse.json({ serverTimestamp, ...snapshot });
}
