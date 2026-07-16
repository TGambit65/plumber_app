import Link from "next/link";
import { notFound } from "next/navigation";
import { db, t } from "@/db";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { fmtDate, fmtDateTime, money, timeAgo } from "@/lib/format";
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
  Textarea,
  jobStatusTone,
  statusLabel,
  type BadgeTone,
} from "@/components/ui";
import {
  BudgetBar,
  Forbidden,
  changeOrderStatusTone,
  milestoneStatusTone,
  permitStatusTone,
} from "@/components/sales/meta";
import {
  addCostEntry,
  addProjectNote,
  addSubcontractor,
  approveChangeOrder,
  createChangeOrder,
  createPermit,
  generateMilestoneInvoice,
  setMilestoneStatus,
  setPermitStatus,
} from "@/lib/actions/sales";
import { clsx } from "@/lib/clsx";

export const dynamic = "force-dynamic";

const projectStatusTone: Record<string, BadgeTone> = {
  PLANNING: "slate",
  ACTIVE: "blue",
  ON_HOLD: "amber",
  COMPLETED: "green",
  CLOSED: "slate",
};

const costKindTone: Record<string, BadgeTone> = {
  LABOR: "blue",
  MATERIAL: "cyan",
  SUBCONTRACTOR: "violet",
  OTHER: "slate",
};

const ACTIVITY_ICON: Record<string, string> = {
  CALL: "📞",
  SMS: "💬",
  EMAIL: "✉️",
  NOTE: "📝",
  STATUS: "🔁",
  SYSTEM: "⚙️",
  ESTIMATE_VIEW: "👁",
  PAYMENT: "💳",
  REVIEW: "⭐",
};

