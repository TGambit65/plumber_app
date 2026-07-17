import Link from "next/link";
import { notFound } from "next/navigation";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { asc, and, desc, eq, ne } from "drizzle-orm";
import { fmtDate, fmtDateTime, fmtTime, money, timeAgo, lineTotal } from "@/lib/format";
import {
  advanceJobStatus,
  addJobPhoto,
  completeJobForm,
  addMaterialUsage,
  createPartRequest,
  flagOpportunity,
} from "@/lib/actions/field";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  LinkButton,
  Select,
  Textarea,
  buttonClass,
  estimateStatusTone,
  invoiceStatusTone,
  jobStatusTone,
  statusLabel,
  type BadgeTone,
} from "@/components/ui";
import { PropertyChips } from "@/components/field/property-chips";

export const dynamic = "force-dynamic";

const priorityTone: Record<string, BadgeTone> = {
  LOW: "slate",
  NORMAL: "slate",
  HIGH: "amber",
  EMERGENCY: "red",
};

const NEXT_STEP: Record<string, { to: string; label: string } | undefined> = {
  SCHEDULED: { to: "DISPATCHED", label: "📋 Mark dispatched" },
  DISPATCHED: { to: "EN_ROUTE", label: "🚗 On my way — sends text" },
  EN_ROUTE: { to: "IN_PROGRESS", label: "▶️ Arrived — start work" },
};

const PHOTO_KINDS = ["BEFORE", "DURING", "AFTER", "PROBLEM", "COVERUP"] as const;

const activityIcon: Record<string, string> = {
  CALL: "📞",
  SMS: "💬",
  EMAIL: "✉️",
  NOTE: "📝",
  STATUS: "🔄",
  SYSTEM: "⚙️",
  ESTIMATE_VIEW: "👀",
  PAYMENT: "💳",
  REVIEW: "⭐",
};

function equipmentAge(installedAt: Date | null): string | null {
  if (!installedAt) return null;
  const months = Math.floor((Date.now() - new Date(installedAt).getTime()) / (1000 * 60 * 60 * 24 * 30.44));
  if (months < 12) return `${months} mo old`;
  const years = Math.floor(months / 12);
  return `${years} yr${years === 1 ? "" : "s"} old`;
}

