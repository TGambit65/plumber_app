import Link from "next/link";
import { notFound } from "next/navigation";
import { t, withTenant } from "@/db";
import { and, asc, eq, isNull } from "drizzle-orm";
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
import {
  addMilestone,
  archiveProject,
  blockMilestone,
  createProjectInvoice,
  deleteCostEntry,
  deleteMilestone,
  linkJobToProject,
  moveMilestone,
  rejectChangeOrder,
  removeSubcontractor,
  setProjectStatus,
  unarchiveProject,
  unlinkJobFromProject,
  updateChangeOrder,
  updateCostEntry,
  updateMilestone,
  updateProject,
  updateSubcontractor,
} from "@/lib/actions/projects";
import { PROJECT_TRANSITIONS, type ProjectStatus } from "@/lib/manage/lifecycle";
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

  const { project, activities, linkableJobs } = await withTenant(session.organizationId, async (tx) => {
    const project = await tx.query.projects.findFirst({
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
    const [activities, linkableJobs] = project
      ? await Promise.all([
          tx.query.activities.findMany({
            where: eq(t.activities.projectId, project.id),
            with: { user: true },
          }),
          // M2: same-customer jobs not linked to any project yet.
          tx.query.jobs.findMany({
            where: and(eq(t.jobs.customerId, project.customerId), isNull(t.jobs.projectId), isNull(t.jobs.deletedAt)),
            orderBy: asc(t.jobs.number),
          }),
        ])
      : [[], []];
    return { project, activities, linkableJobs };
  });
  if (!project) notFound();

  const transitions = PROJECT_TRANSITIONS[project.status as ProjectStatus] ?? [];
  const toDateInput = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

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

      {/* M2: archived banner */}
      {project.archivedAt ? (
        <Card className="mt-4 border-slate-300 bg-slate-50">
          <CardBody className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
            <span>📦 This project is archived — hidden from the projects list.</span>
            <form action={unarchiveProject}>
              <input type="hidden" name="projectId" value={project.id} />
              <Button type="submit" size="sm" variant="secondary">
                ♻️ Restore project
              </Button>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {/* M2: Manage project — status transitions, header edit, archive */}
      <Card className="mt-4">
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</span>
            {transitions.map((to) => (
              <form key={to} action={setProjectStatus}>
                <input type="hidden" name="projectId" value={project.id} />
                <input type="hidden" name="to" value={to} />
                <Button
                  size="sm"
                  variant={to === "COMPLETED" ? "success" : to === "ON_HOLD" ? "secondary" : "secondary"}
                  title={
                    to === "ACTIVE" && project.status === "COMPLETED"
                      ? "Reopen — the project wasn't actually done"
                      : to === "COMPLETED" && project.status === "CLOSED"
                        ? "Reopen a closed project for corrections"
                        : undefined
                  }
                >
                  {to === "ACTIVE" && (project.status === "ON_HOLD" || project.status === "COMPLETED")
                    ? "♻️ Resume (Active)"
                    : to === "COMPLETED" && project.status === "CLOSED"
                      ? "♻️ Reopen (Completed)"
                      : `→ ${statusLabel(to)}`}
                </Button>
              </form>
            ))}
            {project.status === "CLOSED" && !project.archivedAt ? (
              <form action={archiveProject}>
                <input type="hidden" name="projectId" value={project.id} />
                <Button type="submit" size="sm" variant="ghost" title="Hides the project from the list — reversible">
                  📦 Archive project
                </Button>
              </form>
            ) : null}
          </div>

          <details className="rounded-lg border border-slate-200">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-700">✏️ Edit project details</summary>
            <form action={updateProject} className="grid gap-3 border-t border-slate-100 p-3 md:grid-cols-3">
              <input type="hidden" name="projectId" value={project.id} />
              <div className="md:col-span-3">
                <Field label="Project name">
                  <Input name="name" required defaultValue={project.name} />
                </Field>
              </div>
              <Field label="Contract value ($)">
                <Input name="contractValue" inputMode="decimal" defaultValue={String(project.contractValueCents / 100)} />
              </Field>
              <Field label="Labor budget ($)">
                <Input name="budgetLabor" inputMode="decimal" defaultValue={String(project.budgetLaborCents / 100)} />
              </Field>
              <Field label="Materials budget ($)">
                <Input name="budgetMaterials" inputMode="decimal" defaultValue={String(project.budgetMaterialsCents / 100)} />
              </Field>
              <Field label="Start date">
                <Input name="startDate" type="date" defaultValue={toDateInput(project.startDate)} />
              </Field>
              <Field label="End date">
                <Input name="endDate" type="date" defaultValue={toDateInput(project.endDate)} />
              </Field>
              <div className="flex items-end">
                <Button type="submit" size="sm">
                  Save project
                </Button>
              </div>
            </form>
          </details>
        </CardBody>
      </Card>

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

                        {/* M2: milestone management — reorder, edit, block, delete */}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-8">
                          <form action={moveMilestone}>
                            <input type="hidden" name="milestoneId" value={m.id} />
                            <input type="hidden" name="dir" value="-1" />
                            <button type="submit" disabled={i === 0} title="Move earlier" className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100 disabled:opacity-30">▲</button>
                          </form>
                          <form action={moveMilestone}>
                            <input type="hidden" name="milestoneId" value={m.id} />
                            <input type="hidden" name="dir" value="1" />
                            <button type="submit" disabled={i === milestones.length - 1} title="Move later" className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100 disabled:opacity-30">▼</button>
                          </form>
                          <details>
                            <summary className="cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50">✏️ Edit</summary>
                            <form action={updateMilestone} className="mt-2 grid gap-2 rounded-lg border border-slate-200 p-2.5 sm:grid-cols-2">
                              <input type="hidden" name="milestoneId" value={m.id} />
                              <Field label="Name">
                                <Input name="name" required defaultValue={m.name} />
                              </Field>
                              <Field label="Due date">
                                <Input name="dueDate" type="date" defaultValue={m.dueDate ? m.dueDate.toISOString().slice(0, 10) : ""} />
                              </Field>
                              <Field label={m.billed ? "Billing ($) — locked (already invoiced)" : "Billing ($)"}>
                                <Input name="billingAmount" inputMode="decimal" defaultValue={String(m.billingAmountCents / 100)} disabled={m.billed} />
                              </Field>
                              <label className="flex items-end gap-2 pb-2 text-xs text-slate-700">
                                <input type="checkbox" name="requiresInspection" defaultChecked={m.requiresInspection} className="h-4 w-4" />
                                🔍 Requires inspection
                              </label>
                              <div className="sm:col-span-2">
                                <Button type="submit" size="sm" variant="secondary">Save milestone</Button>
                              </div>
                            </form>
                          </details>
                          {m.status !== "COMPLETE" && m.status !== "BLOCKED" ? (
                            <details>
                              <summary className="cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-50">⛔ Block…</summary>
                              <form action={blockMilestone} className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-amber-200 p-2.5">
                                <input type="hidden" name="milestoneId" value={m.id} />
                                <div className="w-56">
                                  <Field label="Reason (required)">
                                    <Input name="reason" required placeholder="e.g. waiting on fixture delivery" />
                                  </Field>
                                </div>
                                <Button type="submit" size="sm" variant="secondary">Block</Button>
                              </form>
                            </details>
                          ) : null}
                          {!m.billed ? (
                            <form action={deleteMilestone}>
                              <input type="hidden" name="milestoneId" value={m.id} />
                              <button type="submit" title="Delete this milestone (billed milestones can't be deleted)" className="rounded px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50">🗑 Delete</button>
                            </form>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {/* M2: add a milestone */}
              <form action={addMilestone} className="flex flex-wrap items-end gap-2 border-t border-slate-100 p-4">
                <input type="hidden" name="projectId" value={project.id} />
                <div className="min-w-[200px] flex-1">
                  <Field label="New milestone — name">
                    <Input name="name" required placeholder="e.g. Rough-in complete" />
                  </Field>
                </div>
                <div className="w-36">
                  <Field label="Due date">
                    <Input name="dueDate" type="date" />
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="Billing ($)">
                    <Input name="billingAmount" inputMode="decimal" placeholder="0" />
                  </Field>
                </div>
                <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-700">
                  <input type="checkbox" name="requiresInspection" className="h-4 w-4" /> 🔍 Inspection
                </label>
                <Button size="sm">＋ Add milestone</Button>
              </form>
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
                          <>
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
                            {/* M2: edit or reject while a decision is pending */}
                            <div className="mt-2 flex flex-wrap items-start gap-2">
                              <details>
                                <summary className="cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50">✏️ Edit CO</summary>
                                <form action={updateChangeOrder} className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-2.5">
                                  <input type="hidden" name="changeOrderId" value={co.id} />
                                  <div className="min-w-[200px] flex-1">
                                    <Field label="Description">
                                      <Input name="description" required defaultValue={co.description} />
                                    </Field>
                                  </div>
                                  <div className="w-28">
                                    <Field label="Amount ($)">
                                      <Input name="amount" required inputMode="decimal" defaultValue={String(co.amountCents / 100)} />
                                    </Field>
                                  </div>
                                  <Button type="submit" size="sm" variant="secondary">Save CO</Button>
                                </form>
                              </details>
                              <details>
                                <summary className="cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50">✗ Reject…</summary>
                                <form action={rejectChangeOrder} className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-red-200 p-2.5">
                                  <input type="hidden" name="changeOrderId" value={co.id} />
                                  <div className="w-56">
                                    <Field label="Reason">
                                      <Input name="reason" placeholder="e.g. customer declined the price" />
                                    </Field>
                                  </div>
                                  <Button type="submit" size="sm" variant="danger">Reject CO</Button>
                                </form>
                              </details>
                            </div>
                          </>
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
                    <li key={c.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <Badge tone={costKindTone[c.kind]}>{statusLabel(c.kind)}</Badge>
                        <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{c.description}</span>
                        <span className="text-xs text-slate-500">{fmtDate(c.incurredAt)}</span>
                        <span className="font-semibold tabular-nums text-slate-900">{money(c.amountCents)}</span>
                      </div>
                      {/* M2: edit / delete a cost entry */}
                      <div className="mt-1 flex flex-wrap items-start gap-2">
                        <details>
                          <summary className="cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50">✏️ Edit</summary>
                          <form action={updateCostEntry} className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-2.5">
                            <input type="hidden" name="costId" value={c.id} />
                            <div className="w-36">
                              <Field label="Kind">
                                <Select name="kind" defaultValue={c.kind}>
                                  <option value="LABOR">Labor</option>
                                  <option value="MATERIAL">Material</option>
                                  <option value="SUBCONTRACTOR">Subcontractor</option>
                                  <option value="OTHER">Other</option>
                                </Select>
                              </Field>
                            </div>
                            <div className="min-w-[160px] flex-1">
                              <Field label="Description">
                                <Input name="description" required defaultValue={c.description} />
                              </Field>
                            </div>
                            <div className="w-24">
                              <Field label="Amount ($)">
                                <Input name="amount" required inputMode="decimal" defaultValue={String(c.amountCents / 100)} />
                              </Field>
                            </div>
                            <div className="w-36">
                              <Field label="Incurred on">
                                <Input name="incurredAt" type="date" defaultValue={c.incurredAt.toISOString().slice(0, 10)} />
                              </Field>
                            </div>
                            <Button type="submit" size="sm" variant="secondary">Save cost</Button>
                          </form>
                        </details>
                        <form action={deleteCostEntry}>
                          <input type="hidden" name="costId" value={c.id} />
                          <button type="submit" className="rounded px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50" title="Remove this cost entry (audited)">🗑 Delete</button>
                        </form>
                      </div>
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
                        {/* M2: edit (incl. COI renewal) / remove a sub */}
                        <div className="mt-1.5 flex flex-wrap items-start gap-2">
                          <details>
                            <summary className="cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50">✏️ Edit / renew COI</summary>
                            <form action={updateSubcontractor} className="mt-2 space-y-2 rounded-lg border border-slate-200 p-2.5">
                              <input type="hidden" name="subId" value={s.id} />
                              <div className="grid grid-cols-2 gap-2">
                                <Field label="Name">
                                  <Input name="name" required defaultValue={s.name} />
                                </Field>
                                <Field label="Trade">
                                  <Input name="trade" required defaultValue={s.trade} />
                                </Field>
                                <Field label="Phone">
                                  <Input name="phone" defaultValue={s.phone ?? ""} />
                                </Field>
                                <Field label="License #">
                                  <Input name="licenseNumber" defaultValue={s.licenseNumber ?? ""} />
                                </Field>
                              </div>
                              <Field label="COI expires (set a new date to renew)">
                                <Input name="coiExpiresAt" type="date" defaultValue={s.coiExpiresAt ? s.coiExpiresAt.toISOString().slice(0, 10) : ""} />
                              </Field>
                              <Button type="submit" size="sm" variant="secondary">Save sub</Button>
                            </form>
                          </details>
                          <form action={removeSubcontractor}>
                            <input type="hidden" name="subId" value={s.id} />
                            <button type="submit" className="rounded px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50">🗑 Remove</button>
                          </form>
                        </div>
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

          {/* Linked jobs (M2: link/unlink) */}
          <Card>
            <CardHeader title="🔧 Linked jobs" subtitle="Same-customer jobs can be attached here" />
            <CardBody className="p-0">
              {project.jobs.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No jobs linked" />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {project.jobs.map((j) => (
                    <li key={j.id} className="flex items-center gap-2 px-4 py-2.5">
                      <Link href={`/jobs/${j.id}`} className="text-sm font-medium text-blue-700 hover:underline">
                        {j.number}
                      </Link>
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{j.jobType}</span>
                      <Badge tone={jobStatusTone[j.status]}>{statusLabel(j.status)}</Badge>
                      <form action={unlinkJobFromProject}>
                        <input type="hidden" name="projectId" value={project.id} />
                        <input type="hidden" name="jobId" value={j.id} />
                        <button type="submit" title="Unlink from this project" className="rounded px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50">✂ Unlink</button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              {linkableJobs.length > 0 ? (
                <form action={linkJobToProject} className="flex flex-wrap items-end gap-2 border-t border-slate-100 p-4">
                  <input type="hidden" name="projectId" value={project.id} />
                  <div className="min-w-[180px] flex-1">
                    <Field label="Link an existing job">
                      <Select name="jobId" required defaultValue="">
                        <option value="" disabled>
                          Choose job…
                        </option>
                        {linkableJobs.map((j) => (
                          <option key={j.id} value={j.id}>
                            {j.number} · {j.jobType}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Button size="sm" variant="secondary">🔗 Link</Button>
                </form>
              ) : null}
            </CardBody>
          </Card>

          {/* M2: ad-hoc project invoice */}
          <Card>
            <CardHeader title="🧾 Ad-hoc invoice" subtitle="Drafts an invoice against this project — send it from Invoices & AR" />
            <CardBody>
              <form action={createProjectInvoice} className="space-y-2">
                <input type="hidden" name="projectId" value={project.id} />
                <Field label="Description">
                  <Input name="description" required placeholder="e.g. Deposit — mobilization" />
                </Field>
                <Field label="Amount ($)">
                  <Input name="amount" required inputMode="decimal" placeholder="5000" />
                </Field>
                <Button type="submit" size="sm" variant="secondary">
                  ＋ Draft invoice
                </Button>
              </form>
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
