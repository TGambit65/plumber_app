import Link from "next/link";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { asc, desc, eq } from "drizzle-orm";
import {
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
  Table,
  TCell,
  Textarea,
  THead,
  TRow,
  type BadgeTone,
} from "@/components/ui";
import { fmtDate, fmtDateTime, timeAgo } from "@/lib/format";
import { clsx } from "@/lib/clsx";
import {
  addCertification,
  cancelInspection,
  createTemplate,
  reopenInspection,
  rescheduleInspection,
  revokeCertification,
  toggleTemplateActive,
  updateCertification,
  updateTemplate,
  runRenewalSweep,
  scheduleInspection,
} from "@/lib/actions/compliance";
import type { InspectionStep } from "@/components/compliance/types";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

const inspectionStatusTone: Record<string, BadgeTone> = {
  SCHEDULED: "blue",
  IN_PROGRESS: "amber",
  PASSED: "green",
  FAILED: "red",
  CANCELLED: "slate",
};

const STATUSES = ["SCHEDULED", "IN_PROGRESS", "PASSED", "FAILED", "CANCELLED"] as const;
type InspStatus = (typeof STATUSES)[number];

function statusLabel(s: string) {
  return s.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

type CertRow = typeof t.certifications.$inferSelect & {
  user: typeof t.users.$inferSelect | null;
  equipmentRef: typeof t.equipment.$inferSelect | null;
  sourceInspection: typeof t.inspections.$inferSelect | null;
};

function holderLabel(cert: CertRow): string {
  if (cert.holderType === "USER") return cert.user ? cert.user.name : "Unassigned user";
  if (cert.holderType === "EQUIPMENT")
    return cert.equipmentRef
      ? `${cert.equipmentRef.kind}${cert.equipmentRef.brand ? ` · ${cert.equipmentRef.brand}` : ""}${cert.equipmentRef.model ? ` ${cert.equipmentRef.model}` : ""}`
      : "Equipment";
  return "Organization";
}

/** red = expired, amber = ≤21 days out, slate otherwise */
function expiryClass(expiresAt: Date | null, now: Date): string {
  if (!expiresAt) return "text-slate-500";
  if (expiresAt <= now) return "font-semibold text-red-600";
  if (expiresAt.getTime() - now.getTime() <= 21 * DAY_MS) return "font-semibold text-amber-600";
  return "text-slate-700";
}

function expiryHint(expiresAt: Date, now: Date): string {
  const days = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
  if (days < 0) return `expired ${Math.abs(days)}d ago`;
  if (days === 0) return "expires today";
  return `${days}d left`;
}

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: { status?: string; swept?: string; notified?: string; skipped?: string };
}) {
  const session = await requireSession();
  if (!can(session.role, "compliance.manage")) {
    return (
      <EmptyState
        title="403 — Compliance center is for office & admin"
        hint="Techs run assigned inspections from their notification links or My Day."
      />
    );
  }

  const now = new Date();
  const statusFilter = STATUSES.includes(searchParams.status as InspStatus)
    ? (searchParams.status as InspStatus)
    : undefined;

  const data = await withTenant(session.organizationId, async (tx) => {
    const inspections = await tx.query.inspections.findMany({
      with: { template: true, job: true, property: true, equipmentRef: true, inspector: true },
      orderBy: [desc(t.inspections.createdAt)],
    });
    const templates = await tx.query.inspectionTemplates.findMany({
      orderBy: [asc(t.inspectionTemplates.name)],
    });
    const certs = (await tx.query.certifications.findMany({
      with: { user: true, equipmentRef: true, sourceInspection: true },
      orderBy: [asc(t.certifications.expiresAt)],
    })) as CertRow[];
    const users = await tx
      .select()
      .from(t.users)
      .where(eq(t.users.active, true))
      .orderBy(asc(t.users.name));
    const jobs = await tx.query.jobs.findMany({
      with: { customer: true },
      orderBy: [desc(t.jobs.createdAt)],
      limit: 60,
    });
    const properties = await tx.query.properties.findMany({
      with: { customer: true },
      orderBy: [asc(t.properties.address)],
    });
    const equipmentRows = await tx.query.equipment.findMany({ with: { property: true } });
    // Enabled trade packs (constraint 1 — compose only enabled packs).
    const enabledPacks = await tx
      .select({ key: t.tradePacks.key, name: t.tradePacks.name })
      .from(t.organizationTradePacks)
      .innerJoin(t.tradePacks, eq(t.organizationTradePacks.tradePackId, t.tradePacks.id))
      .where(eq(t.organizationTradePacks.organizationId, session.organizationId));
    return { inspections, templates, certs, users, jobs, properties, equipmentRows, enabledPacks };
  });

  const { inspections, templates, certs, users, jobs, properties, equipmentRows, enabledPacks } = data;

  // ── Stats ──
  const openInspections = inspections.filter((i) => i.status === "SCHEDULED" || i.status === "IN_PROGRESS");
  const ninetyDaysAgo = new Date(now.getTime() - 90 * DAY_MS);
  const completed90 = inspections.filter(
    (i) => (i.status === "PASSED" || i.status === "FAILED") && i.completedAt && i.completedAt >= ninetyDaysAgo
  );
  const passed90 = completed90.filter((i) => i.status === "PASSED").length;
  const passRate = completed90.length > 0 ? Math.round((passed90 / completed90.length) * 100) : null;
  const activeCerts = certs.filter((c) => !c.expiresAt || c.expiresAt > now);
  const expiredCerts = certs.filter((c) => c.expiresAt && c.expiresAt <= now);
  const expiringSoon = certs.filter(
    (c) => c.expiresAt && c.expiresAt > now && c.expiresAt.getTime() - now.getTime() <= 60 * DAY_MS
  );
  // Expiring panel: within 60 days OR already past, soonest (most overdue) first.
  const expiringPanel = certs
    .filter((c) => c.expiresAt && c.expiresAt.getTime() - now.getTime() <= 60 * DAY_MS)
    .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime());

  const filteredInspections = statusFilter ? inspections.filter((i) => i.status === statusFilter) : inspections;

  return (
    <div>
      <PageHeader
        title="✅ Compliance Center"
        subtitle="Inspections, certifications & renewals — the core engine trade packs specialize via templates"
      />

      {searchParams.swept ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          Renewal sweep complete — {searchParams.notified ?? 0} certification
          {(searchParams.notified ?? "0") === "1" ? "" : "s"} notified, {searchParams.skipped ?? 0} skipped (already
          notified within 14 days).
        </div>
      ) : null}

      {/* ── Stat row ── */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Open inspections"
          value={openInspections.length}
          hint={`${openInspections.filter((i) => i.status === "IN_PROGRESS").length} in progress`}
        />
        <Stat
          label="Pass rate (90d)"
          value={passRate === null ? "—" : `${passRate}%`}
          hint={`${passed90}/${completed90.length} completed passed`}
          tone={passRate === null ? "default" : passRate >= 90 ? "good" : passRate >= 70 ? "warn" : "bad"}
        />
        <Stat label="Active certifications" value={activeCerts.length} hint="unexpired or non-expiring" />
        <Stat
          label="Expiring ≤60d"
          value={expiringSoon.length}
          hint={
            expiredCerts.length > 0 ? (
              <span className="font-semibold text-red-600">{expiredCerts.length} already expired</span>
            ) : (
              "none expired"
            )
          }
          tone={expiredCerts.length > 0 ? "bad" : expiringSoon.length > 0 ? "warn" : "good"}
        />
      </div>

      {/* ── Expiring soon panel ── */}
      <Card className="mb-6">
        <CardHeader
          title="⏰ Expiring soon"
          subtitle="Certifications expiring within 60 days (or already lapsed) — soonest first"
          action={
            <form action={runRenewalSweep}>
              <Button type="submit" variant="secondary" size="sm">
                🔔 Run renewal sweep
              </Button>
            </form>
          }
        />
        <CardBody>
          {expiringPanel.length === 0 ? (
            <EmptyState title="Nothing expiring in the next 60 days" hint="Renewals are under control. 🎉" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {expiringPanel.map((cert) => {
                const expired = cert.expiresAt! <= now;
                const within21 = !expired && cert.expiresAt!.getTime() - now.getTime() <= 21 * DAY_MS;
                return (
                  <li key={cert.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-900">{cert.name}</span>
                        {expired ? (
                          <Badge tone="red">Expired</Badge>
                        ) : within21 ? (
                          <Badge tone="amber">≤21 days</Badge>
                        ) : (
                          <Badge tone="slate">≤60 days</Badge>
                        )}
                      </div>
                      <div className="text-xs text-slate-500">
                        {holderLabel(cert)}
                        {cert.certificateNumber ? ` · #${cert.certificateNumber}` : ""}
                        {cert.renewalNotifiedAt ? ` · notified ${timeAgo(cert.renewalNotifiedAt)}` : ""}
                      </div>
                    </div>
                    <div className={clsx("text-sm tabular-nums", expiryClass(cert.expiresAt, now))}>
                      {fmtDate(cert.expiresAt)}{" "}
                      <span className="text-xs font-normal">({expiryHint(cert.expiresAt!, now)})</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* ── Inspections ── */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">🔍 Inspections</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <Link
            href="/compliance"
            className={clsx(
              "rounded-full border px-3 py-1 text-xs font-medium",
              !statusFilter
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            )}
          >
            All ({inspections.length})
          </Link>
          {STATUSES.map((s) => (
            <Link
              key={s}
              href={`/compliance?status=${s}`}
              className={clsx(
                "rounded-full border px-3 py-1 text-xs font-medium",
                statusFilter === s
                  ? "border-blue-600 bg-blue-600 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
              )}
            >
              {statusLabel(s)} ({inspections.filter((i) => i.status === s).length})
            </Link>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardBody className="p-0">
              {filteredInspections.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    title={statusFilter ? `No ${statusLabel(statusFilter).toLowerCase()} inspections` : "No inspections yet"}
                    hint="Schedule one from the form — the assigned inspector gets notified."
                  />
                </div>
              ) : (
                <Table>
                  <THead cols={["Inspection", "Target", "Inspector", "Status", "Scheduled", "Completed", ""]} />
                  <tbody>
                    {filteredInspections.map((insp) => {
                      const target = insp.job
                        ? `${insp.job.number} · ${insp.job.jobType}`
                        : insp.property
                          ? insp.property.address
                          : insp.equipmentRef
                            ? `${insp.equipmentRef.kind}${insp.equipmentRef.brand ? ` (${insp.equipmentRef.brand})` : ""}`
                            : "—";
                      return (
                        <TRow key={insp.id}>
                          <TCell>
                            <Link
                              href={`/compliance/inspections/${insp.id}`}
                              className="font-medium text-blue-700 hover:underline"
                            >
                              {insp.template.name}
                            </Link>
                          </TCell>
                          <TCell>{target}</TCell>
                          <TCell>{insp.inspector?.name ?? "—"}</TCell>
                          <TCell>
                            <Badge tone={inspectionStatusTone[insp.status] ?? "slate"}>{statusLabel(insp.status)}</Badge>
                          </TCell>
                          <TCell className="whitespace-nowrap">{fmtDateTime(insp.scheduledAt)}</TCell>
                          <TCell className="whitespace-nowrap">{fmtDateTime(insp.completedAt)}</TCell>
                          <TCell>
                            <div className="flex flex-wrap items-start gap-1.5">
                              {insp.status === "SCHEDULED" || insp.status === "IN_PROGRESS" ? (
                                <>
                                  {/* M4: move the appointment or hand it to another inspector */}
                                  <details>
                                    <summary className="cursor-pointer rounded px-1.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50">📅 Reschedule…</summary>
                                    <form action={rescheduleInspection} className="mt-2 w-56 space-y-1.5 rounded-lg border border-slate-200 p-2">
                                      <input type="hidden" name="inspectionId" value={insp.id} />
                                      <Input type="datetime-local" name="scheduledAt" required aria-label="New time" className="h-8 text-xs" />
                                      <Select name="inspectorId" defaultValue={insp.inspectorId ?? ""} aria-label="Inspector" className="h-8 text-xs">
                                        <option value="">Unassigned</option>
                                        {users.map((u) => (
                                          <option key={u.id} value={u.id}>{u.name}</option>
                                        ))}
                                      </Select>
                                      <Button type="submit" size="sm" variant="secondary">Save</Button>
                                    </form>
                                  </details>
                                  <form action={cancelInspection}>
                                    <input type="hidden" name="inspectionId" value={insp.id} />
                                    <Button type="submit" variant="ghost" size="sm">
                                      Cancel
                                    </Button>
                                  </form>
                                </>
                              ) : null}
                              {insp.status === "CANCELLED" ? (
                                <form action={reopenInspection}>
                                  <input type="hidden" name="inspectionId" value={insp.id} />
                                  <Button type="submit" variant="secondary" size="sm" title="Puts the inspection back on the schedule">
                                    ♻️ Reopen
                                  </Button>
                                </form>
                              ) : null}
                            </div>
                          </TCell>
                        </TRow>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="📅 Schedule inspection" subtitle="Pick a template, target & inspector" />
            <CardBody>
              <form action={scheduleInspection} className="space-y-3">
                <Field label="Template">
                  <Select name="templateId" required defaultValue="">
                    <option value="" disabled>
                      Choose template…
                    </option>
                    {templates
                      .filter((tpl) => tpl.active)
                      .map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Job (optional)">
                  <Select name="jobId" defaultValue="">
                    <option value="">— none —</option>
                    {jobs.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.number} · {j.jobType} ({j.customer.name})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Property (optional)">
                  <Select name="propertyId" defaultValue="">
                    <option value="">— none —</option>
                    {properties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.address}, {p.city} ({p.customer.name})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Equipment (optional)">
                  <Select name="equipmentId" defaultValue="">
                    <option value="">— none —</option>
                    {equipmentRows.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.kind}
                        {e.brand ? ` · ${e.brand}` : ""} @ {e.property.address}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Inspector">
                  <Select name="inspectorId" required defaultValue="">
                    <option value="" disabled>
                      Choose inspector…
                    </option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.role})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Scheduled for">
                  <Input type="datetime-local" name="scheduledAt" required />
                </Field>
                <Button type="submit" className="w-full">
                  Schedule inspection
                </Button>
              </form>
            </CardBody>
          </Card>
        </div>
      </section>

      {/* ── Templates ── */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">📋 Templates</h2>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="grid content-start gap-3 sm:grid-cols-2 lg:col-span-2">
            {templates.length === 0 ? (
              <div className="sm:col-span-2">
                <EmptyState title="No templates yet" hint="Create one — trade packs specialize the engine via templates." />
              </div>
            ) : (
              templates.map((tpl) => {
                const steps = (tpl.steps as InspectionStep[]) ?? [];
                const pack = enabledPacks.find((p) => p.key === tpl.tradePackKey);
                return (
                  <Card key={tpl.id} className="h-full">
                    <CardBody className="flex h-full flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {tpl.tradePackKey ? (
                          <Badge tone="violet">🔧 {pack ? pack.key : tpl.tradePackKey} pack</Badge>
                        ) : (
                          <Badge tone="slate">core</Badge>
                        )}
                        {!tpl.active ? <Badge tone="red">inactive</Badge> : null}
                      </div>
                      <h3 className="text-sm font-semibold text-slate-900">{tpl.name}</h3>
                      {tpl.description ? <p className="text-xs text-slate-500">{tpl.description}</p> : null}
                      <div className="mt-auto space-y-1 pt-1 text-xs text-slate-500">
                        <div>
                          {steps.length} step{steps.length === 1 ? "" : "s"} ·{" "}
                          {steps.filter((s) => s.required).length} required
                        </div>
                        {tpl.issuesCertification ? (
                          <div className="text-emerald-700">
                            🎓 Passing issues “{tpl.issuesCertification}”
                            {tpl.certValidityDays ? ` (valid ${tpl.certValidityDays} days)` : ""}
                          </div>
                        ) : null}
                      </div>
                      {/* M4: template management — edit + deactivate */}
                      <div className="flex flex-wrap items-start gap-1.5 border-t border-slate-100 pt-2">
                        <details className="min-w-0 flex-1">
                          <summary className="cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50">✏️ Edit template</summary>
                          <form action={updateTemplate} className="mt-2 space-y-1.5">
                            <input type="hidden" name="templateId" value={tpl.id} />
                            <Input name="name" required defaultValue={tpl.name} aria-label="Name" className="h-8 text-xs" />
                            <Input name="description" defaultValue={tpl.description ?? ""} placeholder="Description" aria-label="Description" className="h-8 text-xs" />
                            <Textarea name="steps" rows={4} placeholder="Leave blank to keep the current steps — or paste new kind|label|required?|unit? lines" aria-label="Steps" className="text-xs" />
                            <div className="flex gap-1.5">
                              <Input name="issuesCertification" defaultValue={tpl.issuesCertification ?? ""} placeholder="Issues cert" aria-label="Issues certification" className="h-8 flex-1 text-xs" />
                              <Input name="certValidityDays" type="number" min={1} defaultValue={tpl.certValidityDays ?? ""} placeholder="days" aria-label="Cert validity days" className="h-8 w-20 text-xs" />
                            </div>
                            <Button type="submit" size="sm" variant="secondary">Save template</Button>
                          </form>
                        </details>
                        <form action={toggleTemplateActive}>
                          <input type="hidden" name="templateId" value={tpl.id} />
                          <input type="hidden" name="next" value={String(!tpl.active)} />
                          <button type="submit" className="rounded px-1.5 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100" title={tpl.active ? "Retire — stops new inspections; history untouched" : "Reactivate"}>
                            {tpl.active ? "🚫 Deactivate" : "♻️ Reactivate"}
                          </button>
                        </form>
                      </div>
                    </CardBody>
                  </Card>
                );
              })
            )}
          </div>

          <Card>
            <CardHeader title="🆕 New template" subtitle="Core engine — assign to an enabled trade pack to specialize" />
            <CardBody>
              <form action={createTemplate} className="space-y-3">
                <Field label="Name">
                  <Input name="name" required placeholder="Backflow Prevention Assembly Test" />
                </Field>
                <Field label="Trade pack">
                  <Select name="tradePackKey" defaultValue="">
                    <option value="">Core (all trades)</option>
                    {enabledPacks.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name} ({p.key})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Description (optional)">
                  <Input name="description" placeholder="Annual RPZ/DCVA test per water authority" />
                </Field>
                <div>
                  <Field label="Steps — one per line: kind|label|required?|unit?">
                    <Textarea
                      name="steps"
                      rows={6}
                      required
                      placeholder={
                        "check|Shutoff valves hold|required\nmeasurement|Relief valve opening point|required|PSID\nphoto|Gauge readings photo|required\nnote|Conditions noted|optional"
                      }
                    />
                  </Field>
                  <p className="mt-1 text-[11px] leading-4 text-slate-400">
                    kind is one of <code>check</code>, <code>measurement</code>, <code>photo</code>, <code>note</code>.
                    Third field: <code>required</code> or <code>optional</code> (blank = optional). Fourth field: unit
                    for measurements (e.g. PSID, °F). Lines starting with # are ignored.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Issues certification (optional)">
                    <Input name="issuesCertification" placeholder="Backflow Test Certificate" />
                  </Field>
                  <Field label="Cert validity (days)">
                    <Input name="certValidityDays" type="number" min={1} placeholder="365" />
                  </Field>
                </div>
                <Button type="submit" className="w-full">
                  Create template
                </Button>
              </form>
            </CardBody>
          </Card>
        </div>
      </section>

      {/* ── Certifications ── */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">🎓 Certifications</h2>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardBody className="p-0">
              {certs.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    title="No certifications on file"
                    hint="Add licenses & certs manually, or let passing inspections issue them automatically."
                  />
                </div>
              ) : (
                <Table>
                  <THead cols={["Certification", "Holder", "Cert #", "Authority", "Issued", "Expires", "Source"]} />
                  <tbody>
                    {certs.map((cert) => (
                      <TRow key={cert.id}>
                        <TCell className="font-medium text-slate-900">{cert.name}</TCell>
                        <TCell>{holderLabel(cert)}</TCell>
                        <TCell className="tabular-nums">{cert.certificateNumber ?? "—"}</TCell>
                        <TCell>{cert.issuingAuthority ?? "—"}</TCell>
                        <TCell className="whitespace-nowrap">{fmtDate(cert.issuedAt)}</TCell>
                        <TCell className={clsx("whitespace-nowrap", expiryClass(cert.expiresAt, now))}>
                          {cert.expiresAt ? (
                            <>
                              {fmtDate(cert.expiresAt)}{" "}
                              <span className="text-xs font-normal">({expiryHint(cert.expiresAt, now)})</span>
                            </>
                          ) : (
                            "no expiry"
                          )}
                        </TCell>
                        <TCell>
                          {cert.sourceInspection ? (
                            <Link
                              href={`/compliance/inspections/${cert.sourceInspection.id}`}
                              className="text-xs text-blue-700 hover:underline"
                            >
                              🔍 inspection
                            </Link>
                          ) : (
                            <span className="text-xs text-slate-400">manual</span>
                          )}
                          {/* M4: certification management — edit/renew + revoke */}
                          <div className="mt-1 flex flex-wrap items-start gap-1.5">
                            <details>
                              <summary className="cursor-pointer rounded px-1 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50">✏️ Edit / renew</summary>
                              <form action={updateCertification} className="mt-1.5 w-56 space-y-1.5 rounded-lg border border-slate-200 p-2">
                                <input type="hidden" name="certId" value={cert.id} />
                                <Input name="name" required defaultValue={cert.name} aria-label="Name" className="h-8 text-xs" />
                                <Input name="certificateNumber" defaultValue={cert.certificateNumber ?? ""} placeholder="Cert #" aria-label="Cert number" className="h-8 text-xs" />
                                <Input name="issuingAuthority" defaultValue={cert.issuingAuthority ?? ""} placeholder="Authority" aria-label="Authority" className="h-8 text-xs" />
                                <div className="flex gap-1.5">
                                  <Input type="date" name="issuedAt" defaultValue={cert.issuedAt ? cert.issuedAt.toISOString().slice(0, 10) : ""} aria-label="Issued" className="h-8 flex-1 text-xs" />
                                  <Input type="date" name="expiresAt" defaultValue={cert.expiresAt ? cert.expiresAt.toISOString().slice(0, 10) : ""} aria-label="Expires (set later to renew)" className="h-8 flex-1 text-xs" />
                                </div>
                                <Button type="submit" size="sm" variant="secondary">Save cert</Button>
                              </form>
                            </details>
                            <details>
                              <summary className="cursor-pointer rounded px-1 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50">⛔ Revoke…</summary>
                              <form action={revokeCertification} className="mt-1.5 flex w-48 items-end gap-1.5">
                                <input type="hidden" name="certId" value={cert.id} />
                                <Input name="reason" required placeholder="reason" aria-label="Revocation reason" className="h-8 flex-1 text-xs" />
                                <Button type="submit" size="sm" variant="danger">Go</Button>
                              </form>
                            </details>
                          </div>
                        </TCell>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="➕ Add certification" subtitle="Licenses, operator cards, test certs" />
            <CardBody>
              <form action={addCertification} className="space-y-3">
                <Field label="Name">
                  <Input name="name" required placeholder="Journeyman Plumber License" />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Holder type">
                    <Select name="holderType" defaultValue="USER">
                      <option value="USER">User</option>
                      <option value="ORGANIZATION">Organization</option>
                      <option value="EQUIPMENT">Equipment</option>
                    </Select>
                  </Field>
                  <Field label="User (for user-held certs)">
                    <Select name="userId" defaultValue="">
                      <option value="">— none —</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Equipment (for equipment-held certs)">
                  <Select name="equipmentId" defaultValue="">
                    <option value="">— none —</option>
                    {equipmentRows.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.kind}
                        {e.brand ? ` · ${e.brand}` : ""} @ {e.property.address}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Cert #">
                    <Input name="certificateNumber" placeholder="JP-88213" />
                  </Field>
                  <Field label="Issuing authority">
                    <Input name="issuingAuthority" placeholder="Ohio Dept. of Commerce" />
                  </Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Issued">
                    <Input type="date" name="issuedAt" />
                  </Field>
                  <Field label="Expires">
                    <Input type="date" name="expiresAt" />
                  </Field>
                </div>
                <Button type="submit" className="w-full">
                  Add certification
                </Button>
              </form>
            </CardBody>
          </Card>
        </div>
      </section>
    </div>
  );
}
