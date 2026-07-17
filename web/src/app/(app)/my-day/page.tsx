import Link from "next/link";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { advanceJobStatus } from "@/lib/actions/field";
import { and, asc, eq, gte, isNull, lt } from "drizzle-orm";
import { fmtTime, fmtDate } from "@/lib/format";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  LinkButton,
  buttonClass,
  jobStatusTone,
  statusLabel,
  type BadgeTone,
} from "@/components/ui";
import { PropertyChips } from "@/components/field/property-chips";
import { Elapsed } from "@/components/field/elapsed";

export const dynamic = "force-dynamic";

const priorityTone: Record<string, BadgeTone> = {
  LOW: "slate",
  NORMAL: "slate",
  HIGH: "amber",
  EMERGENCY: "red",
};

function mapsHref(p: { address: string; city: string; state: string; zip: string }) {
  return `https://maps.google.com/?q=${encodeURIComponent(`${p.address}, ${p.city}, ${p.state} ${p.zip}`)}`;
}

const NEXT_STEP: Record<string, { to: string; label: string } | undefined> = {
  SCHEDULED: { to: "DISPATCHED", label: "📋 Accept dispatch" },
  DISPATCHED: { to: "EN_ROUTE", label: "🚗 On my way — sends text" },
  EN_ROUTE: { to: "IN_PROGRESS", label: "▶️ Arrived — start work" },
};

