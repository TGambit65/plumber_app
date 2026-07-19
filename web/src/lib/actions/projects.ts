"use server";

/* M2 project lifecycle actions — create (incl. promote-from-estimate), edit,
 * explicit status transitions with deliberate reopens, archive-on-CLOSED,
 * milestone CRUD/reorder/block, change-order reject+edit, cost & sub editing,
 * job linking, and ad-hoc project invoices. Plan §2 principles apply:
 * archive over delete, money is immutable once real, audit every mutation. */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { t, withTenant, type TenantDb } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, logActivity } from "@/lib/actions/helpers";
import { lineTotal, money } from "@/lib/format";
import {
  changeOrderEditBlocker,
  milestoneDeleteBlocker,
  projectArchiveBlocker,
  projectTransitionBlocker,
  type ChangeOrderStatus,
  type ProjectStatus,
} from "@/lib/manage/lifecycle";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function dollarsToCents(fd: FormData, key: string): number | null {
  const raw = str(fd, key).replace(/[$,\s]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

async function guardProjects() {
  const session = await requireSession();
  if (!can(session.role, "projects.manage")) throw new Error("Not allowed");
  return session;
}

function revalidateProjects(projectId?: string) {
  revalidatePath("/projects");
  if (projectId) revalidatePath(`/projects/${projectId}`);
}

/** Per-org invoice number — must run inside the caller's withTenant tx. */
async function nextInvoiceNumber(tx: TenantDb): Promise<string> {
  const rows = await tx.select({ n: t.invoices.number }).from(t.invoices);
  let max = 1000;
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `INV-${max + 1}`;
}

// ── Project header ───────────────────────────────────────────────────────────

/** Create a project from the Projects page. */
export async function createProject(formData: FormData) {
  const session = await guardProjects();
  const name = str(formData, "name");
  const customerId = str(formData, "customerId");
  const propertyId = str(formData, "propertyId");
  if (!name || !customerId || !propertyId) return;
  const startDate = str(formData, "startDate");
  const endDate = str(formData, "endDate");

  const [project] = await withTenant(session.organizationId, async (tx) => {
    const property = await tx.query.properties.findFirst({ where: eq(t.properties.id, propertyId) });
    if (!property || property.customerId !== customerId) {
      throw new Error("Selected property does not belong to the selected customer");
    }
    return tx
      .insert(t.projects)
      .values({
        name,
        status: "PLANNING",
        customerId,
        propertyId,
        contractValueCents: dollarsToCents(formData, "contractValue") ?? 0,
        budgetLaborCents: dollarsToCents(formData, "budgetLabor") ?? 0,
        budgetMaterialsCents: dollarsToCents(formData, "budgetMaterials") ?? 0,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
      })
      .returning();
  });

  await audit(session.userId, "CREATE", "Project", project.id, { name });
  await logActivity({
    kind: "SYSTEM",
    body: `Project "${name}" created by ${session.name}`,
    userId: session.userId,
    projectId: project.id,
    customerId,
  });
  revalidateProjects(project.id);
  redirect(`/projects/${project.id}`);
}

/** Promote an APPROVED estimate into a project (contract value = selected option). */
export async function promoteEstimateToProject(formData: FormData) {
  const session = await guardProjects();
  const estimateId = str(formData, "estimateId");
  if (!estimateId) return;

  const { project, est } = await withTenant(session.organizationId, async (tx) => {
    const est = await tx.query.estimates.findFirst({
      where: eq(t.estimates.id, estimateId),
      with: { customer: true, options: { with: { items: true } } },
    });
    if (!est) throw new Error("Estimate not found");
    if (est.status !== "APPROVED") throw new Error("Only approved estimates can be promoted to a project");
    const option = est.options.find((o) => o.selected) ?? est.options[0];
    const contract = option ? lineTotal(option.items) : 0;
    let propertyId = est.propertyId;
    if (!propertyId) {
      const prop = await tx.query.properties.findFirst({ where: eq(t.properties.customerId, est.customerId) });
      propertyId = prop?.id ?? null;
    }
    if (!propertyId) throw new Error("The customer needs a property on file first");

    const [project] = await tx
      .insert(t.projects)
      .values({
        name: `${est.notes?.split("\n")[0]?.slice(0, 60) || "Sold work"} (${est.number})`,
        status: "PLANNING",
        customerId: est.customerId,
        propertyId,
        contractValueCents: contract,
      })
      .returning();
    // Bring the estimate's sold job along.
    if (est.jobId) await tx.update(t.jobs).set({ projectId: project.id }).where(eq(t.jobs.id, est.jobId));
    return { project, est };
  });

  await audit(session.userId, "PROJECT_PROMOTED", "Project", project.id, { estimate: est.number });
  await logActivity({
    kind: "SYSTEM",
    body: `Project created from estimate ${est.number} (${money(project.contractValueCents)})`,
    userId: session.userId,
    projectId: project.id,
    customerId: est.customerId,
  });
  revalidateProjects(project.id);
  redirect(`/projects/${project.id}`);
}

/** Edit every project header field. */
export async function updateProject(formData: FormData) {
  const session = await guardProjects();
  const projectId = str(formData, "projectId");
  const name = str(formData, "name");
  if (!projectId || !name) return;
  const startDate = str(formData, "startDate");
  const endDate = str(formData, "endDate");

  const found = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.projects.findFirst({ where: eq(t.projects.id, projectId) });
    if (!existing) return null;
    await tx
      .update(t.projects)
      .set({
        name,
        contractValueCents: dollarsToCents(formData, "contractValue") ?? existing.contractValueCents,
        budgetLaborCents: dollarsToCents(formData, "budgetLabor") ?? existing.budgetLaborCents,
        budgetMaterialsCents: dollarsToCents(formData, "budgetMaterials") ?? existing.budgetMaterialsCents,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
      })
      .where(eq(t.projects.id, projectId));
    return existing;
  });
  if (!found) return;

  await audit(session.userId, "UPDATE", "Project", projectId, { name });
  await logActivity({
    kind: "SYSTEM",
    body: `Project header updated by ${session.name}`,
    userId: session.userId,
    projectId,
  });
  revalidateProjects(projectId);
}

