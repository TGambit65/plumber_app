import Link from "next/link";
import { t, withTenant } from "@/db";
import { and, asc, eq, gte, isNull, lt, notInArray, or } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { assignJob, bookJob } from "@/lib/actions/office";
import { sendTomorrowReminders } from "@/lib/actions/comms";
import { busyWindowsForDay, overlapsBusy } from "@/lib/calendar/push";
import { fmtTime } from "@/lib/format";
import { enabledJobTypes, enabledPacks } from "@/lib/trade-packs";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Stat,
  Textarea,
  buttonClass,
  jobStatusTone,
  statusLabel,
} from "@/components/ui";
import { DispatchJobCard, priorityTone } from "@/components/office/job-card";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDateParam(raw: string | undefined): Date {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

const LEGEND: { status: string; label: string }[] = [
  "UNSCHEDULED",
  "SCHEDULED",
  "DISPATCHED",
  "EN_ROUTE",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
].map((s) => ({ status: s, label: statusLabel(s) }));

export default async function DispatchPage({ searchParams }: { searchParams: { date?: string } }) {
  const session = await requireSession();
  if (!can(session.role, "schedule.view.all")) {
    return (
      <Card>
        <CardBody>
          <EmptyState title="403 — You don't have access to the dispatch board" hint="Ask an admin if you believe this is a mistake." />
        </CardBody>
      </Card>
    );
  }
  const canManage = can(session.role, "dispatch.manage");

  const day = parseDateParam(searchParams.date);
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const dateStr = toDateStr(day);
  const prevStr = toDateStr(new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1));
  const nextStr = toDateStr(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1));
  const isToday = dateStr === toDateStr(new Date());

  const [techs, dayJobs, unassigned, emergencies, customers, properties] = await withTenant(
    session.organizationId,
    (tx) =>
      Promise.all([
        tx.query.users.findMany({
          where: and(eq(t.users.role, "TECH"), eq(t.users.active, true)),
          with: { truck: true },
          orderBy: asc(t.users.name),
        }),
        tx.query.jobs.findMany({
          where: and(gte(t.jobs.scheduledAt, day), lt(t.jobs.scheduledAt, dayEnd)),
          with: { customer: true, property: true },
          orderBy: asc(t.jobs.scheduledAt),
        }),
        tx.query.jobs.findMany({
          where: and(
            or(eq(t.jobs.status, "UNSCHEDULED"), isNull(t.jobs.assignedToId)),
            notInArray(t.jobs.status, ["COMPLETED", "CANCELLED"])
          ),
          with: { customer: true, property: true },
          orderBy: asc(t.jobs.createdAt),
        }),
        tx.query.jobs.findMany({
          where: and(eq(t.jobs.priority, "EMERGENCY"), notInArray(t.jobs.status, ["COMPLETED", "CANCELLED"])),
          columns: { id: true },
        }),
        tx.query.customers.findMany({ orderBy: asc(t.customers.name) }),
        tx.query.properties.findMany({ with: { customer: true }, orderBy: asc(t.properties.address) }),
      ])
  );

  // Pack composition: job types + enabled-pack chips come from the org's ENABLED
  // trade packs only (constraints 1 & 12). Apex → plumbing+sewer, Summit →
  // hvac+plumbing, American Automators → aa_field_ops ONLY (no plumbing leakage).
  const [jobTypes, packs, busy] = await Promise.all([
    enabledJobTypes(session.organizationId),
    enabledPacks(session.organizationId),
    // D2: the org calendar's busy windows for this day (null when no calendar connected).
    busyWindowsForDay(session.organizationId, day),
  ]);
  const busyWindows = busy?.windows ?? [];
  const conflictedJobIds = new Set(
    dayJobs.filter((j) => overlapsBusy(j.scheduledAt, j.scheduledEnd, busyWindows)).map((j) => j.id)
  );

  const statusCounts = dayJobs.reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <PageHeader
        title="Dispatch board"
        subtitle={`${fmtDate(day)}${isToday ? " · today" : ""}`}
        action={
          <div className="flex items-center gap-2">
            {canManage ? (
              <form action={sendTomorrowReminders}>
                <Button type="submit" size="sm" variant="secondary" title="Text a day-before reminder to every customer scheduled tomorrow (deduped — safe to run twice)">
                  📅 Send tomorrow&apos;s reminders
                </Button>
              </form>
            ) : null}
            <Link href={`/dispatch?date=${prevStr}`} className={buttonClass("secondary", "sm")}>
              ← Prev
            </Link>
            {!isToday ? (
              <Link href="/dispatch" className={buttonClass("secondary", "sm")}>
                Today
              </Link>
            ) : null}
            <Link href={`/dispatch?date=${nextStr}`} className={buttonClass("secondary", "sm")}>
              Next →
            </Link>
          </div>
        }
      />

      {/* Enabled trade packs — the org's composed capability surface */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium uppercase tracking-wide text-slate-500">Trade packs</span>
        {packs.length === 0 ? (
          <span className="text-xs text-slate-400">None enabled</span>
        ) : (
          packs.map((p) => (
            <span key={p.id} title={p.description ?? undefined}>
              <Badge tone="cyan">{p.name}</Badge>
            </span>
          ))
        )}
      </div>

      {/* Stat row */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Jobs on board" value={dayJobs.length} hint={fmtDate(day)} />
        <Stat label="Scheduled" value={statusCounts["SCHEDULED"] ?? 0} />
        <Stat
          label="In the field"
          value={(statusCounts["DISPATCHED"] ?? 0) + (statusCounts["EN_ROUTE"] ?? 0) + (statusCounts["IN_PROGRESS"] ?? 0)}
          hint="dispatched · en route · in progress"
        />
        <Stat label="Completed" value={statusCounts["COMPLETED"] ?? 0} tone="good" />
        <Stat label="Emergencies open" value={emergencies.length} tone={emergencies.length > 0 ? "bad" : "default"} />
      </div>

      {/* D2: external calendar busy windows — soft conflicts, never blocking */}
      {busy ? (
        <div className="mb-4 rounded-lg border border-cyan-200 bg-cyan-50/60 px-3 py-2 text-xs">
          <span className="font-semibold text-cyan-900">🗓️ {busy.provider === "GOOGLE_CALENDAR" ? "Google Calendar" : "Outlook"} busy windows</span>{" "}
          {busyWindows.length === 0 ? (
            <span className="text-cyan-700">— none this day</span>
          ) : (
            <span className="text-cyan-800">
              {busyWindows.map((w, i) => (
                <span key={i} className="mr-2 inline-block rounded bg-white/70 px-1.5 py-0.5">
                  {fmtTime(w.start)}–{fmtTime(w.end)}
                  {w.title ? ` ${w.title}` : ""}
                </span>
              ))}
              {conflictedJobIds.size > 0 ? (
                <span className="ml-1 font-semibold text-amber-700">⚠️ {conflictedJobIds.size} job(s) overlap</span>
              ) : null}
            </span>
          )}
        </div>
      ) : null}

      {/* Legend */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium uppercase tracking-wide text-slate-500">Status legend</span>
        {LEGEND.map((l) => (
          <Badge key={l.status} tone={jobStatusTone[l.status]}>
            {l.label}
          </Badge>
        ))}
      </div>

      {/* Board: unassigned lane + one column per tech */}
      <div className="mb-6 grid gap-4" style={{ gridTemplateColumns: `repeat(${techs.length + 1}, minmax(240px, 1fr))` }}>
        {/* Unassigned lane */}
        <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-amber-900">Unassigned</h2>
            <Badge tone="amber">{unassigned.length}</Badge>
          </div>
          <div className="space-y-2">
            {unassigned.length === 0 ? (
              <EmptyState title="Nothing waiting" hint="All jobs are assigned and scheduled." />
            ) : (
              unassigned.map((job) => (
                <div key={job.id} className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/jobs/${job.id}`} className="text-sm font-medium text-blue-700 hover:underline">
                      {job.number} · {job.jobType}
                    </Link>
                    <Badge tone={priorityTone[job.priority]}>{statusLabel(job.priority)}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600">{job.customer.name}</p>
                  <p className="text-xs text-slate-400">
                    {job.property.address}, {job.property.city}
                  </p>
                  {canManage ? (
                    <form action={assignJob} className="mt-2 space-y-1.5">
                      <input type="hidden" name="jobId" value={job.id} />
                      <Select name="techId" required defaultValue="" aria-label="Assign technician" className="h-8 text-xs">
                        <option value="" disabled>
                          Choose tech…
                        </option>
                        {techs.map((tech) => (
                          <option key={tech.id} value={tech.id}>
                            {tech.name}
                          </option>
                        ))}
                      </Select>
                      <div className="flex gap-1.5">
                        <Input
                          type="datetime-local"
                          name="scheduledAt"
                          required
                          defaultValue={`${dateStr}T09:00`}
                          aria-label="Scheduled time"
                          className="h-8 text-xs"
                        />
                        <Button type="submit" size="sm">
                          Assign
                        </Button>
                      </div>
                    </form>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Tech columns */}
        {techs.map((tech) => {
          const jobsForTech = dayJobs.filter((j) => j.assignedToId === tech.id);
          return (
            <div key={tech.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Avatar name={tech.name} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-800">{tech.name}</div>
                  <div className="truncate text-xs text-slate-500">{tech.truck ? `🚚 ${tech.truck.name}` : "No truck assigned"}</div>
                </div>
                <Badge tone="blue">{jobsForTech.length}</Badge>
              </div>
              <div className="space-y-2">
                {jobsForTech.length === 0 ? (
                  <EmptyState title="No jobs this day" hint="Assign from the unassigned lane." />
                ) : (
                  jobsForTech.map((job) => (
                    <div key={job.id}>
                      {conflictedJobIds.has(job.id) ? (
                        <div className="mb-0.5 rounded-t-md bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                          ⚠️ Overlaps a calendar busy window
                        </div>
                      ) : null}
                      <DispatchJobCard job={job} />
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Book job */}
      {canManage ? (
        <Card>
          <CardHeader title="Book a job" subtitle="Creates the job immediately — scheduled if you pick a time, otherwise it lands in the unassigned lane." />
          <CardBody>
            <form action={bookJob} className="grid gap-3 md:grid-cols-3">
              <Field label="Customer">
                <Select name="customerId" required defaultValue="">
                  <option value="" disabled>
                    Select customer…
                  </option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.company ? ` (${c.company})` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Property (must belong to the customer)">
                <Select name="propertyId" required defaultValue="">
                  <option value="" disabled>
                    Select property…
                  </option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.customer.name} — {p.label ? `${p.label}, ` : ""}
                      {p.address}, {p.city}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Job type">
                {jobTypes.length > 0 ? (
                  <Select name="jobType" defaultValue="">
                    <option value="" disabled>
                      Select job type…
                    </option>
                    {jobTypes.map((jt) => (
                      <option key={jt} value={jt}>
                        {jt}
                      </option>
                    ))}
                    <option value="__OTHER__">Other… (type below)</option>
                  </Select>
                ) : (
                  <input type="hidden" name="jobType" value="__OTHER__" />
                )}
                <Input
                  name="jobTypeOther"
                  className="mt-1.5"
                  placeholder={jobTypes.length > 0 ? "Or a custom type (overrides the list)" : "e.g. Site Survey"}
                />
              </Field>
              <Field label="Priority">
                <Select name="priority" defaultValue="NORMAL">
                  <option value="LOW">Low</option>
                  <option value="NORMAL">Normal</option>
                  <option value="HIGH">High</option>
                  <option value="EMERGENCY">Emergency</option>
                </Select>
              </Field>
              <Field label="Schedule (optional)">
                <Input type="datetime-local" name="scheduledAt" />
              </Field>
              <Field label="Assign tech (optional)">
                <Select name="techId" defaultValue="">
                  <option value="">Unassigned</option>
                  {techs.map((tech) => (
                    <option key={tech.id} value={tech.id}>
                      {tech.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="md:col-span-3">
                <Field label="Description">
                  <Textarea name="description" rows={2} placeholder="What's going on at the property?" />
                </Field>
              </div>
              <div className="md:col-span-3">
                <Button type="submit">Book job</Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
