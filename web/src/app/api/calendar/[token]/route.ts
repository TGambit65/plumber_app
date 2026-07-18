import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db, t, withTenant } from "@/db";
import { buildCalendar, type IcsEvent } from "@/lib/calendar/ics";

export const dynamic = "force-dynamic";

/**
 * GET /api/calendar/[token] — the subscribable ICS feed (dispatch D2).
 *
 * Calendar clients (Apple/Google/Outlook) fetch this with NO session; the
 * unguessable feed token is the capability, resolved via the SECURITY DEFINER
 * function calendar_feed_by_token (the only global read of calendar_feeds).
 * Everything after re-enters withTenant(org), so RLS scopes the job query.
 * Revoked feeds 404 — unsubscribing a lost phone is one click in Settings.
 *
 * Window: jobs from 30 days back to 120 days ahead. Cancelled jobs emit
 * STATUS:CANCELLED so clients strike them rather than orphan them.
 */
export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  try {
    const token = params.token.replace(/\.ics$/i, "").trim();
    if (!token) return NextResponse.json({ error: "not found" }, { status: 404 });

    const result = await db.execute(
      sql`SELECT id, organization_id, scope, user_id, revoked_at FROM calendar_feed_by_token(${token})`
    );
    const feed = (result.rows as Array<{ id: string; organization_id: string; scope: string; user_id: string | null; revoked_at: string | null }>)[0];
    if (!feed || feed.revoked_at) return NextResponse.json({ error: "not found" }, { status: 404 });

    const since = new Date(Date.now() - 30 * 86400_000);

    const { org, jobs, techName } = await withTenant(feed.organization_id, async (tx) => {
      const jobs = await tx.query.jobs.findMany({
        where: and(
          gte(t.jobs.scheduledAt, since),
          isNull(t.jobs.deletedAt),
          feed.scope === "TECH" && feed.user_id ? eq(t.jobs.assignedToId, feed.user_id) : undefined
        ),
        with: { customer: true, property: true, assignedTo: true },
      });
      const org = await tx.query.organizations.findFirst({
        where: eq(t.organizations.id, feed.organization_id),
        columns: { name: true },
      });
      const techName =
        feed.scope === "TECH" && feed.user_id
          ? (await tx.query.users.findFirst({ where: eq(t.users.id, feed.user_id), columns: { name: true } }))?.name
          : undefined;
      return { org, jobs, techName };
    });

    const horizon = Date.now() + 120 * 86400_000;
    const events: IcsEvent[] = jobs
      .filter((j) => j.scheduledAt && j.scheduledAt.getTime() <= horizon)
      .map((j) => ({
        uid: `job-${j.id}@trade-ops`,
        title: `${j.number} · ${j.jobType} — ${j.customer.name}`,
        start: j.scheduledAt as Date,
        end: j.scheduledEnd,
        location: `${j.property.address}, ${j.property.city}, ${j.property.state} ${j.property.zip}`,
        description: [
          `Status: ${j.status}`,
          j.assignedTo ? `Tech: ${j.assignedTo.name}` : "Unassigned",
          j.customer.phone ? `Customer: ${j.customer.phone}` : null,
          j.description ? `\n${j.description}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        cancelled: j.status === "CANCELLED",
      }));

    const name =
      feed.scope === "TECH" ? `${org?.name ?? "Trade-Ops"} — ${techName ?? "Tech"}` : `${org?.name ?? "Trade-Ops"} — Schedule`;

    return new NextResponse(buildCalendar({ name, events, now: new Date() }), {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="schedule.ics"`,
        "cache-control": "private, max-age=300",
      },
    });
  } catch (e) {
    console.error(`[calendar feed] ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "feed failed" }, { status: 500 });
  }
}