/** Explicit status transitions (incl. deliberate reopens). */
export async function setProjectStatus(formData: FormData) {
  const session = await guardProjects();
  const projectId = str(formData, "projectId");
  const to = str(formData, "to") as ProjectStatus;
  if (!projectId || !to) return;

  const project = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.projects.findFirst({ where: eq(t.projects.id, projectId) });
    if (!existing) return null;
    const blocker = projectTransitionBlocker(existing.status as ProjectStatus, to);
    if (blocker) throw new Error(blocker);
    await tx.update(t.projects).set({ status: to }).where(eq(t.projects.id, projectId));
    return existing;
  });
  if (!project) return;

  await audit(session.userId, "PROJECT_STATUS", "Project", projectId, { from: project.status, to });
  await logActivity({
    kind: "STATUS",
    body: `Project status: ${project.status} → ${to}`,
    userId: session.userId,
    projectId,
  });
  revalidateProjects(projectId);
}

/** Archive a CLOSED project off the list (reversible). */
export async function archiveProject(formData: FormData) {
  const session = await guardProjects();
  const projectId = str(formData, "projectId");
  if (!projectId) return;
  const project = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.projects.findFirst({ where: eq(t.projects.id, projectId) });
    if (!existing) return null;
    const blocker = projectArchiveBlocker(existing.status as ProjectStatus);
    if (blocker) throw new Error(blocker);
    await tx.update(t.projects).set({ archivedAt: new Date() }).where(eq(t.projects.id, projectId));
    return existing;
  });
  if (!project) return;
  await audit(session.userId, "PROJECT_ARCHIVED", "Project", projectId, { name: project.name });
  revalidateProjects(projectId);
}

