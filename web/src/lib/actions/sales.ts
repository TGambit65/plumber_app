"use server";

/* SALES/PM module server actions: leads, pipeline, follow-ups, estimates, projects. */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, t } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can, type Permission } from "@/lib/permissions";
import { audit, logActivity, notify } from "@/lib/actions/helpers";
import { lineTotal, money } from "@/lib/format";

// ── Internal helpers (not exported — "use server" files may only export async fns) ──

async function guard(permission: Permission) {
  const session = await requireSession();
  if (!can(session.role, permission)) throw new Error("You do not have permission to do that.");
  return session;
}

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

function dollarsToCents(fd: FormData, key: string): number | null {
  const raw = str(fd, key).replace(/[$,\s]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

async function nextDocNumber(prefix: string, kind: "estimates" | "jobs" | "invoices"): Promise<string> {
  const rows =
    kind === "estimates"
      ? await db.select({ n: t.estimates.number }).from(t.estimates)
      : kind === "jobs"
        ? await db.select({ n: t.jobs.number }).from(t.jobs)
        : await db.select({ n: t.invoices.number }).from(t.invoices);
  let max = 1000;
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${max + 1}`;
}

const STAGE_ORDER = [
  "NEW",
  "CONTACTED",
  "ESTIMATE_SCHEDULED",
  "ESTIMATE_SENT",
  "FOLLOW_UP",
  "WON",
  "LOST",
] as const;
type Stage = (typeof STAGE_ORDER)[number];

function revalidateSales(leadId?: string, estimateId?: string) {
  revalidatePath("/cockpit");
  revalidatePath("/leads");
  revalidatePath("/pipeline");
  revalidatePath("/estimates");
  if (leadId) revalidatePath(`/leads/${leadId}`);
  if (estimateId) revalidatePath(`/estimates/${estimateId}`);
}

/** Core stage transition shared by lead detail buttons & pipeline board. */
async function applyLeadStage(leadId: string, stage: Stage, userId: string, lostReason?: string) {
  const lead = await db.query.leads.findFirst({ where: eq(t.leads.id, leadId) });
  if (!lead) throw new Error("Lead not found");
  const now = new Date();
  const patch: Partial<typeof t.leads.$inferInsert> = { stage, lastContactAt: now };
  if (stage === "CONTACTED" && !lead.firstTouchAt) patch.firstTouchAt = now;
  if (stage === "LOST") patch.lostReason = lostReason || lead.lostReason || "No reason recorded";
  await db.update(t.leads).set(patch).where(eq(t.leads.id, leadId));
  await logActivity({
    kind: "STATUS",
    body:
      stage === "LOST"
        ? `Lead marked LOST — ${patch.lostReason}`
        : `Lead stage changed: ${lead.stage} → ${stage}`,
    userId,
    leadId,
    customerId: lead.customerId ?? undefined,
  });
}

// ── Leads ────────────────────────────────────────────────────────────────────

export async function createLead(formData: FormData) {
  const session = await guard("leads.create");
  const title = str(formData, "title");
  const contactName = str(formData, "contactName");
  if (!title || !contactName) throw new Error("Title and contact name are required");
  const source = (str(formData, "source") || "PHONE") as (typeof t.leads.$inferInsert)["source"];
  const assignedToId = str(formData, "assignedToId") || null;

  const [lead] = await db
    .insert(t.leads)
    .values({
      title,
      contactName,
      phone: str(formData, "phone") || null,
      email: str(formData, "email") || null,
      description: str(formData, "description") || null,
      source,
      stage: "NEW",
      estValueCents: dollarsToCents(formData, "estValue"),
      assignedToId,
      createdById: session.userId,
      // Speed-to-lead SLA: respond within 30 minutes.
      respondBy: new Date(Date.now() + 30 * 60 * 1000),
    })
    .returning();

  await logActivity({
    kind: "SYSTEM",
    body: `Lead created (${source}) — SLA: respond within 30 min`,
    userId: session.userId,
    leadId: lead.id,
  });
  if (assignedToId && assignedToId !== session.userId) {
    await notify(assignedToId, `New lead assigned: ${title}`, "SLA: respond within 30 min.", `/leads/${lead.id}`);
  }
  revalidateSales(lead.id);
  redirect(`/leads/${lead.id}`);
}

export async function setLeadStage(formData: FormData) {
  const session = await guard("pipeline.manage");
  const leadId = str(formData, "leadId");
  const stage = str(formData, "stage") as Stage;
  if (!STAGE_ORDER.includes(stage)) throw new Error("Invalid stage");
  const lostReason = str(formData, "lostReason");
  if (stage === "LOST" && !lostReason) throw new Error("A lost reason is required");
  await applyLeadStage(leadId, stage, session.userId, lostReason || undefined);
  revalidateSales(leadId);
}

/** Pipeline board ◀▶ movement. dir = "-1" | "1". */
export async function moveLeadStage(formData: FormData) {
  const session = await guard("pipeline.manage");
  const leadId = str(formData, "leadId");
  const dir = str(formData, "dir") === "-1" ? -1 : 1;
  const lead = await db.query.leads.findFirst({ where: eq(t.leads.id, leadId) });
  if (!lead) throw new Error("Lead not found");
  const idx = STAGE_ORDER.indexOf(lead.stage as Stage);
  const next = STAGE_ORDER[Math.min(STAGE_ORDER.length - 1, Math.max(0, idx + dir))];
  if (next === lead.stage) return;
  await applyLeadStage(leadId, next, session.userId, next === "LOST" ? "Moved to Lost on pipeline board" : undefined);
  revalidateSales(leadId);
}

export async function addLeadNote(formData: FormData) {
  const session = await requireSession();
  const leadId = str(formData, "leadId");
  const body = str(formData, "body");
  if (!body) return;
  const lead = await db.query.leads.findFirst({ where: eq(t.leads.id, leadId) });
  if (!lead) throw new Error("Lead not found");
  await logActivity({ kind: "NOTE", body, userId: session.userId, leadId, customerId: lead.customerId ?? undefined });
  revalidatePath(`/leads/${leadId}`);
}

/** Convert a lead into a DRAFT good-better-best estimate, then jump to it. */
export async function convertLeadToEstimate(formData: FormData) {
  const session = await guard("estimates.create");
  const leadId = str(formData, "leadId");
  const lead = await db.query.leads.findFirst({ where: eq(t.leads.id, leadId), with: { customer: true } });
  if (!lead) throw new Error("Lead not found");

  const customerId = lead.customerId ?? str(formData, "customerId");
  if (!customerId) throw new Error("Pick a customer to create the estimate against");
  let propertyId = lead.propertyId;
  if (!propertyId) {
    const prop = await db.query.properties.findFirst({ where: eq(t.properties.customerId, customerId) });
    propertyId = prop?.id ?? null;
  }

  const number = await nextDocNumber("E", "estimates");
  const [estimate] = await db
    .insert(t.estimates)
    .values({
      number,
      status: "DRAFT",
      customerId,
      propertyId,
      leadId: lead.id,
      createdById: session.userId,
      notes: lead.title,
    })
    .returning();

  await db.insert(t.estimateOptions).values([
    { estimateId: estimate.id, tier: "GOOD", name: "Good", description: "Gets the job done", sortOrder: 0 },
    { estimateId: estimate.id, tier: "BETTER", name: "Better", description: "Our most popular package", sortOrder: 1 },
    { estimateId: estimate.id, tier: "BEST", name: "Best", description: "Top-of-the-line, longest warranty", sortOrder: 2 },
  ]);

  if (!lead.customerId) {
    await db.update(t.leads).set({ customerId }).where(eq(t.leads.id, lead.id));
  }
  await logActivity({
    kind: "SYSTEM",
    body: `Estimate ${number} created from lead "${lead.title}"`,
    userId: session.userId,
    leadId: lead.id,
    customerId,
  });
  revalidateSales(lead.id, estimate.id);
  redirect(`/estimates/${estimate.id}`);
}

// ── Follow-ups ───────────────────────────────────────────────────────────────

export async function markFollowUpSent(formData: FormData) {
  const session = await requireSession();
  const id = str(formData, "followUpId");
  const fu = await db.query.followUps.findFirst({ where: eq(t.followUps.id, id), with: { estimate: true } });
  if (!fu) throw new Error("Follow-up not found");
  await db.update(t.followUps).set({ status: "SENT", sentAt: new Date() }).where(eq(t.followUps.id, id));
  const kind = fu.channel === "SMS" ? "SMS" : fu.channel === "EMAIL" ? "EMAIL" : "CALL";
  await logActivity({
    kind,
    body: `Follow-up ${fu.channel.toLowerCase()} sent: ${fu.body.slice(0, 120)}`,
    userId: session.userId,
    leadId: fu.leadId ?? fu.estimate?.leadId ?? undefined,
    customerId: fu.estimate?.customerId ?? undefined,
  });
  revalidateSales(fu.leadId ?? fu.estimate?.leadId ?? undefined, fu.estimateId ?? undefined);
}

export async function skipFollowUp(formData: FormData) {
  await requireSession();
  const id = str(formData, "followUpId");
  const fu = await db.query.followUps.findFirst({ where: eq(t.followUps.id, id), with: { estimate: true } });
  if (!fu) throw new Error("Follow-up not found");
  await db.update(t.followUps).set({ status: "SKIPPED" }).where(eq(t.followUps.id, id));
  revalidateSales(fu.leadId ?? fu.estimate?.leadId ?? undefined, fu.estimateId ?? undefined);
}

// ── Estimates: option & line-item editing ───────────────────────────────────

export async function addEstimateOption(formData: FormData) {
  await guard("estimates.create");
  const estimateId = str(formData, "estimateId");
  const tier = (str(formData, "tier") || "CUSTOM") as (typeof t.estimateOptions.$inferInsert)["tier"];
  const existing = await db.query.estimateOptions.findMany({ where: eq(t.estimateOptions.estimateId, estimateId) });
  const name = str(formData, "name") || tier.charAt(0) + tier.slice(1).toLowerCase();
  await db.insert(t.estimateOptions).values({ estimateId, tier, name, sortOrder: existing.length });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function addLineItem(formData: FormData) {
  await guard("estimates.create");
  const optionId = str(formData, "optionId");
  const priceBookItemId = str(formData, "priceBookItemId");
  if (!priceBookItemId) throw new Error("Pick a price book item");
  const option = await db.query.estimateOptions.findFirst({ where: eq(t.estimateOptions.id, optionId) });
  const item = await db.query.priceBookItems.findFirst({ where: eq(t.priceBookItems.id, priceBookItemId) });
  if (!option || !item) throw new Error("Not found");
  const qty = Number(str(formData, "qty") || "1") || 1;
  const override = dollarsToCents(formData, "priceOverride");
  await db.insert(t.estimateLineItems).values({
    optionId,
    priceBookItemId,
    description: item.name,
    qty,
    unitPriceCents: override ?? item.unitPriceCents,
    unitCostCents: item.unitCostCents,
  });
  revalidatePath(`/estimates/${option.estimateId}`);
}

export async function updateLineItem(formData: FormData) {
  await guard("estimates.create");
  const itemId = str(formData, "itemId");
  const row = await db.query.estimateLineItems.findFirst({
    where: eq(t.estimateLineItems.id, itemId),
    with: { option: true },
  });
  if (!row) throw new Error("Line item not found");
  const qty = Number(str(formData, "qty"));
  const price = dollarsToCents(formData, "price");
  await db
    .update(t.estimateLineItems)
    .set({
      qty: Number.isFinite(qty) && qty > 0 ? qty : row.qty,
      unitPriceCents: price ?? row.unitPriceCents,
    })
    .where(eq(t.estimateLineItems.id, itemId));
  revalidatePath(`/estimates/${row.option.estimateId}`);
}

export async function removeLineItem(formData: FormData) {
  await guard("estimates.create");
  const itemId = str(formData, "itemId");
  const row = await db.query.estimateLineItems.findFirst({
    where: eq(t.estimateLineItems.id, itemId),
    with: { option: true },
  });
  if (!row) return;
  await db.delete(t.estimateLineItems).where(eq(t.estimateLineItems.id, itemId));
  revalidatePath(`/estimates/${row.option.estimateId}`);
}

// ── Estimates: lifecycle ─────────────────────────────────────────────────────

/** Default 7-day unsold-estimate cadence: 5 SMS + 2 email (per doc 03 §4). */
function followUpCadence(estimateNumber: string, contact: string): { day: number; hour: number; channel: "SMS" | "EMAIL"; body: string }[] {
  const first = contact.split(/\s+/)[0];
  return [
    { day: 1, hour: 10, channel: "SMS", body: `Hi ${first}! Just making sure estimate ${estimateNumber} came through OK. Happy to answer any questions.` },
    { day: 2, hour: 14, channel: "SMS", body: `Hi ${first}, quick reminder that ${estimateNumber} includes monthly financing options — most customers are surprised how low the payment is.` },
    { day: 3, hour: 9, channel: "EMAIL", body: `Email: side-by-side comparison of your options on ${estimateNumber}, with financing breakdown and warranty details.` },
    { day: 4, hour: 11, channel: "SMS", body: `Hi ${first} — we can usually get you on the schedule within 2-3 days of approval on ${estimateNumber}. Want me to hold a slot?` },
    { day: 5, hour: 15, channel: "SMS", body: `Hi ${first}, any questions on ${estimateNumber}? If price is the concern, ask me about the Good option or financing.` },
    { day: 6, hour: 9, channel: "EMAIL", body: `Email: what happens if you wait — photos of what deferred plumbing issues look like, plus your ${estimateNumber} recap.` },
    { day: 7, hour: 12, channel: "SMS", body: `Hi ${first}, last check-in on ${estimateNumber} — approve online any time, or reply STOP and I'll close it out. Thanks!` },
  ];
}

export async function markEstimateSent(formData: FormData) {
  const session = await guard("estimates.create");
  const estimateId = str(formData, "estimateId");
  const est = await db.query.estimates.findFirst({
    where: eq(t.estimates.id, estimateId),
    with: { customer: true, lead: true },
  });
  if (!est) throw new Error("Estimate not found");
  const now = new Date();
  await db.update(t.estimates).set({ status: "SENT", sentAt: now }).where(eq(t.estimates.id, estimateId));

  // Default-on follow-up automation: 7 touches over 7 days.
  const cadence = followUpCadence(est.number, est.lead?.contactName ?? est.customer.name);
  await db.insert(t.followUps).values(
    cadence.map((c) => {
      const dueAt = new Date(now);
      dueAt.setDate(dueAt.getDate() + c.day);
      dueAt.setHours(c.hour, 0, 0, 0);
      return { estimateId, channel: c.channel, status: "PENDING" as const, dueAt, body: c.body };
    })
  );

  if (est.leadId) await applyLeadStage(est.leadId, "ESTIMATE_SENT", session.userId);
  await logActivity({
    kind: "SYSTEM",
    body: `Estimate ${est.number} sent to ${est.customer.name} — 7-day follow-up sequence started (5 SMS + 2 email)`,
    userId: session.userId,
    customerId: est.customerId,
    leadId: est.leadId ?? undefined,
  });
  revalidateSales(est.leadId ?? undefined, estimateId);
}

/** Demo hook: simulate the customer opening their proposal link. */
export async function recordEstimateView(formData: FormData) {
  await requireSession();
  const estimateId = str(formData, "estimateId");
  const est = await db.query.estimates.findFirst({ where: eq(t.estimates.id, estimateId), with: { customer: true } });
  if (!est) throw new Error("Estimate not found");
  const views = est.viewCount + 1;
  await db
    .update(t.estimates)
    .set({
      viewCount: views,
      lastViewedAt: new Date(),
      status: est.status === "SENT" || est.status === "VIEWED" ? "VIEWED" : est.status,
    })
    .where(eq(t.estimates.id, estimateId));
  await logActivity({
    kind: "ESTIMATE_VIEW",
    body: `${est.customer.name} viewed estimate ${est.number} (view #${views})`,
    customerId: est.customerId,
    leadId: est.leadId ?? undefined,
  });
  if (views >= 2) {
    await notify(
      est.createdById,
      `🔥 ${est.customer.name} viewed ${est.number} ${views} times`,
      "Hot signal — call while it's top of mind.",
      `/estimates/${estimateId}`
    );
  }
  revalidateSales(est.leadId ?? undefined, estimateId);
}

/** Approve & e-sign: select option, sign, commission for the creator, job creation. */
export async function approveEstimate(formData: FormData) {
  const session = await guard("estimates.create");
  const estimateId = str(formData, "estimateId");
  const optionId = str(formData, "optionId");
  const signedName = str(formData, "signedName");
  if (!optionId) throw new Error("Select an option to approve");
  if (!signedName) throw new Error("Signed name is required for e-signature");

  const est = await db.query.estimates.findFirst({
    where: eq(t.estimates.id, estimateId),
    with: { options: { with: { items: true } }, customer: { with: { properties: true } } },
  });
  if (!est) throw new Error("Estimate not found");
  if (est.status === "APPROVED") throw new Error("Estimate already approved");
  const option = est.options.find((o) => o.id === optionId);
  if (!option) throw new Error("Option not found");

  const total = lineTotal(option.items);
  const now = new Date();

  await db.update(t.estimateOptions).set({ selected: false }).where(eq(t.estimateOptions.estimateId, estimateId));
  await db.update(t.estimateOptions).set({ selected: true }).where(eq(t.estimateOptions.id, optionId));
  await db
    .update(t.estimates)
    .set({ status: "APPROVED", signedName, signedAt: now })
    .where(eq(t.estimates.id, estimateId));

  // 5% of sold revenue for the estimate creator.
  const commissionCents = Math.round(total * 0.05);
  await db.insert(t.commissionEntries).values({
    userId: est.createdById,
    description: `${est.number} approved — ${est.customer.name}, "${option.name}" (5% of ${money(total)})`,
    amountCents: commissionCents,
    period: currentPeriod(),
    status: "PENDING",
    sourceType: "ESTIMATE",
    sourceId: est.id,
  });

  // Create the sold job if none is linked yet.
  if (!est.jobId) {
    const propertyId = est.propertyId ?? est.customer.properties[0]?.id ?? null;
    if (propertyId) {
      const jobNumber = await nextDocNumber("J", "jobs");
      const [job] = await db
        .insert(t.jobs)
        .values({
          number: jobNumber,
          status: "UNSCHEDULED",
          jobType: est.notes?.split("\n")[0]?.slice(0, 80) || "Sold work",
          description: `Sold via estimate ${est.number} — option "${option.name}" (${money(total)})`,
          customerId: est.customerId,
          propertyId,
        })
        .returning();
      await db.update(t.estimates).set({ jobId: job.id }).where(eq(t.estimates.id, estimateId));
    }
  }

  // Auto-stop the follow-up sequence and mark the lead won.
  await db
    .update(t.followUps)
    .set({ status: "SKIPPED" })
    .where(and(eq(t.followUps.estimateId, estimateId), eq(t.followUps.status, "PENDING")));
  if (est.leadId) await applyLeadStage(est.leadId, "WON", session.userId);

  await logActivity({
    kind: "STATUS",
    body: `Estimate ${est.number} approved & e-signed by ${signedName} — "${option.name}" for ${money(total)}`,
    userId: session.userId,
    customerId: est.customerId,
    leadId: est.leadId ?? undefined,
  });
  await notify(
    est.createdById,
    `🎉 ${est.number} approved — ${money(total)}`,
    `${signedName} signed for "${option.name}". Commission ${money(commissionCents)} pending approval.`,
    `/estimates/${estimateId}`
  );
  await audit(session.userId, "ESTIMATE_APPROVED", "Estimate", est.id, {
    option: option.name,
    totalCents: total,
    commissionCents,
    signedName,
  });
  revalidateSales(est.leadId ?? undefined, estimateId);
}

export async function declineEstimate(formData: FormData) {
  const session = await guard("estimates.create");
  const estimateId = str(formData, "estimateId");
  const reason = str(formData, "reason") || "No reason given";
  const est = await db.query.estimates.findFirst({ where: eq(t.estimates.id, estimateId), with: { customer: true } });
  if (!est) throw new Error("Estimate not found");
  await db.update(t.estimates).set({ status: "DECLINED" }).where(eq(t.estimates.id, estimateId));
  await db
    .update(t.followUps)
    .set({ status: "SKIPPED" })
    .where(and(eq(t.followUps.estimateId, estimateId), eq(t.followUps.status, "PENDING")));
  if (est.leadId) await applyLeadStage(est.leadId, "LOST", session.userId, reason);
  await logActivity({
    kind: "STATUS",
    body: `Estimate ${est.number} declined — ${reason}`,
    userId: session.userId,
    customerId: est.customerId,
    leadId: est.leadId ?? undefined,
  });
  revalidateSales(est.leadId ?? undefined, estimateId);
}

// ── Projects: milestones ─────────────────────────────────────────────────────

export async function setMilestoneStatus(formData: FormData) {
  const session = await guard("projects.manage");
  const milestoneId = str(formData, "milestoneId");
  const to = str(formData, "to") as (typeof t.milestones.$inferSelect)["status"];
  const ms = await db.query.milestones.findFirst({ where: eq(t.milestones.id, milestoneId), with: { project: true } });
  if (!ms) throw new Error("Milestone not found");

  let target = to;
  let note = `Milestone "${ms.name}" → ${to}`;
  if (to === "COMPLETE" && ms.requiresInspection) {
    const passed = await db.query.permits.findFirst({
      where: and(eq(t.permits.projectId, ms.projectId), eq(t.permits.status, "PASSED")),
    });
    if (!passed) {
      target = "BLOCKED";
      note = `Milestone "${ms.name}" blocked — requires a PASSED inspection before completion`;
    }
  }
  await db.update(t.milestones).set({ status: target }).where(eq(t.milestones.id, milestoneId));
  await logActivity({ kind: "STATUS", body: note, userId: session.userId, projectId: ms.projectId });
  revalidatePath(`/projects/${ms.projectId}`);
  revalidatePath("/projects");
}

export async function generateMilestoneInvoice(formData: FormData) {
  const session = await guard("projects.manage");
  const milestoneId = str(formData, "milestoneId");
  const ms = await db.query.milestones.findFirst({ where: eq(t.milestones.id, milestoneId), with: { project: true } });
  if (!ms) throw new Error("Milestone not found");
  if (ms.billed) throw new Error("Milestone already billed");
  if (ms.billingAmountCents <= 0) throw new Error("Milestone has no billing amount");

  const number = await nextDocNumber("INV", "invoices");
  const now = new Date();
  const dueAt = new Date(now);
  dueAt.setDate(dueAt.getDate() + 30);
  const [invoice] = await db
    .insert(t.invoices)
    .values({
      number,
      status: "SENT",
      customerId: ms.project.customerId,
      projectId: ms.projectId,
      issuedAt: now,
      dueAt,
    })
    .returning();
  await db.insert(t.invoiceLineItems).values({
    invoiceId: invoice.id,
    description: `Progress billing — milestone: ${ms.name} (${ms.project.name})`,
    qty: 1,
    unitPriceCents: ms.billingAmountCents,
  });
  await db.update(t.milestones).set({ billed: true }).where(eq(t.milestones.id, milestoneId));
  await logActivity({
    kind: "SYSTEM",
    body: `Invoice ${number} generated for milestone "${ms.name}" — ${money(ms.billingAmountCents)}`,
    userId: session.userId,
    projectId: ms.projectId,
    customerId: ms.project.customerId,
  });
  await audit(session.userId, "MILESTONE_INVOICED", "Milestone", ms.id, {
    invoice: number,
    amountCents: ms.billingAmountCents,
  });
  revalidatePath(`/projects/${ms.projectId}`);
  revalidatePath("/projects");
}

// ── Projects: change orders ──────────────────────────────────────────────────

export async function createChangeOrder(formData: FormData) {
  const session = await guard("projects.manage");
  const projectId = str(formData, "projectId");
  const description = str(formData, "description");
  const amountCents = dollarsToCents(formData, "amount");
  if (!description || amountCents == null) throw new Error("Description and amount are required");
  const existing = await db.query.changeOrders.findMany({ where: eq(t.changeOrders.projectId, projectId) });
  const number = `CO-${String(existing.length + 1).padStart(2, "0")}`;
  await db.insert(t.changeOrders).values({
    projectId,
    number,
    description,
    amountCents,
    status: "PENDING_SIGNATURE",
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Change order ${number} created (${money(amountCents)}) — awaiting customer signature`,
    userId: session.userId,
    projectId,
  });
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
}

export async function approveChangeOrder(formData: FormData) {
  const session = await guard("projects.manage");
  const changeOrderId = str(formData, "changeOrderId");
  const signedName = str(formData, "signedName");
  if (!signedName) throw new Error("Signed name is required");
  const co = await db.query.changeOrders.findFirst({ where: eq(t.changeOrders.id, changeOrderId) });
  if (!co) throw new Error("Change order not found");
  await db
    .update(t.changeOrders)
    .set({ status: "APPROVED", signedName, signedAt: new Date() })
    .where(eq(t.changeOrders.id, changeOrderId));
  await logActivity({
    kind: "STATUS",
    body: `Change order ${co.number} approved & signed by ${signedName} — ${money(co.amountCents)} added to contract value`,
    userId: session.userId,
    projectId: co.projectId,
  });
  await audit(session.userId, "CHANGE_ORDER_APPROVED", "ChangeOrder", co.id, {
    amountCents: co.amountCents,
    signedName,
  });
  revalidatePath(`/projects/${co.projectId}`);
  revalidatePath("/projects");
}

// ── Projects: permits ────────────────────────────────────────────────────────

export async function createPermit(formData: FormData) {
  const session = await guard("projects.manage");
  const projectId = str(formData, "projectId");
  const jurisdiction = str(formData, "jurisdiction");
  if (!jurisdiction) throw new Error("Jurisdiction is required");
  await db.insert(t.permits).values({
    projectId,
    jurisdiction,
    permitNumber: str(formData, "permitNumber") || null,
    feeCents: dollarsToCents(formData, "fee"),
    status: "NOT_APPLIED",
    notes: str(formData, "notes") || null,
  });
  await logActivity({ kind: "SYSTEM", body: `Permit added — ${jurisdiction}`, userId: session.userId, projectId });
  revalidatePath(`/projects/${projectId}`);
}

export async function setPermitStatus(formData: FormData) {
  const session = await guard("projects.manage");
  const permitId = str(formData, "permitId");
  const to = str(formData, "to") as (typeof t.permits.$inferSelect)["status"];
  const permit = await db.query.permits.findFirst({ where: eq(t.permits.id, permitId) });
  if (!permit) throw new Error("Permit not found");

  const patch: Partial<typeof t.permits.$inferInsert> = { status: to };
  if (to === "INSPECTION_SCHEDULED") {
    const raw = str(formData, "inspectionAt");
    if (!raw) throw new Error("Pick an inspection date/time");
    patch.inspectionAt = new Date(raw);
  }
  const permitNumber = str(formData, "permitNumber");
  if (permitNumber) patch.permitNumber = permitNumber;
  await db.update(t.permits).set(patch).where(eq(t.permits.id, permitId));
  await logActivity({
    kind: "STATUS",
    body:
      to === "INSPECTION_SCHEDULED"
        ? `Inspection scheduled for permit ${permit.permitNumber ?? permit.jurisdiction} (${patch.inspectionAt?.toLocaleString()})`
        : `Permit ${permit.permitNumber ?? permit.jurisdiction} → ${to}`,
    userId: session.userId,
    projectId: permit.projectId,
  });
  revalidatePath(`/projects/${permit.projectId}`);
  revalidatePath("/projects");
}

// ── Projects: costs, subs, notes ─────────────────────────────────────────────

export async function addCostEntry(formData: FormData) {
  const session = await guard("projects.manage");
  const projectId = str(formData, "projectId");
  const description = str(formData, "description");
  const amountCents = dollarsToCents(formData, "amount");
  const kind = (str(formData, "kind") || "OTHER") as (typeof t.costEntries.$inferInsert)["kind"];
  if (!description || amountCents == null) throw new Error("Description and amount are required");
  await db.insert(t.costEntries).values({ projectId, kind, description, amountCents });
  await logActivity({
    kind: "SYSTEM",
    body: `Cost logged (${kind.toLowerCase()}): ${description} — ${money(amountCents)}`,
    userId: session.userId,
    projectId,
  });
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
}

export async function addSubcontractor(formData: FormData) {
  const session = await guard("projects.manage");
  const projectId = str(formData, "projectId");
  const name = str(formData, "name");
  const trade = str(formData, "trade");
  if (!name || !trade) throw new Error("Name and trade are required");
  const coiRaw = str(formData, "coiExpiresAt");
  await db.insert(t.subcontractors).values({
    projectId,
    name,
    trade,
    phone: str(formData, "phone") || null,
    licenseNumber: str(formData, "licenseNumber") || null,
    coiExpiresAt: coiRaw ? new Date(coiRaw) : null,
  });
  await logActivity({ kind: "SYSTEM", body: `Subcontractor added: ${name} (${trade})`, userId: session.userId, projectId });
  revalidatePath(`/projects/${projectId}`);
}

export async function addProjectNote(formData: FormData) {
  const session = await requireSession();
  const projectId = str(formData, "projectId");
  const body = str(formData, "body");
  if (!body) return;
  await logActivity({ kind: "NOTE", body, userId: session.userId, projectId });
  revalidatePath(`/projects/${projectId}`);
}
