import { NextResponse, type NextRequest } from "next/server";
import { t, withTenant, type TenantDb } from "@/db";
import { getSession, type Session } from "@/lib/auth";
import { and, eq, gt, inArray, or } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * GET /api/sync/delta?since=<ISO>
 *
 * Incremental changes since the client's last cursor: rows whose `updatedAt`
 * moved past `since`, PLUS tombstones (`deletedAt > since`) so the client can
 * evict locally-cached rows deleted on the server.
 *
 * Same tenant + role scoping as /initial. Returns deleted rows too (the client
 * distinguishes them by a non-null `deletedAt`). A fresh `serverTimestamp` is
 * returned to advance the cursor.
 */

const customerCols = { id: true, name: true, phone: true, email: true, type: true } as const;
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

/** Parse the `since` cursor; fall back to the epoch (== full snapshot) if bad. */
function parseSince(raw: string | null): Date {
  if (!raw) return new Date(0);
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

async function loadDelta(tx: TenantDb, session: Session, since: Date) {
  const tech = isTech(session);
  const changed = (updatedAt: any, deletedAt: any) => or(gt(updatedAt, since), gt(deletedAt, since));

  const jobs = await tx.query.jobs.findMany({
    where: and(
      changed(t.jobs.updatedAt, t.jobs.deletedAt),
      tech ? eq(t.jobs.assignedToId, session.userId) : undefined
    ),
    with: {
      customer: { columns: customerCols },
      property: { columns: propertyCols },
    },
  });

  // For TECH we scope forms to their jobs. Resolve the full set of the tech's
  // job ids (incl. rows unchanged this delta) so a form change on an older job
  // still reaches them.
  let techJobIds: string[] | null = null;
  if (tech) {
    const rows = await tx
      .select({ id: t.jobs.id })
      .from(t.jobs)
      .where(eq(t.jobs.assignedToId, session.userId));
    techJobIds = rows.map((r) => r.id);
  }

  const jobForms = await tx.query.jobForms.findMany({
    where: and(
      changed(t.jobForms.updatedAt, t.jobForms.deletedAt),
      techJobIds
        ? techJobIds.length > 0
          ? inArray(t.jobForms.jobId, techJobIds)
          : eq(t.jobForms.jobId, "__none__")
        : undefined
    ),
  });

  const timeEntries = await tx.query.timeEntries.findMany({
    where: and(
      changed(t.timeEntries.updatedAt, t.timeEntries.deletedAt),
      tech ? eq(t.timeEntries.userId, session.userId) : undefined
    ),
  });

  return { jobs, jobForms, timeEntries };
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const since = parseSince(req.nextUrl.searchParams.get("since"));
  const serverTimestamp = new Date().toISOString();

  const delta = await withTenant(session.organizationId, (tx) => loadDelta(tx, session, since));

  return NextResponse.json({ serverTimestamp, ...delta });
}