export async function unarchiveProject(formData: FormData) {
  const session = await guardProjects();
  const projectId = str(formData, "projectId");
  if (!projectId) return;
  const project = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.projects.findFirst({ where: eq(t.projects.id, projectId) });
    if (!existing?.archivedAt) return null;
    await tx.update(t.projects).set({ archivedAt: null }).where(eq(t.projects.id, projectId));
    return existing;
  });
  if (!project) return;
  await audit(session.userId, "PROJECT_UNARCHIVED", "Project", projectId, { name: project.name });
  revalidateProjects(projectId);
}

// ── Milestones ───────────────────────────────────────────────────────────────

export async function addMilestone(formData: FormData) {
  const session = await guardProjects();
  const projectId = str(formData, "projectId");
  const name = str(formData, "name");
  if (!projectId || !name) return;
  const dueDate = str(formData, "dueDate");

  await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.milestones.findMany({ where: eq(t.milestones.projectId, projectId) });
    const maxOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder), -1);
    await tx.insert(t.milestones).values({
      projectId,
      name,
      status: "PENDING",
      dueDate: dueDate ? new Date(dueDate) : null,
      billingAmountCents: dollarsToCents(formData, "billingAmount") ?? 0,
      requiresInspection: str(formData, "requiresInspection") === "on",
      sortOrder: maxOrder + 1,
    });
  });
  await logActivity({ kind: "SYSTEM", body: `Milestone added: ${name}`, userId: session.userId, projectId });
  revalidateProjects(projectId);
}

export async function updateMilestone(formData: FormData) {
  const session = await guardProjects();
  const milestoneId = str(formData, "milestoneId");
  const name = str(formData, "name");
  if (!milestoneId || !name) return;
  const dueDate = str(formData, "dueDate");

  const ms = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.milestones.findFirst({ where: eq(t.milestones.id, milestoneId) });
    if (!existing) return null;
    await tx
      .update(t.milestones)
      .set({
        name,
        dueDate: dueDate ? new Date(dueDate) : null,
        // Billed milestones keep their invoiced amount (money is immutable once real).
        billingAmountCents: existing.billed ? existing.billingAmountCents : dollarsToCents(formData, "billingAmount") ?? 0,
        requiresInspection: str(formData, "requiresInspection") === "on",
      })
      .where(eq(t.milestones.id, milestoneId));
    return existing;
  });
  if (!ms) return;
  await audit(session.userId, "UPDATE", "Milestone", milestoneId, { name });
  revalidateProjects(ms.projectId);
}

export async function deleteMilestone(formData: FormData) {
  const session = await guardProjects();
  const milestoneId = str(formData, "milestoneId");
  if (!milestoneId) return;
  const ms = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.milestones.findFirst({ where: eq(t.milestones.id, milestoneId) });
    if (!existing) return null;
    const blocker = milestoneDeleteBlocker(existing.billed);
    if (blocker) throw new Error(blocker);
    await tx.delete(t.milestones).where(eq(t.milestones.id, milestoneId));
    return existing;
  });
  if (!ms) return;
  await audit(session.userId, "MILESTONE_DELETED", "Milestone", milestoneId, { name: ms.name });
  await logActivity({ kind: "SYSTEM", body: `Milestone removed: ${ms.name}`, userId: session.userId, projectId: ms.projectId });
  revalidateProjects(ms.projectId);
}

