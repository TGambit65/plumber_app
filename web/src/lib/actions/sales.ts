"use server";

/* SALES/PM module server actions: leads, pipeline, follow-ups, estimates, projects. */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { t, withTenant, type TenantDb } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
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

/**
 * Approval-gated egress (constraint 8): customer-facing sends QUEUE an
 * outbound_messages row instead of firing. Ping the people who can approve
 * (approvals.manage lives on OFFICE + ADMIN) so it doesn't sit unseen.
 */
async function notifyApprovers(
  organizationId: string,
  exceptUserId: string,
  title: string,
  body: string,
  href = "/approvals"
) {
  const approvers = await withTenant(organizationId, (tx) =>
    tx
      .select({ id: t.users.id })
      .from(t.users)
      .where(and(eq(t.users.active, true), inArray(t.users.role, ["OFFICE", "ADMIN"])))
  );
  for (const a of approvers) {
    if (a.id === exceptUserId) continue;
    await notify(a.id, title, body, href);
  }
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

/** Per-org number sequence — must run inside the caller's withTenant transaction. */
async function nextDocNumber(tx: TenantDb, prefix: string, kind: "estimates" | "jobs" | "invoices"): Promise<string> {
  const rows =
    kind === "estimates"
      ? await tx.select({ n: t.estimates.number }).from(t.estimates)
      : kind === "jobs"
        ? await tx.select({ n: t.jobs.number }).from(t.jobs)
        : await tx.select({ n: t.invoices.number }).from(t.invoices);
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

/** Core stage transition shared by lead detail buttons & pipeline board.
 *  Must run inside the caller's withTenant transaction. */
async function applyLeadStage(tx: TenantDb, leadId: string, stage: Stage, userId: string, lostReason?: string) {
  const lead = await tx.query.leads.findFirst({ where: eq(t.leads.id, leadId) });
  if (!lead) throw new Error("Lead not found");
  const now = new Date();
  const patch: Partial<typeof t.leads.$inferInsert> = { stage, lastContactAt: now };
  if (stage === "CONTACTED" && !lead.firstTouchAt) patch.firstTouchAt = now;
  if (stage === "LOST") patch.lostReason = lostReason || lead.lostReason || "No reason recorded";
  await tx.update(t.leads).set(patch).where(eq(t.leads.id, leadId));
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

  const [lead] = await withTenant(session.organizationId, (tx) =>
    tx
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
      .returning()
  );

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
  await withTenant(session.organizationId, (tx) =>
    applyLeadStage(tx, leadId, stage, session.userId, lostReason || undefined)
  );
  revalidateSales(leadId);
}

/** Pipeline board ◀▶ movement. dir = "-1" | "1". */
export async function moveLeadStage(formData: FormData) {
  const session = await guard("pipeline.manage");
  const leadId = str(formData, "leadId");
  const dir = str(formData, "dir") === "-1" ? -1 : 1;
  await withTenant(session.organizationId, async (tx) => {
    const lead = await tx.query.leads.findFirst({ where: eq(t.leads.id, leadId) });
    if (!lead) throw new Error("Lead not found");
    const idx = STAGE_ORDER.indexOf(lead.stage as Stage);
    const next = STAGE_ORDER[Math.min(STAGE_ORDER.length - 1, Math.max(0, idx + dir))];
    if (next === lead.stage) return;
    await applyLeadStage(tx, leadId, next, session.userId, next === "LOST" ? "Moved to Lost on pipeline board" : undefined);
  });
  revalidateSales(leadId);
}

export async function addLeadNote(formData: FormData) {
  const session = await requireSession();
  const leadId = str(formData, "leadId");
  const body = str(formData, "body");
  if (!body) return;
  const lead = await withTenant(session.organizationId, (tx) =>
    tx.query.leads.findFirst({ where: eq(t.leads.id, leadId) })
  );
  if (!lead) throw new Error("Lead not found");
  await logActivity({ kind: "NOTE", body, userId: session.userId, leadId, customerId: lead.customerId ?? undefined });
  revalidatePath(`/leads/${leadId}`);
}

/** Convert a lead into a DRAFT good-better-best estimate, then jump to it. */
export async function convertLeadToEstimate(formData: FormData) {
  const session = await guard("estimates.create");
  const leadId = str(formData, "leadId");

  const { lead, estimate, number, customerId } = await withTenant(session.organizationId, async (tx) => {
    const lead = await tx.query.leads.findFirst({ where: eq(t.leads.id, leadId), with: { customer: true } });
    if (!lead) throw new Error("Lead not found");

    const customerId = lead.customerId ?? str(formData, "customerId");
    if (!customerId) throw new Error("Pick a customer to create the estimate against");
    let propertyId = lead.propertyId;
    if (!propertyId) {
      const prop = await tx.query.properties.findFirst({ where: eq(t.properties.customerId, customerId) });
      propertyId = prop?.id ?? null;
    }

    const number = await nextDocNumber(tx, "E", "estimates");
    const [estimate] = await tx
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

    await tx.insert(t.estimateOptions).values([
      { estimateId: estimate.id, tier: "GOOD", name: "Good", description: "Gets the job done", sortOrder: 0 },
      { estimateId: estimate.id, tier: "BETTER", name: "Better", description: "Our most popular package", sortOrder: 1 },
      { estimateId: estimate.id, tier: "BEST", name: "Best", description: "Top-of-the-line, longest warranty", sortOrder: 2 },
    ]);

    if (!lead.customerId) {
      await tx.update(t.leads).set({ customerId }).where(eq(t.leads.id, lead.id));
    }
    return { lead, estimate, number, customerId };
  });

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

/**
 * Approval-gated (constraint 8): "Mark sent" now QUEUES a FOLLOW_UP_TOUCH for
 * office/owner approval rather than firing the SMS/email itself. The touch is
 * customer-facing, so it waits behind the same gate as an estimate send.
 * Signature unchanged — callers (cockpit, lead & estimate detail) are untouched.
 */
export async function markFollowUpSent(formData: FormData) {
  const session = await requireSession();
  const id = str(formData, "followUpId");
  const fu = await withTenant(session.organizationId, async (tx) => {
    const fu = await tx.query.followUps.findFirst({
      where: eq(t.followUps.id, id),
      with: { estimate: { with: { customer: true } }, lead: true },
    });
    if (!fu) throw new Error("Follow-up not found");
    if (fu.status !== "PENDING") throw new Error("This follow-up is no longer pending.");
    // Don't double-queue if a request is already awaiting approval.
    const existing = await tx.query.outboundMessages.findFirst({
      where: and(
        eq(t.outboundMessages.followUpId, id),
        eq(t.outboundMessages.status, "PENDING_APPROVAL")
      ),
    });
    if (existing) return fu;
    const recipient =
      fu.estimate?.customer?.email ??
      fu.estimate?.customer?.phone ??
      fu.lead?.email ??
      fu.lead?.phone ??
      null;
    await tx.insert(t.outboundMessages).values({
      kind: "FOLLOW_UP_TOUCH",
      status: "PENDING_APPROVAL",
      customerId: fu.estimate?.customerId ?? null,
      recipient,
      subject: `Follow-up ${fu.channel} touch`,
      body: fu.body,
      followUpId: fu.id,
      estimateId: fu.estimateId ?? null,
      requestedById: session.userId,
    });
    return fu;
  });
  await notifyApprovers(
    session.organizationId,
    session.userId,
    "✉️ Follow-up touch awaiting approval",
    `${fu.channel} touch queued by ${session.name}.`
  );
  revalidateSales(fu.leadId ?? fu.estimate?.leadId ?? undefined, fu.estimateId ?? undefined);
}

/**
 * Executes an approved FOLLOW_UP_TOUCH — the real "send". Called by
 * approveOutbound (@/lib/actions/approvals) once an approver signs off.
 * actorUserId is the original requester, so the timeline credits them.
 */
export async function reallySendFollowUp(organizationId: string, followUpId: string, actorUserId: string) {
  const fu = await withTenant(organizationId, async (tx) => {
    const fu = await tx.query.followUps.findFirst({
      where: eq(t.followUps.id, followUpId),
      with: { estimate: true },
    });
    if (!fu) throw new Error("Follow-up not found");
    if (fu.status === "SENT") return fu;
    await tx.update(t.followUps).set({ status: "SENT", sentAt: new Date() }).where(eq(t.followUps.id, followUpId));
    return fu;
  });
  const kind = fu.channel === "SMS" ? "SMS" : fu.channel === "EMAIL" ? "EMAIL" : "CALL";
  await logActivity({
    kind,
    body: `Follow-up ${fu.channel.toLowerCase()} sent: ${fu.body.slice(0, 120)}`,
    userId: actorUserId,
    leadId: fu.leadId ?? fu.estimate?.leadId ?? undefined,
    customerId: fu.estimate?.customerId ?? undefined,
  });
  revalidateSales(fu.leadId ?? fu.estimate?.leadId ?? undefined, fu.estimateId ?? undefined);
  return fu;
}

export async function skipFollowUp(formData: FormData) {
  const session = await requireSession();
  const id = str(formData, "followUpId");
  const fu = await withTenant(session.organizationId, async (tx) => {
    const fu = await tx.query.followUps.findFirst({ where: eq(t.followUps.id, id), with: { estimate: true } });
    if (!fu) throw new Error("Follow-up not found");
    await tx.update(t.followUps).set({ status: "SKIPPED" }).where(eq(t.followUps.id, id));
    return fu;
  });
  revalidateSales(fu.leadId ?? fu.estimate?.leadId ?? undefined, fu.estimateId ?? undefined);
}

// ── Estimates: option & line-item editing ───────────────────────────────────

export async function addEstimateOption(formData: FormData) {
  const session = await guard("estimates.create");
  const estimateId = str(formData, "estimateId");
  const tier = (str(formData, "tier") || "CUSTOM") as (typeof t.estimateOptions.$inferInsert)["tier"];
  const name = str(formData, "name") || tier.charAt(0) + tier.slice(1).toLowerCase();
  await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.estimateOptions.findMany({ where: eq(t.estimateOptions.estimateId, estimateId) });
    await tx.insert(t.estimateOptions).values({ estimateId, tier, name, sortOrder: existing.length });
  });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function addLineItem(formData: FormData) {
  const session = await guard("estimates.create");
  const optionId = str(formData, "optionId");
  const priceBookItemId = str(formData, "priceBookItemId");
  if (!priceBookItemId) throw new Error("Pick a price book item");
  const qty = Number(str(formData, "qty") || "1") || 1;
  const override = dollarsToCents(formData, "priceOverride");
  const estimateId = await withTenant(session.organizationId, async (tx) => {
    const option = await tx.query.estimateOptions.findFirst({ where: eq(t.estimateOptions.id, optionId) });
    const item = await tx.query.priceBookItems.findFirst({ where: eq(t.priceBookItems.id, priceBookItemId) });
    if (!option || !item) throw new Error("Not found");
    await tx.insert(t.estimateLineItems).values({
      optionId,
      priceBookItemId,
      description: item.name,
      qty,
      unitPriceCents: override ?? item.unitPriceCents,
      unitCostCents: item.unitCostCents,
    });
    return option.estimateId;
  });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function updateLineItem(formData: FormData) {
  const session = await guard("estimates.create");
  const itemId = str(formData, "itemId");
  const qty = Number(str(formData, "qty"));
  const price = dollarsToCents(formData, "price");
  const estimateId = await withTenant(session.organizationId, async (tx) => {
    const row = await tx.query.estimateLineItems.findFirst({
      where: eq(t.estimateLineItems.id, itemId),
      with: { option: true },
    });
    if (!row) throw new Error("Line item not found");
    await tx
      .update(t.estimateLineItems)
      .set({
        qty: Number.isFinite(qty) && qty > 0 ? qty : row.qty,
        unitPriceCents: price ?? row.unitPriceCents,
      })
      .where(eq(t.estimateLineItems.id, itemId));
    return row.option.estimateId;
  });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function removeLineItem(formData: FormData) {
  const session = await guard("estimates.create");
  const itemId = str(formData, "itemId");
  const estimateId = await withTenant(session.organizationId, async (tx) => {
    const row = await tx.query.estimateLineItems.findFirst({
      where: eq(t.estimateLineItems.id, itemId),
      with: { option: true },
    });
    if (!row) return null;
    await tx.delete(t.estimateLineItems).where(eq(t.estimateLineItems.id, itemId));
    return row.option.estimateId;
  });
  if (!estimateId) return;
  revalidatePath(`/estimates/${estimateId}`);
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

/**
 * Approval-gated (constraint 8): the estimate no longer flips to SENT here.
 * It QUEUES an ESTIMATE_SEND for owner/office approval; approving it runs
 * reallySendEstimate (below). Same name/signature so the estimate page's
 * "Mark sent" button is untouched — its effect is now "queue for approval",
 * and we redirect the requester to the approvals queue.
 */
export async function markEstimateSent(formData: FormData) {
  const session = await guard("estimates.create");
  const estimateId = str(formData, "estimateId");
  await withTenant(session.organizationId, async (tx) => {
    const est = await tx.query.estimates.findFirst({
      where: eq(t.estimates.id, estimateId),
      with: { customer: true },
    });
    if (!est) throw new Error("Estimate not found");
    if (est.status !== "DRAFT") throw new Error("This estimate has already been sent.");
    // Don't double-queue if a request is already awaiting approval.
    const existing = await tx.query.outboundMessages.findFirst({
      where: and(
        eq(t.outboundMessages.estimateId, estimateId),
        eq(t.outboundMessages.status, "PENDING_APPROVAL")
      ),
    });
    if (existing) return;
    const recipient = est.customer.email ?? est.customer.phone ?? null;
    await tx.insert(t.outboundMessages).values({
      kind: "ESTIMATE_SEND",
      status: "PENDING_APPROVAL",
      customerId: est.customerId,
      recipient,
      subject: `Estimate ${est.number}`,
      body: `Send estimate ${est.number} to ${est.customer.name}. Approving delivers the proposal and starts the default 7-day follow-up sequence (5 SMS + 2 email).`,
      estimateId: est.id,
      requestedById: session.userId,
    });
  });
  await notifyApprovers(
    session.organizationId,
    session.userId,
    "✉️ Estimate send awaiting approval",
    `${session.name} queued an estimate for delivery.`
  );
  await audit(session.userId, "QUEUE_OUTBOUND", "Estimate", estimateId, { kind: "ESTIMATE_SEND" });
  revalidateSales(undefined, estimateId);
  redirect("/approvals");
}

/**
 * Executes an approved ESTIMATE_SEND — the real "send". Mirrors the pre-gate
 * behaviour: flips the estimate to SENT, starts the 7-day follow-up cadence
 * (only if not already present), and advances the lead. Called by
 * approveOutbound (@/lib/actions/approvals). actorUserId is the requester.
 */
export async function reallySendEstimate(organizationId: string, estimateId: string, actorUserId: string) {
  const est = await withTenant(organizationId, async (tx) => {
    const est = await tx.query.estimates.findFirst({
      where: eq(t.estimates.id, estimateId),
      with: { customer: true, lead: true },
    });
    if (!est) throw new Error("Estimate not found");
    const now = new Date();
    await tx.update(t.estimates).set({ status: "SENT", sentAt: now }).where(eq(t.estimates.id, estimateId));

    // Default-on follow-up automation: 7 touches over 7 days — only if not present.
    const existingFollowUps = await tx.query.followUps.findMany({
      where: eq(t.followUps.estimateId, estimateId),
    });
    if (existingFollowUps.length === 0) {
      const cadence = followUpCadence(est.number, est.lead?.contactName ?? est.customer.name);
      await tx.insert(t.followUps).values(
        cadence.map((c) => {
          const dueAt = new Date(now);
          dueAt.setDate(dueAt.getDate() + c.day);
          dueAt.setHours(c.hour, 0, 0, 0);
          return { estimateId, channel: c.channel, status: "PENDING" as const, dueAt, body: c.body };
        })
      );
    }

    if (est.leadId) await applyLeadStage(tx, est.leadId, "ESTIMATE_SENT", actorUserId);
    return est;
  });

  await logActivity({
    kind: "SYSTEM",
    body: `Estimate ${est.number} sent to ${est.customer.name} — 7-day follow-up sequence started (5 SMS + 2 email)`,
    userId: actorUserId,
    customerId: est.customerId,
    leadId: est.leadId ?? undefined,
  });
  revalidateSales(est.leadId ?? undefined, estimateId);
  return est;
}

/** Demo hook: simulate the customer opening their proposal link. */
export async function recordEstimateView(formData: FormData) {
  const session = await requireSession();
  const estimateId = str(formData, "estimateId");
  const { est, views } = await withTenant(session.organizationId, async (tx) => {
    const est = await tx.query.estimates.findFirst({ where: eq(t.estimates.id, estimateId), with: { customer: true } });
    if (!est) throw new Error("Estimate not found");
    const views = est.viewCount + 1;
    await tx
      .update(t.estimates)
      .set({
        viewCount: views,
        lastViewedAt: new Date(),
        status: est.status === "SENT" || est.status === "VIEWED" ? "VIEWED" : est.status,
      })
      .where(eq(t.estimates.id, estimateId));
    return { est, views };
  });
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

  const { est, option, total, commissionCents } = await withTenant(session.organizationId, async (tx) => {
    const est = await tx.query.estimates.findFirst({
      where: eq(t.estimates.id, estimateId),
      with: { options: { with: { items: true } }, customer: { with: { properties: true } } },
    });
    if (!est) throw new Error("Estimate not found");
    if (est.status === "APPROVED") throw new Error("Estimate already approved");
    const option = est.options.find((o) => o.id === optionId);
    if (!option) throw new Error("Option not found");

    const total = lineTotal(option.items);
    const now = new Date();

    await tx.update(t.estimateOptions).set({ selected: false }).where(eq(t.estimateOptions.estimateId, estimateId));
    await tx.update(t.estimateOptions).set({ selected: true }).where(eq(t.estimateOptions.id, optionId));
    await tx
      .update(t.estimates)
      .set({ status: "APPROVED", signedName, signedAt: now })
      .where(eq(t.estimates.id, estimateId));

    // 5% of sold revenue for the estimate creator.
    const commissionCents = Math.round(total * 0.05);
    await tx.insert(t.commissionEntries).values({
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
        const jobNumber = await nextDocNumber(tx, "J", "jobs");
        const [job] = await tx
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
        await tx.update(t.estimates).set({ jobId: job.id }).where(eq(t.estimates.id, estimateId));
      }
    }

    // Auto-stop the follow-up sequence and mark the lead won.
    await tx
      .update(t.followUps)
      .set({ status: "SKIPPED" })
      .where(and(eq(t.followUps.estimateId, estimateId), eq(t.followUps.status, "PENDING")));
    if (est.leadId) await applyLeadStage(tx, est.leadId, "WON", session.userId);

    return { est, option, total, commissionCents };
  });

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
  const est = await withTenant(session.organizationId, async (tx) => {
    const est = await tx.query.estimates.findFirst({ where: eq(t.estimates.id, estimateId), with: { customer: true } });
    if (!est) throw new Error("Estimate not found");
    await tx.update(t.estimates).set({ status: "DECLINED" }).where(eq(t.estimates.id, estimateId));
    await tx
      .update(t.followUps)
      .set({ status: "SKIPPED" })
      .where(and(eq(t.followUps.estimateId, estimateId), eq(t.followUps.status, "PENDING")));
    if (est.leadId) await applyLeadStage(tx, est.leadId, "LOST", session.userId, reason);
    return est;
  });
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
  const { ms, note } = await withTenant(session.organizationId, async (tx) => {
    const ms = await tx.query.milestones.findFirst({ where: eq(t.milestones.id, milestoneId), with: { project: true } });
    if (!ms) throw new Error("Milestone not found");

    let target = to;
    let note = `Milestone "${ms.name}" → ${to}`;
    if (to === "COMPLETE" && ms.requiresInspection) {
      const passed = await tx.query.permits.findFirst({
        where: and(eq(t.permits.projectId, ms.projectId), eq(t.permits.status, "PASSED")),
      });
      if (!passed) {
        target = "BLOCKED";
        note = `Milestone "${ms.name}" blocked — requires a PASSED inspection before completion`;
      }
    }
    await tx.update(t.milestones).set({ status: target }).where(eq(t.milestones.id, milestoneId));
    return { ms, note };
  });
  await logActivity({ kind: "STATUS", body: note, userId: session.userId, projectId: ms.projectId });
  revalidatePath(`/projects/${ms.projectId}`);
  revalidatePath("/projects");
}

export async function generateMilestoneInvoice(formData: FormData) {
  const session = await guard("projects.manage");
  const milestoneId = str(formData, "milestoneId");
  const { ms, number } = await withTenant(session.organizationId, async (tx) => {
    const ms = await tx.query.milestones.findFirst({ where: eq(t.milestones.id, milestoneId), with: { project: true } });
    if (!ms) throw new Error("Milestone not found");
    if (ms.billed) throw new Error("Milestone already billed");
    if (ms.billingAmountCents <= 0) throw new Error("Milestone has no billing amount");

    const number = await nextDocNumber(tx, "INV", "invoices");
    const now = new Date();
    const dueAt = new Date(now);
    dueAt.setDate(dueAt.getDate() + 30);
    const [invoice] = await tx
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
    await tx.insert(t.invoiceLineItems).values({
      invoiceId: invoice.id,
      description: `Progress billing — milestone: ${ms.name} (${ms.project.name})`,
      qty: 1,
      unitPriceCents: ms.billingAmountCents,
    });
    await tx.update(t.milestones).set({ billed: true }).where(eq(t.milestones.id, milestoneId));
    return { ms, number };
  });
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
  const number = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.changeOrders.findMany({ where: eq(t.changeOrders.projectId, projectId) });
    const number = `CO-${String(existing.length + 1).padStart(2, "0")}`;
    await tx.insert(t.changeOrders).values({
      projectId,
      number,
      description,
      amountCents,
      status: "PENDING_SIGNATURE",
    });
    return number;
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
  const co = await withTenant(session.organizationId, async (tx) => {
    const co = await tx.query.changeOrders.findFirst({ where: eq(t.changeOrders.id, changeOrderId) });
    if (!co) throw new Error("Change order not found");
    await tx
      .update(t.changeOrders)
      .set({ status: "APPROVED", signedName, signedAt: new Date() })
      .where(eq(t.changeOrders.id, changeOrderId));
    return co;
  });
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
  await withTenant(session.organizationId, (tx) =>
    tx.insert(t.permits).values({
      projectId,
      jurisdiction,
      permitNumber: str(formData, "permitNumber") || null,
      feeCents: dollarsToCents(formData, "fee"),
      status: "NOT_APPLIED",
      notes: str(formData, "notes") || null,
    })
  );
  await logActivity({ kind: "SYSTEM", body: `Permit added — ${jurisdiction}`, userId: session.userId, projectId });
  revalidatePath(`/projects/${projectId}`);
}

export async function setPermitStatus(formData: FormData) {
  const session = await guard("projects.manage");
  const permitId = str(formData, "permitId");
  const to = str(formData, "to") as (typeof t.permits.$inferSelect)["status"];

  const patch: Partial<typeof t.permits.$inferInsert> = { status: to };
  if (to === "INSPECTION_SCHEDULED") {
    const raw = str(formData, "inspectionAt");
    if (!raw) throw new Error("Pick an inspection date/time");
    patch.inspectionAt = new Date(raw);
  }
  const permitNumber = str(formData, "permitNumber");
  if (permitNumber) patch.permitNumber = permitNumber;

  const permit = await withTenant(session.organizationId, async (tx) => {
    const permit = await tx.query.permits.findFirst({ where: eq(t.permits.id, permitId) });
    if (!permit) throw new Error("Permit not found");
    await tx.update(t.permits).set(patch).where(eq(t.permits.id, permitId));
    return permit;
  });
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
  await withTenant(session.organizationId, (tx) =>
    tx.insert(t.costEntries).values({ projectId, kind, description, amountCents })
  );
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
  await withTenant(session.organizationId, (tx) =>
    tx.insert(t.subcontractors).values({
      projectId,
      name,
      trade,
      phone: str(formData, "phone") || null,
      licenseNumber: str(formData, "licenseNumber") || null,
      coiExpiresAt: coiRaw ? new Date(coiRaw) : null,
    })
  );
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
