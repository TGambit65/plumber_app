import Link from "next/link";
import { t, withTenant } from "@/db";
import { and, asc, eq, gte, isNull, lt, notInArray, or } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { assignJob, bookJob } from "@/lib/actions/office";
import { sendTomorrowReminders } from "@/lib/actions/comms";
import { busyWindowsForDay, overlapsBusy } from "@/lib/calendar/push";
import { fmtTime } from "@/lib/format";
import { analyzeChain, type ChainJob, type Hop } from "@/lib/geo/distance";
import { driveTimeResolver } from "@/lib/geo/service";
import { DayMap, type MapStop } from "@/components/office/day-map";
import { buildDriveFn, buildTechDays, suggestForJobs } from "@/lib/dispatch/suggest";
import { acceptSuggestion, dismissSuggestion } from "@/lib/actions/dispatch-ai";
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

  // ── D3: geography — per-tech drive chains + day-map stops ─────────────────
  const { source: driveSource, resolve: resolveDrive } = await driveTimeResolver(session.organizationId);
  const hopsByTech = new Map<string, Hop[]>();
  const mapStops: MapStop[] = [];
  for (let ti = 0; ti < techs.length; ti++) {
    const tech = techs[ti];
    const jobsForTech = dayJobs.filter((j) => j.assignedToId === tech.id && j.scheduledAt);
    const chain: ChainJob[] = jobsForTech.map((j) => ({
      id: j.id,
      scheduledAt: j.scheduledAt as Date,
      scheduledEnd: j.scheduledEnd,
      point: j.property.lat !== null && j.property.lng !== null ? { lat: j.property.lat, lng: j.property.lng } : null,
    }));
    // Precompute drive minutes for consecutive pairs (routed when connected).
    const sorted = [...chain].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    const driveByPair = new Map<string, number>();
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a.point && b.point) {
        driveByPair.set(`${a.point.lat},${a.point.lng}|${b.point.lat},${b.point.lng}`, await resolveDrive(a.point, b.point));
      }
    }
    hopsByTech.set(
      tech.id,
      analyzeChain(chain, (from, to) => driveByPair.get(`${from.lat},${from.lng}|${to.lat},${to.lng}`) ?? null)
    );
    sorted.forEach((c, i) => {
      if (c.point) {
        const job = jobsForTech.find((j) => j.id === c.id);
        mapStops.push({ ...c.point, key: c.id, label: job?.number ?? "", order: i + 1, techIndex: ti });
      }
    });
  }
  const impossibleCount = Array.from(hopsByTech.values()).flat().filter((h) => h.status === "impossible").length;

  // ── D4: human-gated suggestions for the unassigned lane ───────────────────
  const techDays = await buildTechDays(session.organizationId, day);
  const unassignedCandidates = unassigned.map((j) => ({
    id: j.id,
    jobType: j.jobType,
    priority: j.priority,
    point: j.property.lat !== null && j.property.lng !== null ? { lat: j.property.lat, lng: j.property.lng } : null,
  }));
  const allPoints = [
    ...techDays.flatMap((td) => td.jobs.map((j) => j.point).filter((p): p is NonNullable<typeof p> => p !== null)),
    ...unassignedCandidates.map((c) => c.point).filter((p): p is NonNullable<typeof p> => p !== null),
  ];
  const driveFn = await buildDriveFn(session.organizationId, allPoints);
  const suggestions = suggestForJobs(unassignedCandidates, techDays, day, new Date(), driveFn);

  // D4 anomaly nudges — advisory, never blocking.
  const now = Date.now();
  const agedUnassigned = unassigned.filter((j) => now - j.createdAt.getTime() > 48 * 3600_000);
  const overbookedTechs = techDays
    .filter((td) => {
      const totalMin = td.jobs.reduce((sum, j) => {
        const end = j.scheduledEnd ?? new Date(j.scheduledAt.getTime() + 120 * 60_000);
        return sum + (end.getTime() - j.scheduledAt.getTime()) / 60_000;
      }, 0);
      return totalMin > 9 * 60;
    })
    .map((td) => td.techName);
  const optimizableTechIds = new Set(
    techDays.filter((td) => td.jobs.filter((j) => j.point).length >= 3).map((td) => td.techId)
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

      {/* D4: anomaly nudges — quiet flags, never modals */}
      {agedUnassigned.length > 0 || overbookedTechs.length > 0 ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
          <span className="font-semibold">💡 Worth a look:</span>{" "}
          {agedUnassigned.length > 0 ? (
            <span className="mr-3">
              {agedUnassigned.length} unassigned job{agedUnassigned.length > 1 ? "s" : ""} aging past 48h (
              {agedUnassigned.map((j) => j.number).join(", ")})
            </span>
          ) : null}
          {overbookedTechs.length > 0 ? <span>overbooked today: {overbookedTechs.join(", ")}</span> : null}
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
                  {/* D4: the engine proposes, the dispatcher disposes */}
                  {canManage && suggestions.has(job.id) ? (() => {
                    const s = suggestions.get(job.id)!;
                    return (
                      <div className={`mt-2 rounded-lg border p-2 text-xs ${s.kind === "EMERGENCY" ? "border-red-200 bg-red-50" : "border-violet-200 bg-violet-50"}`}>
                        <div className="font-semibold text-slate-800">
                          {s.kind === "EMERGENCY" ? "🚨 Least disruption: " : "✨ Suggested: "}
                          {s.techName} · {fmtTime(new Date(s.whenIso))}
                        </div>
                        <div className="mt-0.5 text-slate-600">{s.reasons.join(" · ")}</div>
                        {s.runnerUp ? <div className="mt-0.5 text-[10px] text-slate-400">next best: {s.runnerUp}</div> : null}
                        <div className="mt-1.5 flex gap-1.5">
                          <form action={acceptSuggestion}>
                            <input type="hidden" name="jobId" value={job.id} />
                            <input type="hidden" name="techId" value={s.techId} />
                            <input type="hidden" name="whenIso" value={s.whenIso} />
                            <input type="hidden" name="kind" value={s.kind} />
                            <input type="hidden" name="reasons" value={s.reasons.join("; ")} />
                            <Button type="submit" size="sm">Accept</Button>
                          </form>
                          <form action={dismissSuggestion}>
                            <input type="hidden" name="jobId" value={job.id} />
                            <input type="hidden" name="techId" value={s.techId} />
                            <input type="hidden" name="reasons" value={s.reasons.join("; ")} />
                            <Button type="submit" size="sm" variant="secondary">Dismiss</Button>
                          </form>
                        </div>
                      </div>
                    );
                  })() : null}

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
                {canManage && optimizableTechIds.has(tech.id) ? (
                  <Link
                    href={`/dispatch/optimize?tech=${tech.id}&date=${dateStr}`}
                    className="rounded-md bg-violet-100 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-200"
                    title="Propose a drive-minimizing order for this day (shown as a diff — nothing changes until you apply)"
                  >
                    ✨ Optimize
                  </Link>
                ) : null}
                <Badge tone="blue">{jobsForTech.length}</Badge>
              </div>
              <div className="space-y-2">
                {jobsForTech.length === 0 ? (
                  <EmptyState title="No jobs this day" hint="Assign from the unassigned lane." />
                ) : (
                  jobsForTech.map((job) => {
                    // D3: drive-time chip for the hop LEAVING this job.
                    const hop = (hopsByTech.get(tech.id) ?? []).find((h) => h.fromJobId === job.id);
                    return (
                      <div key={job.id}>
                        {conflictedJobIds.has(job.id) ? (
                          <div className="mb-0.5 rounded-t-md bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                            ⚠️ Overlaps a calendar busy window
                          </div>
                        ) : null}
                        <DispatchJobCard job={job} />
                        {hop && (hop.driveMinutes !== null || hop.status === "overlap") ? (
                          <div
                            className={`mt-1 rounded-md px-2 py-1 text-center text-[11px] font-medium ${
                              hop.status === "impossible" || hop.status === "overlap"
                                ? "bg-red-100 text-red-800"
                                : hop.status === "tight"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-slate-100 text-slate-600"
                            }`}
                            title={driveSource === "routed" ? "Routed drive time (Google Maps)" : "Estimated from straight-line distance"}
                          >
                            {hop.status === "overlap"
                              ? `⛔ Double-booked — next job starts ${-hop.gapMinutes} min before this one ends`
                              : hop.status === "impossible"
                                ? `⛔ Can't make it — ~${hop.driveMinutes} min drive, ${hop.gapMinutes} min gap`
                                : hop.status === "tight"
                                  ? `⚠️ 🚗 ~${hop.driveMinutes} min drive · only ${hop.gapMinutes - hop.driveMinutes!} min slack`
                                  : `🚗 ~${hop.driveMinutes} min drive · ${hop.gapMinutes} min gap`}
                            {driveSource === "estimate" && hop.status !== "overlap" ? " · est." : ""}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* D3: day map — self-contained SVG, one color per tech, stops in visit order */}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="🗺️ Day map"
            subtitle={`Stops in visit order, one color per tech${impossibleCount > 0 ? ` · ⛔ ${impossibleCount} impossible back-to-back${impossibleCount > 1 ? "s" : ""}` : ""}`}
          />
          <CardBody>
            <DayMap stops={mapStops} techs={techs.map((t2) => t2.name)} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Drive times"
            subtitle={driveSource === "routed" ? "Routed via Google Maps" : "Estimated from straight-line distance — connect Google Maps in Settings for routed times"}
          />
          <CardBody className="text-sm text-slate-600">
            <p>
              Chips between jobs show the drive to the next stop and the scheduled gap.
              <span className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px]">🚗 ok</span>
              <span className="mx-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">⚠️ tight</span>
              <span className="mx-1 rounded bg-red-100 px-1.5 py-0.5 text-[11px] text-red-800">⛔ impossible</span>
            </p>
            <p className="mt-2 text-xs text-slate-500">
              An <b>impossible</b> hop means the next job starts before the tech can physically arrive — reschedule
              one side or reassign. Warnings never block; you stay in charge.
            </p>
          </CardBody>
        </Card>
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
