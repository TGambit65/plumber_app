import Link from "next/link";
import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { applyOptimizedDay } from "@/lib/actions/dispatch-ai";
import { buildDriveFn } from "@/lib/dispatch/suggest";
import { optimizeDay, type EngineJob } from "@/lib/dispatch/engine";
import { driveTimeResolver } from "@/lib/geo/service";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, buttonClass } from "@/components/ui";
import { fmtDate, fmtTime } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Optimize-my-day (D4) — the DIFF view. The engine proposes a drive-minimizing
 * order + retimed schedule for one tech's day; NOTHING changes until the
 * dispatcher clicks Apply. Cancel walks away without a trace (beyond the page
 * view). Jobs already in progress are never touched.
 */
export default async function OptimizePage({
  searchParams,
}: {
  searchParams: { tech?: string; date?: string };
}) {
  const session = await requireSession();
  if (!can(session.role, "dispatch.manage")) {
    return (
      <Card>
        <CardBody>
          <EmptyState title="403 — dispatch access required" />
        </CardBody>
      </Card>
    );
  }

  const techId = searchParams.tech ?? "";
  const dateRaw = searchParams.date ?? "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
    ? new Date(Number(dateRaw.slice(0, 4)), Number(dateRaw.slice(5, 7)) - 1, Number(dateRaw.slice(8, 10)))
    : new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);

  const { tech, jobs } = await withTenant(session.organizationId, async (tx) => {
    const tech = await tx.query.users.findFirst({ where: eq(t.users.id, techId) });
    const jobs = tech
      ? await tx.query.jobs.findMany({
          where: and(
            eq(t.jobs.assignedToId, techId),
            gte(t.jobs.scheduledAt, day),
            lt(t.jobs.scheduledAt, dayEnd),
            inArray(t.jobs.status, ["SCHEDULED", "DISPATCHED"]),
            isNull(t.jobs.deletedAt)
          ),
          with: { customer: true, property: true },
          orderBy: (j, { asc }) => [asc(j.scheduledAt)],
        })
      : [];
    return { tech, jobs };
  });

  if (!tech) {
    return (
      <Card>
        <CardBody>
          <EmptyState title="Tech not found" />
        </CardBody>
      </Card>
    );
  }

  const engineJobs: EngineJob[] = jobs
    .filter((j) => j.scheduledAt && j.property.lat !== null && j.property.lng !== null)
    .map((j) => ({
      id: j.id,
      number: j.number,
      scheduledAt: j.scheduledAt as Date,
      scheduledEnd: j.scheduledEnd,
      point: { lat: j.property.lat as number, lng: j.property.lng as number },
    }));

  const { source } = await driveTimeResolver(session.organizationId);
  const driveFn = await buildDriveFn(
    session.organizationId,
    engineJobs.map((j) => j.point!)
  );
  const plan = optimizeDay(engineJobs, driveFn);
  const byId = new Map(jobs.map((j) => [j.id, j]));

  return (
    <div>
      <PageHeader
        title={`✨ Optimize ${tech.name}'s day`}
        subtitle={`${fmtDate(day)} · ${jobs.length} editable job(s) · drive times ${source === "routed" ? "routed via Google Maps" : "estimated from distance"}`}
        action={
          <Link href="/dispatch" className={buttonClass("secondary", "sm")}>
            ← Back to dispatch
          </Link>
        }
      />

      {!plan ? (
        <Card>
          <CardBody>
            <EmptyState
              title="Nothing to optimize"
              hint="Optimization needs at least 3 still-editable jobs this day, all with mappable addresses. Jobs already in progress are never moved."
            />
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card><CardBody><div className="text-xs uppercase tracking-wide text-slate-500">Drive today (current)</div><div className="text-2xl font-bold text-slate-900">~{plan.totalDriveBeforeMin} min</div></CardBody></Card>
            <Card><CardBody><div className="text-xs uppercase tracking-wide text-slate-500">Drive (proposed)</div><div className="text-2xl font-bold text-emerald-600">~{plan.totalDriveAfterMin} min</div></CardBody></Card>
            <Card><CardBody><div className="text-xs uppercase tracking-wide text-slate-500">Saved behind the wheel</div><div className={`text-2xl font-bold ${plan.minutesSaved > 0 ? "text-emerald-600" : "text-slate-900"}`}>{plan.minutesSaved} min</div></CardBody></Card>
            <Card><CardBody><div className="text-xs uppercase tracking-wide text-slate-500">Day ends</div><div className="text-2xl font-bold text-slate-900">{fmtTime(plan.dayEndsAfter)}</div><div className="text-xs text-slate-400">was {fmtTime(plan.dayEndsBefore)}</div></CardBody></Card>
          </div>

          <Card>
            <CardHeader
              title="Proposed schedule — review before applying"
              subtitle="Same jobs, same durations — reordered and retimed with real drive gaps. Nothing changes until you apply."
            />
            <CardBody>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Current</h3>
                  <ul className="space-y-2">
                    {jobs.map((j) => (
                      <li key={j.id} className="rounded-lg border border-slate-200 p-2.5 text-sm">
                        <span className="font-medium tabular-nums">{j.scheduledAt ? fmtTime(j.scheduledAt) : "—"}</span>
                        {" · "}
                        {j.number} · {j.jobType} — {j.customer.name}
                        <div className="text-xs text-slate-400">{j.property.address}</div>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Proposed</h3>
                  <ul className="space-y-2">
                    {plan.schedule.map((s, i) => {
                      const j = byId.get(s.id)!;
                      const moved = j.scheduledAt && Math.abs(s.start.getTime() - j.scheduledAt.getTime()) > 60_000;
                      return (
                        <li key={s.id} className={`rounded-lg border p-2.5 text-sm ${moved ? "border-violet-300 bg-violet-50" : "border-slate-200"}`}>
                          <span className="font-medium tabular-nums">{fmtTime(s.start)}–{fmtTime(s.end)}</span>
                          {" · "}
                          {j.number} · {j.jobType} — {j.customer.name}
                          {moved ? <Badge tone="violet" className="ml-1.5">moved</Badge> : null}
                          <div className="text-xs text-slate-400">
                            stop {i + 1} · {j.property.address}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-4">
                <form action={applyOptimizedDay}>
                  <input type="hidden" name="techId" value={techId} />
                  <input
                    type="hidden"
                    name="plan"
                    value={JSON.stringify(plan.schedule.map((s) => ({ id: s.id, startIso: s.start.toISOString(), endIso: s.end.toISOString() })))}
                  />
                  <input
                    type="hidden"
                    name="summary"
                    value={`Route optimized: ~${plan.minutesSaved} min less driving (${plan.totalDriveBeforeMin}→${plan.totalDriveAfterMin} min), day ends ${fmtTime(plan.dayEndsAfter)}.`}
                  />
                  <Button type="submit">✅ Apply this schedule</Button>
                </form>
                <Link href="/dispatch" className={buttonClass("secondary", "md")}>
                  Cancel — keep the current schedule
                </Link>
                <span className="ml-auto text-xs text-slate-400">Customers with changed times may deserve a heads-up text.</span>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