export default async function MyDayPage() {
  const session = await requireSession();

  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const startTomorrow = new Date(startToday);
  startTomorrow.setDate(startTomorrow.getDate() + 1);
  const startDayAfter = new Date(startToday);
  startDayAfter.setDate(startDayAfter.getDate() + 2);

  const [todayJobs, tomorrowJobs, openParts, [activeEntry]] = await withTenant(
    session.organizationId,
    (tx) =>
      Promise.all([
        tx.query.jobs.findMany({
          where: and(
            eq(t.jobs.assignedToId, session.userId),
            gte(t.jobs.scheduledAt, startToday),
            lt(t.jobs.scheduledAt, startTomorrow)
          ),
          with: { customer: true, property: true },
          orderBy: asc(t.jobs.scheduledAt),
        }),
        tx.query.jobs.findMany({
          where: and(
            eq(t.jobs.assignedToId, session.userId),
            gte(t.jobs.scheduledAt, startTomorrow),
            lt(t.jobs.scheduledAt, startDayAfter)
          ),
          with: { customer: true },
          orderBy: asc(t.jobs.scheduledAt),
        }),
        tx.query.partRequests.findMany({
          where: and(eq(t.partRequests.requestedById, session.userId), eq(t.partRequests.status, "OPEN")),
          with: { job: true },
        }),
        tx.query.timeEntries.findMany({
          where: and(eq(t.timeEntries.userId, session.userId), isNull(t.timeEntries.endedAt)),
          with: { job: true },
          limit: 1,
        }),
      ])
  );

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = session.name.split(" ")[0];
  const remaining = todayJobs.filter((j) => j.status !== "COMPLETED" && j.status !== "CANCELLED");
  const currentJob = remaining[0];

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">
          {greeting}, {firstName} 👋
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} ·{" "}
          {remaining.length} of {todayJobs.length} jobs remaining
        </p>
      </div>

      {/* Active clock */}
      {activeEntry ? (
        <Card className="mb-4 border-emerald-200 bg-emerald-50/60">
          <CardBody className="flex items-center justify-between gap-3 py-3">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
              </span>
              <div>
                <div className="text-sm font-semibold text-emerald-900">
                  {activeEntry.kind === "TRAVEL" ? "Travel" : "Work"} clock running
                  {activeEntry.job ? ` — ${activeEntry.job.number} ${activeEntry.job.jobType}` : ""}
                </div>
                <div className="text-xs text-emerald-700">Started {fmtTime(activeEntry.startedAt)}</div>
              </div>
            </div>
            <Elapsed
              startedAt={activeEntry.startedAt.toISOString()}
              className="text-xl font-bold tabular-nums text-emerald-800"
            />
          </CardBody>
        </Card>
      ) : null}

      {/* Today's route */}
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Today&apos;s route</h2>
      {todayJobs.length === 0 ? (
        <EmptyState title="No jobs on your route today" hint="Enjoy the quiet — or check tomorrow's preview below." />
      ) : (
        <div className="space-y-4">
          {todayJobs.map((job) => {
            const isCurrent = currentJob?.id === job.id;
            const next = NEXT_STEP[job.status];
            const done = job.status === "COMPLETED";
            return (
              <Card
                key={job.id}
                className={
                  isCurrent
                    ? "border-blue-300 ring-2 ring-blue-100"
                    : done
                      ? "opacity-70"
                      : undefined
                }
              >
                <CardBody className="space-y-3 p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-lg font-bold tabular-nums text-slate-900">
                      {fmtTime(job.scheduledAt)}
                      {job.scheduledEnd ? (
                        <span className="font-medium text-slate-400"> – {fmtTime(job.scheduledEnd)}</span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {job.priority !== "NORMAL" && job.priority !== "LOW" ? (
                        <Badge tone={priorityTone[job.priority]}>
                          {job.priority === "EMERGENCY" ? "🚨 " : ""}
                          {statusLabel(job.priority)}
                        </Badge>
                      ) : null}
                      <Badge tone={jobStatusTone[job.status]}>{statusLabel(job.status)}</Badge>
                    </div>
                  </div>

                  <div>
                    <Link href={`/jobs/${job.id}`} className="text-xl font-semibold text-slate-900 hover:text-blue-700">
                      {job.jobType}
                    </Link>
                    <div className="mt-0.5 text-sm text-slate-600">
                      {job.number} · {job.customer.name}
                    </div>
                    <a
                      href={mapsHref(job.property)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex min-h-[40px] items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-800"
                    >
                      🧭 Navigate · {job.property.address}, {job.property.city}
                    </a>
                  </div>

                  <PropertyChips property={job.property} />

                  {isCurrent ? (
                    <div className="space-y-2 pt-1">
                      {job.status === "IN_PROGRESS" ? (
                        <LinkButton
                          href={`/jobs/${job.id}/closeout`}
                          variant="success"
                          size="lg"
                          className="h-14 w-full text-lg font-semibold"
                        >
                          ✅ Start closeout →
                        </LinkButton>
                      ) : next ? (
                        <form action={advanceJobStatus}>
                          <input type="hidden" name="jobId" value={job.id} />
                          <input type="hidden" name="to" value={next.to} />
                          <button type="submit" className={buttonClass("primary", "lg", "h-14 w-full text-lg font-semibold")}>
                            {next.label}
                          </button>
                        </form>
                      ) : null}
                      <LinkButton href={`/jobs/${job.id}`} variant="secondary" size="lg" className="w-full">
                        Job details
                      </LinkButton>
                    </div>
                  ) : (
                    <div className="pt-1">
                      <LinkButton href={`/jobs/${job.id}`} variant="ghost" size="md" className="w-full border border-slate-200">
                        {done ? "View completed job" : "Job details"}
                      </LinkButton>
                    </div>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {/* Tomorrow preview */}
      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Tomorrow · {fmtDate(startTomorrow)}
      </h2>
      {tomorrowJobs.length === 0 ? (
        <EmptyState title="Nothing scheduled tomorrow yet" />
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {tomorrowJobs.map((job) => (
              <li key={job.id}>
                <Link href={`/jobs/${job.id}`} className="flex min-h-[48px] items-center gap-3 px-4 py-3 hover:bg-slate-50">
                  <span className="w-16 text-sm font-semibold tabular-nums text-slate-700">{fmtTime(job.scheduledAt)}</span>
                  <span className="flex-1 truncate text-sm text-slate-700">
                    <span className="font-medium text-slate-900">{job.jobType}</span> · {job.customer.name}
                  </span>
                  <Badge tone={priorityTone[job.priority]}>{statusLabel(job.priority)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Open part requests */}
      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">My open part requests</h2>
      {openParts.length === 0 ? (
        <EmptyState title="No open part requests" hint="File one from any job detail page." />
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {openParts.map((pr) => (
              <li key={pr.id} className="flex items-center gap-3 px-4 py-3">
                <span className="text-lg">🧰</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900">{pr.description}</div>
                  <div className="text-xs text-slate-500">
                    Qty {pr.qty}
                    {pr.job ? ` · ${pr.job.number}` : ""} · filed {fmtDate(pr.createdAt)}
                  </div>
                </div>
                <Badge tone="amber">Open</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