export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const session = await requireSession();
  if (!can(session.role, "projects.manage")) return <Forbidden />;

  const project = await db.query.projects.findFirst({
    where: eq(t.projects.id, params.id),
    with: {
      customer: true,
      property: true,
      milestones: true,
      changeOrders: true,
      permits: true,
      costs: true,
      subs: true,
      jobs: { with: { assignedTo: true } },
    },
  });
  if (!project) notFound();

  const activities = await db.query.activities.findMany({
    where: eq(t.activities.projectId, project.id),
    with: { user: true },
  });
  activities.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const approvedCOs = project.changeOrders
    .filter((c) => c.status === "APPROVED")
    .reduce((s, c) => s + c.amountCents, 0);
  const contractValue = project.contractValueCents + approvedCOs;
  const billed = project.milestones.filter((m) => m.billed).reduce((s, m) => s + m.billingAmountCents, 0);
  const costs = project.costs.reduce((s, c) => s + c.amountCents, 0);
  const margin = contractValue - costs;
  const marginPct = contractValue > 0 ? Math.round((margin / contractValue) * 100) : 0;
  const budget = project.budgetLaborCents + project.budgetMaterialsCents + approvedCOs;

  const hasPassedInspection = project.permits.some((p) => p.status === "PASSED");
  const milestones = [...project.milestones].sort((a, b) => a.sortOrder - b.sortOrder);
  const doneMilestones = milestones.filter((m) => m.status === "COMPLETE").length;
  const costRows = [...project.costs].sort(
    (a, b) => new Date(b.incurredAt).getTime() - new Date(a.incurredAt).getTime()
  );

  const soonThreshold = Date.now() + 60 * 86_400_000;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {project.name}
            <Badge tone={projectStatusTone[project.status]}>{statusLabel(project.status)}</Badge>
          </span>
        }
        subtitle={
          <span>
            {project.customer.name} · {project.property.address}, {project.property.city} · {fmtDate(project.startDate)} →{" "}
            {fmtDate(project.endDate)}
          </span>
        }
        action={
          <Link href="/projects" className="text-sm text-blue-600 hover:underline">
            ← Projects
          </Link>
        }
      />

      {/* Stat row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Contract value"
          value={money(contractValue)}
          hint={approvedCOs > 0 ? `base ${money(project.contractValueCents)} + ${money(approvedCOs)} COs` : "no approved COs"}
        />
        <Stat
          label="Billed to date"
          value={money(billed)}
          hint={`${Math.round(contractValue > 0 ? (billed / contractValue) * 100 : 0)}% of contract`}
        />
        <Stat
          label="Costs to date"
          value={money(costs)}
          tone={budget > 0 && costs > budget ? "bad" : costs > budget * 0.8 ? "warn" : "default"}
          hint={<BudgetBar spentCents={costs} budgetCents={budget} />}
        />
        <Stat
          label="Projected margin"
          value={`${money(margin)}`}
          tone={marginPct >= 30 ? "good" : marginPct >= 15 ? "warn" : "bad"}
          hint={`${marginPct}% of contract`}
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-3">
        {/* Main column */}
        <div className="space-y-5 xl:col-span-2">
          {/* Milestones */}
          <Card>
            <CardHeader
              title="🚩 Milestones & progress billing"
              subtitle={`${doneMilestones}/${milestones.length} complete · inspections gate completion`}
            />
            <CardBody className="p-0">
              {milestones.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No milestones" />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {milestones.map((m, i) => {
                    const inspectionGate = m.requiresInspection && !hasPassedInspection;
                    return (
                      <li key={m.id} className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={clsx(
                              "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                              m.status === "COMPLETE" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
                            )}
                          >
                            {m.status === "COMPLETE" ? "✓" : i + 1}
                          </span>
                          <span className="font-medium text-slate-900">{m.name}</span>
                          <Badge tone={milestoneStatusTone[m.status]}>{statusLabel(m.status)}</Badge>
                          {m.requiresInspection ? <Badge tone="violet">🔍 Inspection required</Badge> : null}
                          <span className="ml-auto text-xs text-slate-500">due {fmtDate(m.dueDate)}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 pl-8">
                          {/* Status controls */}
                          {m.status === "PENDING" ? (
                            <form action={setMilestoneStatus}>
                              <input type="hidden" name="milestoneId" value={m.id} />
                              <input type="hidden" name="to" value="IN_PROGRESS" />
                              <Button size="sm" variant="secondary">
                                ▶ Start
                              </Button>
                            </form>
                          ) : null}
                          {m.status === "BLOCKED" ? (
                            <>
                              {inspectionGate ? (
                                <span className="rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700">
                                  ⛔ Blocked — no passed inspection on this project yet
                                </span>
                              ) : null}
                              <form action={setMilestoneStatus}>
                                <input type="hidden" name="milestoneId" value={m.id} />
                                <input type="hidden" name="to" value="IN_PROGRESS" />
                                <Button size="sm" variant="secondary">
                                  Resume work
                                </Button>
                              </form>
                              {!inspectionGate ? (
                                <form action={setMilestoneStatus}>
                                  <input type="hidden" name="milestoneId" value={m.id} />
                                  <input type="hidden" name="to" value="COMPLETE" />
                                  <Button size="sm" variant="success">
                                    ✓ Complete
                                  </Button>
                                </form>
                              ) : null}
                            </>
                          ) : null}
                          {m.status === "IN_PROGRESS" ? (
                            inspectionGate ? (
                              <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                                ⚠️ Can&apos;t complete — requires a PASSED inspection (see permits below)
                              </span>
                            ) : (
                              <form action={setMilestoneStatus}>
                                <input type="hidden" name="milestoneId" value={m.id} />
                                <input type="hidden" name="to" value="COMPLETE" />
                                <Button size="sm" variant="success">
                                  ✓ Complete
                                </Button>
                              </form>
                            )
                          ) : null}

                          {/* Billing */}
                          {m.billingAmountCents > 0 ? (
                            <span className="ml-auto flex items-center gap-2">
                              <span className="text-sm font-semibold tabular-nums text-slate-800">
                                {money(m.billingAmountCents)}
                              </span>
                              {m.billed ? (
                                <Badge tone="green">🧾 Billed</Badge>
                              ) : (
                                <form action={generateMilestoneInvoice}>
                                  <input type="hidden" name="milestoneId" value={m.id} />
                                  <Button size="sm" variant="secondary">
                                    🧾 Generate milestone invoice
                                  </Button>
                                </form>
                              )}
                            </span>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          {/* Change orders */}
          <Card>
            <CardHeader
              title="📋 Change orders"
              subtitle="E-signed before work proceeds — approved COs roll into contract value"
            />
            <CardBody className="p-0">
              {project.changeOrders.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No change orders" />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {[...project.changeOrders]
                    .sort((a, b) => a.number.localeCompare(b.number))
                    .map((co) => (
                      <li key={co.id} className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-slate-900">{co.number}</span>
                          <Badge tone={changeOrderStatusTone[co.status]}>{statusLabel(co.status)}</Badge>
                          <span className="ml-auto font-semibold tabular-nums text-slate-800">
                            {money(co.amountCents)}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-slate-600">{co.description}</p>
                        {co.status === "APPROVED" && co.signedName ? (
                          <p className="mt-1 text-xs text-emerald-700">
                            ✍️ Signed by {co.signedName} · {fmtDate(co.signedAt)}
                          </p>
                        ) : null}
                        {co.status === "PENDING_SIGNATURE" || co.status === "DRAFT" ? (
                          <form action={approveChangeOrder} className="mt-2 flex flex-wrap items-end gap-2">
                            <input type="hidden" name="changeOrderId" value={co.id} />
                            <div className="w-56">
                              <Field label="Customer/GC signature">
                                <Input name="signedName" required placeholder="Type full name to sign" />
                              </Field>
                            </div>
                            <Button size="sm" variant="success">
                              ✍️ Mark approved
                            </Button>
                          </form>
                        ) : null}
                      </li>
                    ))}
                </ul>
              )}
              <form action={createChangeOrder} className="flex flex-wrap items-end gap-2 border-t border-slate-100 p-4">
                <input type="hidden" name="projectId" value={project.id} />
                <div className="min-w-[220px] flex-1">
                  <Field label="New change order — description">
                    <Input name="description" required placeholder="e.g. Replace corroded shutoff found during demo" />
                  </Field>
                </div>
                <div className="w-32">
                  <Field label="Amount ($)">
                    <Input name="amount" required inputMode="decimal" placeholder="1850" />
                  </Field>
                </div>
                <Button size="sm">＋ Create CO</Button>
              </form>
            </CardBody>
          </Card>

          {/* Permits & inspections */}
          <Card>
            <CardHeader title="🏛️ Permits & inspections" subtitle="Inspection results unblock milestone completion" />
            <CardBody className="p-0">
              {project.permits.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No permits tracked" />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {project.permits.map((p) => (
                    <li key={p.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{p.jurisdiction}</span>
                        {p.permitNumber ? (
                          <span className="text-xs text-slate-500">#{p.permitNumber}</span>
                        ) : null}
                        <Badge tone={permitStatusTone[p.status]}>{statusLabel(p.status)}</Badge>
                        {p.feeCents != null ? (
                          <span className="text-xs text-slate-500">fee {money(p.feeCents)}</span>
                        ) : null}
                        {p.inspectionAt ? (
                          <span className="ml-auto text-xs text-slate-600">🔍 inspection {fmtDateTime(p.inspectionAt)}</span>
                        ) : null}
                      </div>
                      {p.notes ? <p className="mt-1 text-xs text-slate-500">{p.notes}</p> : null}
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        {p.status === "NOT_APPLIED" ? (
                          <form action={setPermitStatus}>
                            <input type="hidden" name="permitId" value={p.id} />
                            <input type="hidden" name="to" value="APPLIED" />
                            <Button size="sm" variant="secondary">
                              Mark applied
                            </Button>
                          </form>
                        ) : null}
                        {p.status === "APPLIED" ? (
                          <form action={setPermitStatus} className="flex items-end gap-2">
                            <input type="hidden" name="permitId" value={p.id} />
                            <input type="hidden" name="to" value="ISSUED" />
                            <div className="w-40">
                              <Field label="Permit #">
                                <Input name="permitNumber" placeholder="PLM-2026-…" defaultValue={p.permitNumber ?? ""} />
                              </Field>
                            </div>
                            <Button size="sm" variant="secondary">
                              Mark issued
                            </Button>
                          </form>
                        ) : null}
                        {p.status === "ISSUED" || p.status === "FAILED" ? (
                          <form action={setPermitStatus} className="flex items-end gap-2">
                            <input type="hidden" name="permitId" value={p.id} />
                            <input type="hidden" name="to" value="INSPECTION_SCHEDULED" />
                            <div>
                              <Field label={p.status === "FAILED" ? "Reschedule inspection" : "Schedule inspection"}>
                                <Input name="inspectionAt" type="datetime-local" required />
                              </Field>
                            </div>
                            <Button size="sm" variant="secondary">
                              📅 Schedule
                            </Button>
                          </form>
                        ) : null}
                        {p.status === "INSPECTION_SCHEDULED" ? (
                          <>
                            <form action={setPermitStatus}>
                              <input type="hidden" name="permitId" value={p.id} />
                              <input type="hidden" name="to" value="PASSED" />
                              <Button size="sm" variant="success">
                                ✓ Passed
                              </Button>
                            </form>
                            <form action={setPermitStatus}>
                              <input type="hidden" name="permitId" value={p.id} />
                              <input type="hidden" name="to" value="FAILED" />
                              <Button size="sm" variant="danger">
                                ✗ Failed
                              </Button>
                            </form>
                          </>
                        ) : null}
                        {p.status === "PASSED" ? (
                          <form action={setPermitStatus}>
                            <input type="hidden" name="permitId" value={p.id} />
                            <input type="hidden" name="to" value="CLOSED" />
                            <Button size="sm" variant="ghost">
                              Close out
                            </Button>
                          </form>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <form action={createPermit} className="flex flex-wrap items-end gap-2 border-t border-slate-100 p-4">
                <input type="hidden" name="projectId" value={project.id} />
                <div className="min-w-[180px] flex-1">
                  <Field label="New permit — jurisdiction">
                    <Input name="jurisdiction" required placeholder="City of Riverton" />
                  </Field>
                </div>
                <div className="w-36">
                  <Field label="Permit # (optional)">
                    <Input name="permitNumber" placeholder="PLM-…" />
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="Fee ($)">
                    <Input name="fee" inputMode="decimal" placeholder="420" />
                  </Field>
                </div>
                <Button size="sm">＋ Add permit</Button>
              </form>
            </CardBody>
          </Card>

          {/* Costs */}
          <Card>
            <CardHeader title="💸 Job costing" subtitle={`${money(costs)} logged against ${money(budget)} budget`} />
            <CardBody className="p-0">
              {costRows.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No costs logged yet" />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {costRows.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                      <Badge tone={costKindTone[c.kind]}>{statusLabel(c.kind)}</Badge>
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{c.description}</span>
                      <span className="text-xs text-slate-500">{fmtDate(c.incurredAt)}</span>
                      <span className="font-semibold tabular-nums text-slate-900">{money(c.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <form action={addCostEntry} className="flex flex-wrap items-end gap-2 border-t border-slate-100 p-4">
                <input type="hidden" name="projectId" value={project.id} />
                <div className="w-40">
                  <Field label="Kind">
                    <Select name="kind" defaultValue="MATERIAL">
                      <option value="LABOR">Labor</option>
                      <option value="MATERIAL">Material</option>
                      <option value="SUBCONTRACTOR">Subcontractor</option>
                      <option value="OTHER">Other</option>
                    </Select>
                  </Field>
                </div>
                <div className="min-w-[180px] flex-1">
                  <Field label="Description">
                    <Input name="description" required placeholder="e.g. Copper riser stock (Ferguson)" />
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="Amount ($)">
                    <Input name="amount" required inputMode="decimal" placeholder="1200" />
                  </Field>
                </div>
                <Button size="sm">＋ Log cost</Button>
              </form>
            </CardBody>
          </Card>
        </div>

        {/* Side column */}
        <div className="space-y-5">
          {/* Subcontractors */}
          <Card>
            <CardHeader title="👷 Subcontractors" subtitle="COI & license tracking" />
            <CardBody className="p-0">
              {project.subs.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No subs on this project" />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {project.subs.map((s) => {
                    const coiSoon =
                      s.coiExpiresAt && new Date(s.coiExpiresAt).getTime() < soonThreshold;
                    return (
                      <li key={s.id} className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-900">{s.name}</span>
                          <Badge tone="slate">{s.trade}</Badge>
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {s.phone ? `${s.phone} · ` : ""}
                          {s.licenseNumber ? `lic. ${s.licenseNumber}` : "no license on file"}
                        </div>
                        {s.coiExpiresAt ? (
                          coiSoon ? (
                            <div className="mt-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                              ⚠️ COI expires {fmtDate(s.coiExpiresAt)} — request updated certificate
                            </div>
                          ) : (
                            <div className="mt-1 text-xs text-slate-500">COI valid until {fmtDate(s.coiExpiresAt)}</div>
                          )
                        ) : (
                          <div className="mt-1.5 rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700">
                            ⛔ No COI on file
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <form action={addSubcontractor} className="space-y-2 border-t border-slate-100 p-4">
                <input type="hidden" name="projectId" value={project.id} />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Name">
                    <Input name="name" required placeholder="Sub name" />
                  </Field>
                  <Field label="Trade">
                    <Input name="trade" required placeholder="Electrical" />
                  </Field>
                  <Field label="Phone">
                    <Input name="phone" placeholder="555-…" />
                  </Field>
                  <Field label="License #">
                    <Input name="licenseNumber" placeholder="EL-1234" />
                  </Field>
                </div>
                <Field label="COI expires">
                  <Input name="coiExpiresAt" type="date" />
                </Field>
                <Button size="sm">＋ Add subcontractor</Button>
              </form>
            </CardBody>
          </Card>

          {/* Linked jobs */}
          <Card>
            <CardHeader title="🔧 Linked jobs" />
            <CardBody className="p-0">
              {project.jobs.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No jobs linked" />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {project.jobs.map((j) => (
                    <li key={j.id} className="flex items-center gap-2 px-4 py-2.5">
                      <span className="text-sm font-medium text-slate-900">{j.number}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{j.jobType}</span>
                      <Badge tone={jobStatusTone[j.status]}>{statusLabel(j.status)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {/* Activity feed */}
          <Card>
            <CardHeader title="🕘 Activity" />
            <CardBody>
              <form action={addProjectNote} className="mb-4 flex items-start gap-2">
                <input type="hidden" name="projectId" value={project.id} />
                <Textarea name="body" rows={2} required placeholder="Add a daily-log note…" className="flex-1" />
                <Button size="sm">Add</Button>
              </form>
              {activities.length === 0 ? (
                <EmptyState title="No activity yet" />
              ) : (
                <ul className="space-y-3">
                  {activities.map((a) => (
                    <li key={a.id} className="flex gap-2.5">
                      <span className="mt-0.5 text-sm">{ACTIVITY_ICON[a.kind] ?? "•"}</span>
                      <div className="min-w-0 flex-1 border-b border-slate-100 pb-2.5">
                        <p className="text-sm text-slate-800">{a.body}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
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
      </div>
    </div>
  );
}