/** Move a milestone up/down in the sequence (swaps sortOrder with its neighbor). */
export async function moveMilestone(formData: FormData) {
  const session = await guardProjects();
  const milestoneId = str(formData, "milestoneId");
  const dir = str(formData, "dir") === "-1" ? -1 : 1;
  if (!milestoneId) return;

  const projectId = await withTenant(session.organizationId, async (tx) => {
    const ms = await tx.query.milestones.findFirst({ where: eq(t.milestones.id, milestoneId) });
    if (!ms) return null;
    const siblings = await tx.query.milestones.findMany({
      where: eq(t.milestones.projectId, ms.projectId),
      orderBy: asc(t.milestones.sortOrder),
    });
    const idx = siblings.findIndex((s) => s.id === milestoneId);
    const neighbor = siblings[idx + dir];
    if (!neighbor) return ms.projectId; // already at the edge
    await tx.update(t.milestones).set({ sortOrder: neighbor.sortOrder }).where(eq(t.milestones.id, ms.id));
    await tx.update(t.milestones).set({ sortOrder: ms.sortOrder }).where(eq(t.milestones.id, neighbor.id));
    return ms.projectId;
  });
  if (!projectId) return;
  revalidateProjects(projectId);
}

/** Manually block a milestone with a reason (unblock = Resume work). */
export async function blockMilestone(formData: FormData) {
  const session = await guardProjects();
  const milestoneId = str(formData, "milestoneId");
  const reason = str(formData, "reason");
  if (!milestoneId) return;
  if (!reason) throw new Error("A blocking reason is required");

  const ms = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.milestones.findFirst({ where: eq(t.milestones.id, milestoneId) });
    if (!existing) return null;
    if (existing.status === "COMPLETE") throw new Error("Completed milestones can't be blocked");
    await tx.update(t.milestones).set({ status: "BLOCKED" }).where(eq(t.milestones.id, milestoneId));
    return existing;
  });
  if (!ms) return;
  await logActivity({
    kind: "STATUS",
    body: `Milestone "${ms.name}" BLOCKED — ${reason}`,
    userId: session.userId,
    projectId: ms.projectId,
  });
  revalidateProjects(ms.projectId);
}

// ── Change orders ────────────────────────────────────────────────────────────

export async function updateChangeOrder(formData: FormData) {
  const session = await guardProjects();
  const changeOrderId = str(formData, "changeOrderId");
  const description = str(formData, "description");
  const amountCents = dollarsToCents(formData, "amount");
  if (!changeOrderId || !description || amountCents == null) return;

  const co = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.changeOrders.findFirst({ where: eq(t.changeOrders.id, changeOrderId) });
    if (!existing) return null;
    const blocker = changeOrderEditBlocker(existing.status as ChangeOrderStatus);
    if (blocker) throw new Error(blocker);
    await tx.update(t.changeOrders).set({ description, amountCents }).where(eq(t.changeOrders.id, changeOrderId));
    return existing;
  });
  if (!co) return;
  await audit(session.userId, "UPDATE", "ChangeOrder", changeOrderId, { number: co.number, amountCents });
  revalidateProjects(co.projectId);
}

/** Reject a pending change order (the enum value finally gets a UI path). */
export async function rejectChangeOrder(formData: FormData) {
  const session = await guardProjects();
  const changeOrderId = str(formData, "changeOrderId");
  const reason = str(formData, "reason") || "No reason recorded";
  if (!changeOrderId) return;

  const co = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.changeOrders.findFirst({ where: eq(t.changeOrders.id, changeOrderId) });
    if (!existing) return null;
    if (existing.status === "APPROVED") throw new Error("Approved change orders can't be rejected");
    await tx.update(t.changeOrders).set({ status: "REJECTED" }).where(eq(t.changeOrders.id, changeOrderId));
    return existing;
  });
  if (!co) return;
  await audit(session.userId, "CHANGE_ORDER_REJECTED", "ChangeOrder", changeOrderId, { number: co.number, reason });
  await logActivity({
    kind: "STATUS",
    body: `Change order ${co.number} REJECTED — ${reason}`,
    userId: session.userId,
    projectId: co.projectId,
  });
  revalidateProjects(co.projectId);
}

// ── Costs ────────────────────────────────────────────────────────────────────

const COST_KINDS = ["LABOR", "MATERIAL", "SUBCONTRACTOR", "OTHER"] as const;