export default async function JobDetailPage({ params }: { params: { id: string } }) {
  const session = await requireSession();

  const data = await withTenant(session.organizationId, async (tx) => {
    const job = await tx.query.jobs.findFirst({
      where: eq(t.jobs.id, params.id),
      with: {
        customer: { with: { membership: true } },
        property: { with: { equipment: true } },
        assignedTo: true,
        photos: { with: { takenBy: true }, orderBy: asc(t.jobPhotos.takenAt) },
        forms: { orderBy: asc(t.jobForms.name) },
        timeEntries: { with: { user: true }, orderBy: asc(t.timeEntries.startedAt) },
        estimates: true,
        invoices: { with: { items: true } },
        materials: { with: { priceBookItem: true }, orderBy: asc(t.materialUsages.usedAt) },
        activities: { with: { user: true }, orderBy: desc(t.activities.createdAt) },
      },
    });
    if (!job) return null;

    const [priorJobs, priceBook] = await Promise.all([
      tx.query.jobs.findMany({
        where: and(eq(t.jobs.propertyId, job.propertyId), ne(t.jobs.id, job.id)),
        orderBy: desc(t.jobs.createdAt),
        limit: 6,
      }),
      tx
        .select()
        .from(t.priceBookItems)
        .where(eq(t.priceBookItems.active, true))
        .orderBy(asc(t.priceBookItems.category), asc(t.priceBookItems.name)),
    ]);
    return { job, priorJobs, priceBook };
  });
  if (!data) notFound();
  const { job, priorJobs, priceBook } = data;

  const next = NEXT_STEP[job.status];
  const mapsHref = `https://maps.google.com/?q=${encodeURIComponent(
    `${job.property.address}, ${job.property.city}, ${job.property.state} ${job.property.zip}`
  )}`;
  const photosByKind = PHOTO_KINDS.map((k) => ({ kind: k, photos: job.photos.filter((p) => p.kind === k) })).filter(
    (g) => g.photos.length > 0
  );

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900">
              {job.number} — {job.jobType}
            </h1>
            <Badge tone={jobStatusTone[job.status]}>{statusLabel(job.status)}</Badge>
            {job.priority !== "NORMAL" ? (
              <Badge tone={priorityTone[job.priority]}>
                {job.priority === "EMERGENCY" ? "🚨 " : ""}
                {statusLabel(job.priority)}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {job.scheduledAt ? `${fmtDate(job.scheduledAt)} ${fmtTime(job.scheduledAt)}` : "Unscheduled"}
            {job.scheduledEnd ? ` – ${fmtTime(job.scheduledEnd)}` : ""}
            {job.assignedTo ? ` · Assigned: ${job.assignedTo.name}` : " · Unassigned"}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          {job.status === "IN_PROGRESS" ? (
            <LinkButton href={`/jobs/${job.id}/closeout`} variant="success" size="lg" className="w-full sm:w-auto">
              ✅ Start closeout →
            </LinkButton>
          ) : next ? (
            <form action={advanceJobStatus} className="w-full sm:w-auto">
              <input type="hidden" name="jobId" value={job.id} />
              <input type="hidden" name="to" value={next.to} />
              <button type="submit" className={buttonClass("primary", "lg", "w-full sm:w-auto")}>
                {next.label}
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── Main column ── */}
        <div className="space-y-4 lg:col-span-2">
          {/* Description & notes */}
          <Card>
            <CardHeader title="Description & internal notes" />
            <CardBody className="space-y-3">
              <p className="text-sm text-slate-700">{job.description ?? "No description."}</p>
              {job.internalNotes ? (
                <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-100">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700">Internal notes</div>
                  <p className="whitespace-pre-wrap">{job.internalNotes}</p>
                </div>
              ) : null}
            </CardBody>
          </Card>

          {/* Photos */}
          <Card>
            <CardHeader title={`Photos (${job.photos.length})`} subtitle="Before / during / after / problems / cover-up" />
            <CardBody className="space-y-4">
              {photosByKind.length === 0 ? (
                <EmptyState title="No photos yet" hint="Capture BEFORE photos before touching anything." />
              ) : (
                photosByKind.map((group) => (
                  <div key={group.kind}>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {statusLabel(group.kind)} ({group.photos.length})
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {group.photos.map((p) => (
                        <figure key={p.id} className="overflow-hidden rounded-lg border border-slate-200">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p.url} alt={p.caption ?? group.kind} className="h-28 w-full bg-slate-100 object-cover" />
                          <figcaption className="px-2 py-1.5 text-[11px] text-slate-500">
                            {p.caption ?? "—"} · {p.takenBy.name.split(" ")[0]}, {fmtTime(p.takenAt)}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  </div>
                ))
              )}
              <form action={addJobPhoto} className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-4">
                <input type="hidden" name="jobId" value={job.id} />
                <Field label="Kind">
                  <Select name="kind" defaultValue="DURING">
                    {PHOTO_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {statusLabel(k)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Caption">
                  <Input name="caption" placeholder="What's in the shot?" />
                </Field>
                <Field label="Photo URL (camera simulated)">
                  <Input name="url" defaultValue="/demo-photos/wh-before.svg" />
                </Field>
                <div className="flex items-end">
                  <button type="submit" className={buttonClass("secondary", "lg", "w-full")}>
                    📷 Add photo
                  </button>
                </div>
              </form>
            </CardBody>
          </Card>

          {/* Forms */}
          <Card>
            <CardHeader title="Job forms" subtitle="Required forms block job completion" />
            <CardBody className="space-y-3">
              {job.forms.length === 0 ? (
                <EmptyState title="No forms attached to this job" />
              ) : (
                job.forms.map((f) => (
                  <div key={f.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-slate-900">{f.name}</span>
                      {f.required ? <Badge tone="red">Required</Badge> : <Badge>Optional</Badge>}
                      {f.completedAt ? (
                        <Badge tone="green">✓ Completed {fmtDateTime(f.completedAt)}</Badge>
                      ) : (
                        <Badge tone="amber">Incomplete</Badge>
                      )}
                    </div>
                    {f.completedAt && f.data ? (
                      <p className="mt-2 text-xs text-slate-500">
                        {typeof f.data === "object" && f.data && "note" in (f.data as Record<string, unknown>)
                          ? String((f.data as Record<string, unknown>).note)
                          : JSON.stringify(f.data)}
                      </p>
                    ) : null}
                    {!f.completedAt ? (
                      <form action={completeJobForm} className="mt-3 space-y-2">
                        <input type="hidden" name="formId" value={f.id} />
                        <Textarea name="note" rows={2} placeholder="Findings / readings / checklist notes…" />
                        <button type="submit" className={buttonClass("secondary", "lg", "w-full sm:w-auto")}>
                          ✓ Complete form
                        </button>
                      </form>
                    ) : null}
                  </div>
                ))
              )}
            </CardBody>
          </Card>

          {/* Materials */}
          <Card>
            <CardHeader title="Materials used" subtitle="Adding a part auto-decrements your truck stock" />
            <CardBody className="space-y-3">
              {job.materials.length === 0 ? (
                <EmptyState title="No materials logged yet" />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {job.materials.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="text-slate-800">
                        {m.qty} × {m.priceBookItem.name}
                      </span>
                      <span className="tabular-nums text-slate-500">
                        {money(Math.round(m.qty * m.priceBookItem.unitPriceCents))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <form action={addMaterialUsage} className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-[1fr_6rem_auto]">
                <input type="hidden" name="jobId" value={job.id} />
                <Field label="Price book item">
                  <Select name="priceBookItemId">
                    {priceBook.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.category} — {i.name} ({money(i.unitPriceCents)})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Qty">
                  <Input name="qty" type="number" step="0.5" min="0.5" defaultValue="1" />
                </Field>
                <div className="flex items-end">
                  <button type="submit" className={buttonClass("secondary", "lg", "w-full")}>
                    ＋ Add
                  </button>
                </div>
              </form>
            </CardBody>
          </Card>

          {/* Time entries */}
          <Card>
            <CardHeader title="Time on this job" />
            <CardBody>
              {job.timeEntries.length === 0 ? (
                <EmptyState title="No time logged yet" hint="Clocks start automatically from status buttons." />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {job.timeEntries.map((te) => {
                    const end = te.endedAt ?? new Date();
                    const mins = Math.max(1, Math.round((end.getTime() - te.startedAt.getTime()) / 60000));
                    return (
                      <li key={te.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span className="text-slate-800">
                          {te.kind === "TRAVEL" ? "🚗 Travel" : "🔧 Work"} · {te.user.name.split(" ")[0]} ·{" "}
                          {fmtTime(te.startedAt)}
                          {te.endedAt ? ` – ${fmtTime(te.endedAt)}` : ""}
                        </span>
                        {te.endedAt ? (
                          <span className="tabular-nums text-slate-500">
                            {Math.floor(mins / 60) > 0 ? `${Math.floor(mins / 60)}h ` : ""}
                            {mins % 60}m
                          </span>
                        ) : (
                          <Badge tone="green">Running</Badge>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          {/* Flag opportunity */}
          <Card className="border-amber-200">
            <CardHeader
              title="⚠ Flag opportunity for sales"
              subtitle="See something worth quoting? Flag it — $50 spiff when it becomes a lead, more if it sells."
            />
            <CardBody>
              <form action={flagOpportunity} className="space-y-3">
                <input type="hidden" name="jobId" value={job.id} />
                <Field label="Opportunity title">
                  <Input name="title" required placeholder="e.g. Water softener — heavy scaling on fixtures" />
                </Field>
                <Field label="What did you see?">
                  <Textarea name="description" rows={2} placeholder="Details for the sales team…" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Est. value ($)">
                    <Input name="estValue" type="number" min="0" step="50" placeholder="1650" />
                  </Field>
                  <div className="flex items-end">
                    <button type="submit" className={buttonClass("primary", "lg", "w-full")}>
                      🚩 Flag it
                    </button>
                  </div>
                </div>
              </form>
            </CardBody>
          </Card>

          {/* Activity */}
          <Card>
            <CardHeader title="Activity timeline" />
            <CardBody>
              {job.activities.length === 0 ? (
                <EmptyState title="No activity yet" />
              ) : (
                <ul className="space-y-3">
                  {job.activities.map((a) => (
                    <li key={a.id} className="flex gap-3 text-sm">
                      <span className="mt-0.5">{activityIcon[a.kind] ?? "•"}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-slate-800">{a.body}</p>
                        <p className="text-xs text-slate-400">
                          {a.user ? `${a.user.name} · ` : ""}
                          {timeAgo(a.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        {/* ── Side column ── */}
        <div className="space-y-4">
          {/* Customer & property */}
          <Card>
            <CardHeader
              title="Customer & property"
              action={job.customer.membership ? <Badge tone="violet">★ {job.customer.membership.plan}</Badge> : undefined}
            />
            <CardBody className="space-y-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">{job.customer.name}</div>
                {job.customer.company ? <div className="text-xs text-slate-500">{job.customer.company}</div> : null}
              </div>
              {job.customer.phone ? (
                <a
                  href={`tel:${job.customer.phone}`}
                  className={buttonClass("secondary", "lg", "w-full")}
                >
                  📞 Call {job.customer.phone}
                </a>
              ) : (
                <Badge tone="amber">⚠ No mobile number — SMS will fail</Badge>
              )}
              <a
                href={mapsHref}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm font-medium text-blue-600 hover:text-blue-800"
              >
                🧭 {job.property.label ? `${job.property.label} — ` : ""}
                {job.property.address}, {job.property.city}, {job.property.state} {job.property.zip}
              </a>
              <PropertyChips property={job.property} />
              {job.customer.notes ? <p className="text-xs text-slate-500">{job.customer.notes}</p> : null}
            </CardBody>
          </Card>

          {/* Equipment */}
          <Card>
            <CardHeader title="Equipment at property" subtitle="Service history at the door" />
            <CardBody>
              {job.property.equipment.length === 0 ? (
                <EmptyState title="No equipment on record" />
              ) : (
                <ul className="space-y-3">
                  {job.property.equipment.map((eq) => (
                    <li key={eq.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">{eq.kind}</span>
                        {equipmentAge(eq.installedAt) ? <Badge>{equipmentAge(eq.installedAt)}</Badge> : null}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {[eq.brand, eq.model].filter(Boolean).join(" ")}
                        {eq.serial ? ` · S/N ${eq.serial}` : ""}
                      </div>
                      {eq.notes ? <p className="mt-1 text-xs text-slate-600">{eq.notes}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {/* Prior jobs */}
          <Card>
            <CardHeader title="Prior jobs at this property" />
            <CardBody>
              {priorJobs.length === 0 ? (
                <EmptyState title="First visit to this property" />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {priorJobs.map((pj) => (
                    <li key={pj.id}>
                      <Link href={`/jobs/${pj.id}`} className="flex min-h-[44px] items-center justify-between gap-2 py-2 text-sm hover:text-blue-700">
                        <span className="min-w-0 truncate">
                          <span className="font-medium">{pj.number}</span> · {pj.jobType}
                          <span className="text-xs text-slate-400"> · {fmtDate(pj.scheduledAt ?? pj.createdAt)}</span>
                        </span>
                        <Badge tone={jobStatusTone[pj.status]}>{statusLabel(pj.status)}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {/* Estimates & invoices */}
          <Card>
            <CardHeader title="Estimates & invoices" />
            <CardBody className="space-y-2">
              {job.estimates.length === 0 && job.invoices.length === 0 ? (
                <EmptyState title="Nothing linked yet" hint="An invoice is generated during closeout." />
              ) : (
                <>
                  {job.estimates.map((e) => (
                    <Link key={e.id} href="/estimates" className="flex min-h-[44px] items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                      <span>📝 {e.number}</span>
                      <Badge tone={estimateStatusTone[e.status]}>{statusLabel(e.status)}</Badge>
                    </Link>
                  ))}
                  {job.invoices.map((inv) => (
                    <Link key={inv.id} href="/invoices" className="flex min-h-[44px] items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                      <span>
                        🧾 {inv.number} · {money(lineTotal(inv.items))}
                      </span>
                      <Badge tone={invoiceStatusTone[inv.status]}>{statusLabel(inv.status)}</Badge>
                    </Link>
                  ))}
                </>
              )}
            </CardBody>
          </Card>

          {/* Part request */}
          <Card>
            <CardHeader title="Request a part" subtitle="Goes straight to the office — no phone call" />
            <CardBody>
              <form action={createPartRequest} className="space-y-3">
                <input type="hidden" name="jobId" value={job.id} />
                <Field label="What do you need?">
                  <Input name="description" required placeholder='e.g. 3/4" PRV — none on truck' />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Qty">
                    <Input name="qty" type="number" min="1" defaultValue="1" />
                  </Field>
                  <div className="flex items-end">
                    <button type="submit" className={buttonClass("secondary", "lg", "w-full")}>
                      🧰 Request
                    </button>
                  </div>
                </div>
              </form>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