export async function updateCostEntry(formData: FormData) {
  const session = await guardProjects();
  const costId = str(formData, "costId");
  const description = str(formData, "description");
  const amountCents = dollarsToCents(formData, "amount");
  if (!costId || !description || amountCents == null) return;
  const kind = (COST_KINDS as readonly string[]).includes(str(formData, "kind"))
    ? (str(formData, "kind") as (typeof COST_KINDS)[number])
    : "OTHER";
  const incurredAt = str(formData, "incurredAt");

  const cost = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.costEntries.findFirst({ where: eq(t.costEntries.id, costId) });
    if (!existing) return null;
    await tx
      .update(t.costEntries)
      .set({
        description,
        amountCents,
        kind,
        incurredAt: incurredAt ? new Date(incurredAt) : existing.incurredAt,
      })
      .where(eq(t.costEntries.id, costId));
    return existing;
  });
  if (!cost) return;
  await audit(session.userId, "UPDATE", "CostEntry", costId, { amountCents });
  revalidateProjects(cost.projectId);
}

export async function deleteCostEntry(formData: FormData) {
  const session = await guardProjects();
  const costId = str(formData, "costId");
  if (!costId) return;
  const cost = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.costEntries.findFirst({ where: eq(t.costEntries.id, costId) });
    if (!existing) return null;
    await tx.delete(t.costEntries).where(eq(t.costEntries.id, costId));
    return existing;
  });
  if (!cost) return;
  await audit(session.userId, "COST_DELETED", "CostEntry", costId, {
    description: cost.description,
    amountCents: cost.amountCents,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Cost entry removed: ${cost.description} (${money(cost.amountCents)})`,
    userId: session.userId,
    projectId: cost.projectId,
  });
  revalidateProjects(cost.projectId);
}

// ── Subcontractors ───────────────────────────────────────────────────────────

export async function updateSubcontractor(formData: FormData) {
  const session = await guardProjects();
  const subId = str(formData, "subId");
  const name = str(formData, "name");
  const trade = str(formData, "trade");
  if (!subId || !name || !trade) return;
  const coiRaw = str(formData, "coiExpiresAt");

  const sub = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.subcontractors.findFirst({ where: eq(t.subcontractors.id, subId) });
    if (!existing) return null;
    await tx
      .update(t.subcontractors)
      .set({
        name,
        trade,
        phone: str(formData, "phone") || null,
        licenseNumber: str(formData, "licenseNumber") || null,
        coiExpiresAt: coiRaw ? new Date(coiRaw) : null,
      })
      .where(eq(t.subcontractors.id, subId));
    return existing;
  });
  if (!sub) return;
  await audit(session.userId, "UPDATE", "Subcontractor", subId, {
    name,
    coiRenewed: Boolean(coiRaw) && String(sub.coiExpiresAt ?? "") !== String(coiRaw ? new Date(coiRaw) : ""),
  });
  revalidateProjects(sub.projectId);
}

export async function removeSubcontractor(formData: FormData) {
  const session = await guardProjects();
  const subId = str(formData, "subId");
  if (!subId) return;
  const sub = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.subcontractors.findFirst({ where: eq(t.subcontractors.id, subId) });
    if (!existing) return null;
    await tx.delete(t.subcontractors).where(eq(t.subcontractors.id, subId));
    return existing;
  });
  if (!sub) return;
  await audit(session.userId, "SUB_REMOVED", "Subcontractor", subId, { name: sub.name });
  await logActivity({
    kind: "SYSTEM",
    body: `Subcontractor removed from project: ${sub.name} (${sub.trade})`,
    userId: session.userId,
    projectId: sub.projectId,
  });
  revalidateProjects(sub.projectId);
}

// ── Job linkage ──────────────────────────────────────────────────────────────

export async function linkJobToProject(formData: FormData) {
  const session = await guardProjects();
  const projectId = str(formData, "projectId");
  const jobId = str(formData, "jobId");
  if (!projectId || !jobId) return;

  const job = await withTenant(session.organizationId, async (tx) => {
    const project = await tx.query.projects.findFirst({ where: eq(t.projects.id, projectId) });
    const job = await tx.query.jobs.findFirst({ where: eq(t.jobs.id, jobId) });
    if (!project || !job) return null;
    if (job.customerId !== project.customerId) {
      throw new Error("That job belongs to a different customer than this project");
    }
    await tx.update(t.jobs).set({ projectId }).where(eq(t.jobs.id, jobId));
    return job;
  });
  if (!job) return;
  await audit(session.userId, "JOB_LINKED", "Project", projectId, { job: job.number });
  await logActivity({
    kind: "SYSTEM",
    body: `Job ${job.number} linked to this project`,
    userId: session.userId,
    projectId,
    jobId,
  });
  revalidateProjects(projectId);
  revalidatePath(`/jobs/${jobId}`);
}

export async function unlinkJobFromProject(formData: FormData) {
  const session = await guardProjects();
  const projectId = str(formData, "projectId");
  const jobId = str(formData, "jobId");
  if (!projectId || !jobId) return;
  const job = await withTenant(session.organizationId, async (tx) => {
    const job = await tx.query.jobs.findFirst({ where: and(eq(t.jobs.id, jobId), eq(t.jobs.projectId, projectId)) });
    if (!job) return null;
    await tx.update(t.jobs).set({ projectId: null }).where(eq(t.jobs.id, jobId));
    return job;
  });
  if (!job) return;
  await audit(session.userId, "JOB_UNLINKED", "Project", projectId, { job: job.number });
  await logActivity({
    kind: "SYSTEM",
    body: `Job ${job.number} unlinked from this project`,
    userId: session.userId,
    projectId,
    jobId,
  });
  revalidateProjects(projectId);
  revalidatePath(`/jobs/${jobId}`);
}

// ── Ad-hoc project invoice ───────────────────────────────────────────────────

/** DRAFT invoice against the project's customer with one line (send it from Invoices). */
export async function createProjectInvoice(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "invoices.create") && !can(session.role, "projects.manage")) throw new Error("Not allowed");
  const projectId = str(formData, "projectId");
  const description = str(formData, "description");
  const amountCents = dollarsToCents(formData, "amount");
  if (!projectId || !description || amountCents == null || amountCents <= 0) return;

  const { project, number } = await withTenant(session.organizationId, async (tx) => {
    const project = await tx.query.projects.findFirst({ where: eq(t.projects.id, projectId) });
    if (!project) throw new Error("Project not found");
    const number = await nextInvoiceNumber(tx);
    const [invoice] = await tx
      .insert(t.invoices)
      .values({ number, status: "DRAFT", customerId: project.customerId, projectId })
      .returning();
    await tx.insert(t.invoiceLineItems).values({
      invoiceId: invoice.id,
      description: `${description} (${project.name})`,
      qty: 1,
      unitPriceCents: amountCents,
    });
    return { project, number };
  });

  await audit(session.userId, "PROJECT_INVOICE_CREATED", "Project", projectId, { number, amountCents });
  await logActivity({
    kind: "SYSTEM",
    body: `Ad-hoc invoice ${number} drafted for ${money(amountCents)} — ${description}`,
    userId: session.userId,
    projectId,
    customerId: project.customerId,
  });
  revalidateProjects(projectId);
  revalidatePath("/invoices");
}

// ── Data helper for the projects list page (unlinked jobs picker) ────────────

export async function customerJobsWithoutProject(organizationId: string, customerId: string) {
  return withTenant(organizationId, (tx) =>
    tx.query.jobs.findMany({
      where: and(eq(t.jobs.customerId, customerId), isNull(t.jobs.projectId), isNull(t.jobs.deletedAt)),
      orderBy: asc(t.jobs.number),
    })
  );
}
