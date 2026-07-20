"use server";

/* M3 money-layer actions — estimates (standalone create, option management,
 * expire/reopen, claim linking, duplicate), invoices (standalone create,
 * DRAFT line/date editing, reminders, void & duplicate), and commissions
 * (rule edit/delete, bulk approve/pay, un-approve, manual entries).
 * Plan §2 principle 4: money is immutable once real — corrections happen
 * through explicit reversal records, never in-place edits. */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { t, withTenant, type TenantDb } from "@/db";
import { requireSession } from "@/lib/auth";
import { can, type Permission } from "@/lib/permissions";
import { audit, logActivity, notify } from "@/lib/actions/helpers";
import { money } from "@/lib/format";
import {
  commissionUnapproveBlocker,
  estimateExpireBlocker,
  estimateReopenBlocker,
  invoiceEditBlocker,
  invoiceVoidBlocker,
  type CommissionStatus,
  type EstimateStatus,
  type InvoiceStatus,
} from "@/lib/manage/lifecycle";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function dollarsToCents(fd: FormData, key: string): number | null {
  const raw = str(fd, key).replace(/[$,\s]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

async function guard(permission: Permission) {
  const session = await requireSession();
  if (!can(session.role, permission)) throw new Error("Not allowed");
  return session;
}

async function nextDocNumber(tx: TenantDb, prefix: string, kind: "estimates" | "invoices"): Promise<string> {
  const rows =
    kind === "estimates"
      ? await tx.select({ n: t.estimates.number }).from(t.estimates)
      : await tx.select({ n: t.invoices.number }).from(t.invoices);
  let max = 1000;
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${max + 1}`;
}

// ═══════════════════════════════ ESTIMATES ═══════════════════════════════════

/** Standalone estimate — no lead required (M3). */
export async function createStandaloneEstimate(formData: FormData) {
  const session = await guard("estimates.create");
  const customerId = str(formData, "customerId");
  if (!customerId) return;
  const propertyId = str(formData, "propertyId") || null;
  const notes = str(formData, "notes");

  const estimate = await withTenant(session.organizationId, async (tx) => {
    if (propertyId) {
      const prop = await tx.query.properties.findFirst({ where: eq(t.properties.id, propertyId) });
      if (!prop || prop.customerId !== customerId) throw new Error("Property does not belong to that customer");
    }
    const number = await nextDocNumber(tx, "E", "estimates");
    const [estimate] = await tx
      .insert(t.estimates)
      .values({
        number,
        status: "DRAFT",
        customerId,
        propertyId,
        createdById: session.userId,
        notes: notes || null,
      })
      .returning();
    await tx.insert(t.estimateOptions).values([
      { estimateId: estimate.id, tier: "GOOD", name: "Good", description: "Gets the job done", sortOrder: 0 },
      { estimateId: estimate.id, tier: "BETTER", name: "Better", description: "Our most popular package", sortOrder: 1 },
      { estimateId: estimate.id, tier: "BEST", name: "Best", description: "Top-of-the-line, longest warranty", sortOrder: 2 },
    ]);
    return estimate;
  });

  await audit(session.userId, "CREATE", "Estimate", estimate.id, { number: estimate.number, standalone: true });
  await logActivity({
    kind: "SYSTEM",
    body: `Estimate ${estimate.number} created by ${session.name} (standalone)`,
    userId: session.userId,
    customerId,
  });
  revalidatePath("/estimates");
  redirect(`/estimates/${estimate.id}`);
}

/** Edit an option's name/description/tier. */
export async function updateEstimateOption(formData: FormData) {
  const session = await guard("estimates.create");
  const optionId = str(formData, "optionId");
  const name = str(formData, "name");
  if (!optionId || !name) return;
  const tierRaw = str(formData, "tier");
  const tier = (["GOOD", "BETTER", "BEST", "CUSTOM"] as const).find((x) => x === tierRaw);

  const estimateId = await withTenant(session.organizationId, async (tx) => {
    const option = await tx.query.estimateOptions.findFirst({
      where: eq(t.estimateOptions.id, optionId),
      with: { estimate: true },
    });
    if (!option) return null;
    if (!["DRAFT", "SENT", "VIEWED"].includes(option.estimate.status)) {
      throw new Error("Decided estimates can't be edited");
    }
    await tx
      .update(t.estimateOptions)
      .set({ name, description: str(formData, "description") || null, ...(tier ? { tier } : {}) })
      .where(eq(t.estimateOptions.id, optionId));
    return option.estimateId;
  });
  if (!estimateId) return;
  await audit(session.userId, "UPDATE", "EstimateOption", optionId, { name });
  revalidatePath(`/estimates/${estimateId}`);
}

/** Remove an option (never the approved/selected one). */
export async function removeEstimateOption(formData: FormData) {
  const session = await guard("estimates.create");
  const optionId = str(formData, "optionId");
  if (!optionId) return;
  const estimateId = await withTenant(session.organizationId, async (tx) => {
    const option = await tx.query.estimateOptions.findFirst({
      where: eq(t.estimateOptions.id, optionId),
      with: { estimate: true },
    });
    if (!option) return null;
    if (option.selected) throw new Error("The selected option can't be removed");
    if (!["DRAFT", "SENT", "VIEWED"].includes(option.estimate.status)) {
      throw new Error("Decided estimates can't be edited");
    }
    await tx.delete(t.estimateOptions).where(eq(t.estimateOptions.id, optionId));
    return option.estimateId;
  });
  if (!estimateId) return;
  await audit(session.userId, "OPTION_REMOVED", "EstimateOption", optionId, {});
  revalidatePath(`/estimates/${estimateId}`);
}

/** Reorder options (swap sortOrder with the neighbor). */
export async function moveEstimateOption(formData: FormData) {
  const session = await guard("estimates.create");
  const optionId = str(formData, "optionId");
  const dir = str(formData, "dir") === "-1" ? -1 : 1;
  if (!optionId) return;
  const estimateId = await withTenant(session.organizationId, async (tx) => {
    const option = await tx.query.estimateOptions.findFirst({ where: eq(t.estimateOptions.id, optionId) });
    if (!option) return null;
    const siblings = await tx.query.estimateOptions.findMany({
      where: eq(t.estimateOptions.estimateId, option.estimateId),
      orderBy: asc(t.estimateOptions.sortOrder),
    });
    const idx = siblings.findIndex((s) => s.id === optionId);
    const neighbor = siblings[idx + dir];
    if (!neighbor) return option.estimateId;
    await tx.update(t.estimateOptions).set({ sortOrder: neighbor.sortOrder }).where(eq(t.estimateOptions.id, option.id));
    await tx.update(t.estimateOptions).set({ sortOrder: option.sortOrder }).where(eq(t.estimateOptions.id, neighbor.id));
    return option.estimateId;
  });
  if (!estimateId) return;
  revalidatePath(`/estimates/${estimateId}`);
}

/** Edit notes + the financing toggle. */
export async function updateEstimateDetails(formData: FormData) {
  const session = await guard("estimates.create");
  const estimateId = str(formData, "estimateId");
  if (!estimateId) return;
  await withTenant(session.organizationId, (tx) =>
    tx
      .update(t.estimates)
      .set({ notes: str(formData, "notes") || null, financingOffered: str(formData, "financingOffered") === "on" })
      .where(eq(t.estimates.id, estimateId))
  );
  await audit(session.userId, "UPDATE", "Estimate", estimateId, { financingOffered: str(formData, "financingOffered") === "on" });
  revalidatePath(`/estimates/${estimateId}`);
}

/** Mark an add-on line optional (excluded from the base total) or back. */
export async function toggleLineItemOptional(formData: FormData) {
  const session = await guard("estimates.create");
  const itemId = str(formData, "itemId");
  if (!itemId) return;
  const estimateId = await withTenant(session.organizationId, async (tx) => {
    const row = await tx.query.estimateLineItems.findFirst({
      where: eq(t.estimateLineItems.id, itemId),
      with: { option: true },
    });
    if (!row) return null;
    await tx.update(t.estimateLineItems).set({ optional: !row.optional }).where(eq(t.estimateLineItems.id, itemId));
    return row.option.estimateId;
  });
  if (!estimateId) return;
  revalidatePath(`/estimates/${estimateId}`);
}

/** Manual EXPIRED (open estimates only). Pending follow-ups stop. */
export async function expireEstimate(formData: FormData) {
  const session = await guard("estimates.create");
  const estimateId = str(formData, "estimateId");
  if (!estimateId) return;
  const est = await withTenant(session.organizationId, async (tx) => {
    const est = await tx.query.estimates.findFirst({ where: eq(t.estimates.id, estimateId) });
    if (!est) return null;
    const blocker = estimateExpireBlocker(est.status as EstimateStatus);
    if (blocker) throw new Error(blocker);
    await tx.update(t.estimates).set({ status: "EXPIRED" }).where(eq(t.estimates.id, estimateId));
    await tx
      .update(t.followUps)
      .set({ status: "SKIPPED" })
      .where(and(eq(t.followUps.estimateId, estimateId), eq(t.followUps.status, "PENDING")));
    return est;
  });
  if (!est) return;
  await audit(session.userId, "ESTIMATE_EXPIRED", "Estimate", estimateId, { number: est.number, manual: true });
  await logActivity({
    kind: "STATUS",
    body: `Estimate ${est.number} marked EXPIRED — follow-ups stopped`,
    userId: session.userId,
    customerId: est.customerId,
    leadId: est.leadId ?? undefined,
  });
  revalidatePath(`/estimates/${estimateId}`);
  revalidatePath("/estimates");
}

/** Reopen a DECLINED/EXPIRED estimate back to DRAFT for another round. */
export async function reopenEstimate(formData: FormData) {
  const session = await guard("estimates.create");
  const estimateId = str(formData, "estimateId");
  const reason = str(formData, "reason");
  if (!estimateId) return;
  if (!reason) throw new Error("A reopen reason is required");
  const est = await withTenant(session.organizationId, async (tx) => {
    const est = await tx.query.estimates.findFirst({ where: eq(t.estimates.id, estimateId) });
    if (!est) return null;
    const blocker = estimateReopenBlocker(est.status as EstimateStatus);
    if (blocker) throw new Error(blocker);
    await tx
      .update(t.estimates)
      .set({ status: "DRAFT", sentAt: null, expiresAt: null })
      .where(eq(t.estimates.id, estimateId));
    return est;
  });
  if (!est) return;
  await audit(session.userId, "ESTIMATE_REOPENED", "Estimate", estimateId, { number: est.number, from: est.status, reason });
  await logActivity({
    kind: "STATUS",
    body: `Estimate ${est.number} reopened (${est.status} → DRAFT) — ${reason}`,
    userId: session.userId,
    customerId: est.customerId,
    leadId: est.leadId ?? undefined,
  });
  revalidatePath(`/estimates/${estimateId}`);
  revalidatePath("/estimates");
}

/** Link/unlink an insurance claim from the builder (closes the claims dead-end). */
export async function setEstimateClaim(formData: FormData) {
  const session = await guard("estimates.create");
  const estimateId = str(formData, "estimateId");
  if (!estimateId) return;
  const claimId = str(formData, "claimId") || null;

  const result = await withTenant(session.organizationId, async (tx) => {
    const est = await tx.query.estimates.findFirst({ where: eq(t.estimates.id, estimateId) });
    if (!est) return null;
    let claimNumber: string | null = null;
    if (claimId) {
      const claim = await tx.query.claims.findFirst({ where: eq(t.claims.id, claimId) });
      if (!claim) throw new Error("Claim not found");
      claimNumber = claim.claimNumber;
    }
    await tx.update(t.estimates).set({ claimId }).where(eq(t.estimates.id, estimateId));
    return { est, claimNumber };
  });
  if (!result) return;
  await audit(session.userId, claimId ? "CLAIM_LINKED" : "CLAIM_UNLINKED", "Estimate", estimateId, {
    number: result.est.number,
    claim: result.claimNumber,
  });
  await logActivity({
    kind: "SYSTEM",
    body: claimId
      ? `Estimate ${result.est.number} linked to insurance claim ${result.claimNumber}`
      : `Estimate ${result.est.number} unlinked from its insurance claim`,
    userId: session.userId,
    customerId: result.est.customerId,
  });
  revalidatePath(`/estimates/${estimateId}`);
  revalidatePath("/claims");
}

/** Duplicate as a fresh DRAFT (options + lines copied; engagement reset). */
export async function duplicateEstimate(formData: FormData) {
  const session = await guard("estimates.create");
  const estimateId = str(formData, "estimateId");
  if (!estimateId) return;

  const created = await withTenant(session.organizationId, async (tx) => {
    const est = await tx.query.estimates.findFirst({
      where: eq(t.estimates.id, estimateId),
      with: { options: { with: { items: true } } },
    });
    if (!est) return null;
    const number = await nextDocNumber(tx, "E", "estimates");
    const [copy] = await tx
      .insert(t.estimates)
      .values({
        number,
        status: "DRAFT",
        customerId: est.customerId,
        propertyId: est.propertyId,
        leadId: est.leadId,
        claimId: est.claimId,
        createdById: session.userId,
        notes: est.notes,
        financingOffered: est.financingOffered,
      })
      .returning();
    for (const o of est.options) {
      const [newOpt] = await tx
        .insert(t.estimateOptions)
        .values({
          estimateId: copy.id,
          tier: o.tier,
          name: o.name,
          description: o.description,
          sortOrder: o.sortOrder,
          selected: false,
        })
        .returning();
      if (o.items.length > 0) {
        await tx.insert(t.estimateLineItems).values(
          o.items.map((i) => ({
            optionId: newOpt.id,
            priceBookItemId: i.priceBookItemId,
            description: i.description,
            qty: i.qty,
            unitPriceCents: i.unitPriceCents,
            unitCostCents: i.unitCostCents,
            optional: i.optional,
          }))
        );
      }
    }
    return { copy, source: est };
  });
  if (!created) return;

  await audit(session.userId, "ESTIMATE_DUPLICATED", "Estimate", created.copy.id, {
    number: created.copy.number,
    from: created.source.number,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Estimate ${created.copy.number} duplicated from ${created.source.number}`,
    userId: session.userId,
    customerId: created.source.customerId,
  });
  revalidatePath("/estimates");
  redirect(`/estimates/${created.copy.id}`);
}

/** Lazy sweep: SENT/VIEWED estimates past expiresAt → EXPIRED (audited as system). */
export async function sweepExpiredEstimates(organizationId: string): Promise<number> {
  return withTenant(organizationId, async (tx) => {
    const stale = await tx.query.estimates.findMany({
      where: and(inArray(t.estimates.status, ["SENT", "VIEWED"])),
    });
    const now = Date.now();
    const toExpire = stale.filter((e) => e.expiresAt && e.expiresAt.getTime() < now);
    for (const e of toExpire) {
      await tx.update(t.estimates).set({ status: "EXPIRED" }).where(eq(t.estimates.id, e.id));
      await tx
        .update(t.followUps)
        .set({ status: "SKIPPED" })
        .where(and(eq(t.followUps.estimateId, e.id), eq(t.followUps.status, "PENDING")));
    }
    return toExpire.length;
  });
}

// ═══════════════════════════════ INVOICES ════════════════════════════════════

/** Standalone DRAFT invoice for any customer (M3). */
export async function createStandaloneInvoice(formData: FormData) {
  const session = await guard("invoices.create");
  const customerId = str(formData, "customerId");
  if (!customerId) return;

  const invoice = await withTenant(session.organizationId, async (tx) => {
    const number = await nextDocNumber(tx, "INV", "invoices");
    const [invoice] = await tx.insert(t.invoices).values({ number, status: "DRAFT", customerId }).returning();
    return invoice;
  });
  await audit(session.userId, "CREATE", "Invoice", invoice.id, { number: invoice.number, standalone: true });
  await logActivity({
    kind: "SYSTEM",
    body: `Invoice ${invoice.number} drafted by ${session.name} (standalone)`,
    userId: session.userId,
    customerId,
  });
  revalidatePath("/invoices");
  redirect(`/invoices/${invoice.id}`);
}

async function draftInvoiceOrThrow(tx: TenantDb, invoiceId: string) {
  const inv = await tx.query.invoices.findFirst({ where: eq(t.invoices.id, invoiceId) });
  if (!inv) throw new Error("Invoice not found");
  const blocker = invoiceEditBlocker(inv.status as InvoiceStatus);
  if (blocker) throw new Error(blocker);
  return inv;
}

/** Add a line while DRAFT — from the price book or free text. */
export async function addInvoiceLine(formData: FormData) {
  const session = await guard("invoices.create");
  const invoiceId = str(formData, "invoiceId");
  if (!invoiceId) return;
  const priceBookItemId = str(formData, "priceBookItemId");
  const qty = Number(str(formData, "qty") || "1") || 1;

  await withTenant(session.organizationId, async (tx) => {
    await draftInvoiceOrThrow(tx, invoiceId);
    if (priceBookItemId) {
      const item = await tx.query.priceBookItems.findFirst({ where: eq(t.priceBookItems.id, priceBookItemId) });
      if (!item) throw new Error("Price book item not found");
      const override = dollarsToCents(formData, "price");
      await tx.insert(t.invoiceLineItems).values({
        invoiceId,
        priceBookItemId,
        description: item.name,
        qty,
        unitPriceCents: override ?? item.unitPriceCents,
      });
    } else {
      const description = str(formData, "description");
      const price = dollarsToCents(formData, "price");
      if (!description || price == null) throw new Error("Description and price are required for a custom line");
      await tx.insert(t.invoiceLineItems).values({ invoiceId, description, qty, unitPriceCents: price });
    }
  });
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
}

export async function updateInvoiceLine(formData: FormData) {
  const session = await guard("invoices.create");
  const lineId = str(formData, "lineId");
  if (!lineId) return;
  const qty = Number(str(formData, "qty"));
  const price = dollarsToCents(formData, "price");

  const invoiceId = await withTenant(session.organizationId, async (tx) => {
    const row = await tx.query.invoiceLineItems.findFirst({ where: eq(t.invoiceLineItems.id, lineId) });
    if (!row) return null;
    await draftInvoiceOrThrow(tx, row.invoiceId);
    await tx
      .update(t.invoiceLineItems)
      .set({
        qty: Number.isFinite(qty) && qty > 0 ? qty : row.qty,
        unitPriceCents: price ?? row.unitPriceCents,
        description: str(formData, "description") || row.description,
      })
      .where(eq(t.invoiceLineItems.id, lineId));
    return row.invoiceId;
  });
  if (!invoiceId) return;
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
}

export async function removeInvoiceLine(formData: FormData) {
  const session = await guard("invoices.create");
  const lineId = str(formData, "lineId");
  if (!lineId) return;
  const invoiceId = await withTenant(session.organizationId, async (tx) => {
    const row = await tx.query.invoiceLineItems.findFirst({ where: eq(t.invoiceLineItems.id, lineId) });
    if (!row) return null;
    await draftInvoiceOrThrow(tx, row.invoiceId);
    await tx.delete(t.invoiceLineItems).where(eq(t.invoiceLineItems.id, lineId));
    return row.invoiceId;
  });
  if (!invoiceId) return;
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
}

/** Edit issued/due dates while DRAFT. */
export async function updateInvoiceDates(formData: FormData) {
  const session = await guard("invoices.create");
  const invoiceId = str(formData, "invoiceId");
  if (!invoiceId) return;
  const issuedAt = str(formData, "issuedAt");
  const dueAt = str(formData, "dueAt");
  await withTenant(session.organizationId, async (tx) => {
    await draftInvoiceOrThrow(tx, invoiceId);
    await tx
      .update(t.invoices)
      .set({ issuedAt: issuedAt ? new Date(issuedAt) : null, dueAt: dueAt ? new Date(dueAt) : null })
      .where(eq(t.invoices.id, invoiceId));
  });
  await audit(session.userId, "UPDATE", "Invoice", invoiceId, { issuedAt: issuedAt || null, dueAt: dueAt || null });
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
}

/** Queue a payment reminder (approval-gated, like every customer-facing send). */
export async function sendInvoiceReminder(formData: FormData) {
  const session = await guard("invoices.create");
  const invoiceId = str(formData, "invoiceId");
  if (!invoiceId) return;

  const inv = await withTenant(session.organizationId, async (tx) => {
    const inv = await tx.query.invoices.findFirst({
      where: eq(t.invoices.id, invoiceId),
      with: { customer: true, items: true, payments: true },
    });
    if (!inv) throw new Error("Invoice not found");
    if (!["SENT", "PARTIAL", "OVERDUE"].includes(inv.status)) {
      throw new Error("Reminders are for open, issued invoices");
    }
    const existing = await tx.query.outboundMessages.findFirst({
      where: and(eq(t.outboundMessages.subject, `Payment reminder — ${inv.number}`), eq(t.outboundMessages.status, "PENDING_APPROVAL")),
    });
    if (existing) return inv;
    const total = inv.items.reduce((s, i) => s + Math.round(i.qty * i.unitPriceCents), 0);
    const paid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
    await tx.insert(t.outboundMessages).values({
      kind: "CUSTOMER_MESSAGE",
      status: "PENDING_APPROVAL",
      customerId: inv.customerId,
      recipient: inv.customer.email ?? inv.customer.phone ?? null,
      subject: `Payment reminder — ${inv.number}`,
      body: `Hi ${inv.customer.name}, a friendly reminder that invoice ${inv.number} has a balance of ${money(total - paid)}${inv.dueAt ? ` (due ${inv.dueAt.toISOString().slice(0, 10)})` : ""}. Pay online any time — thank you!`,
      requestedById: session.userId,
    });
    return inv;
  });

  await audit(session.userId, "QUEUE_OUTBOUND", "Invoice", invoiceId, { kind: "PAYMENT_REMINDER", number: inv.number });
  await notify(
    session.userId,
    "✉️ Payment reminder queued",
    `Reminder for ${inv.number} is awaiting approval in the Approvals queue.`,
    "/approvals"
  );
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/approvals");
}

/** M6: bulk payment reminders — queue one approval-gated reminder per selected
 *  open invoice (already-queued invoices are skipped, never double-queued). */
export async function bulkInvoiceReminders(formData: FormData) {
  const session = await guard("invoices.create");
  const ids = formData.getAll("ids").map((v) => String(v)).filter(Boolean);
  if (ids.length === 0) return;

  const summary = await withTenant(session.organizationId, async (tx) => {
    let queued = 0;
    let skipped = 0;
    for (const id of ids) {
      const inv = await tx.query.invoices.findFirst({
        where: eq(t.invoices.id, id),
        with: { customer: true, items: true, payments: true },
      });
      if (!inv || !["SENT", "PARTIAL", "OVERDUE"].includes(inv.status)) {
        skipped++;
        continue;
      }
      const subject = `Payment reminder — ${inv.number}`;
      const existing = await tx.query.outboundMessages.findFirst({
        where: and(eq(t.outboundMessages.subject, subject), eq(t.outboundMessages.status, "PENDING_APPROVAL")),
      });
      if (existing) {
        skipped++;
        continue;
      }
      const total = inv.items.reduce((s, i) => s + Math.round(i.qty * i.unitPriceCents), 0);
      const paid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
      await tx.insert(t.outboundMessages).values({
        kind: "CUSTOMER_MESSAGE",
        status: "PENDING_APPROVAL",
        customerId: inv.customerId,
        recipient: inv.customer.email ?? inv.customer.phone ?? null,
        subject,
        body: `Hi ${inv.customer.name}, a friendly reminder that invoice ${inv.number} has a balance of ${money(total - paid)}${inv.dueAt ? ` (due ${inv.dueAt.toISOString().slice(0, 10)})` : ""}. Pay online any time — thank you!`,
        requestedById: session.userId,
      });
      queued++;
    }
    return { queued, skipped };
  });

  await audit(session.userId, "BULK_REMINDERS_QUEUED", "Invoice", undefined, { ...summary, requested: ids.length });
  await notify(
    session.userId,
    `✉️ ${summary.queued} payment reminder(s) queued for approval`,
    summary.skipped > 0 ? `${summary.skipped} skipped (not open, or already queued).` : "Approve them in the Approvals queue.",
    "/approvals"
  );
  revalidatePath("/invoices");
  revalidatePath("/approvals");
}

/** The correction path: VOID the original (terminal) + duplicate lines as a new DRAFT. */
export async function voidAndDuplicateInvoice(formData: FormData) {
  const session = await requireSession();
  if (session.role !== "ADMIN") throw new Error("Only admins can void invoices");
  const invoiceId = str(formData, "invoiceId");
  if (!invoiceId) return;

  const created = await withTenant(session.organizationId, async (tx) => {
    const inv = await tx.query.invoices.findFirst({ where: eq(t.invoices.id, invoiceId), with: { items: true } });
    if (!inv) return null;
    const blocker = invoiceVoidBlocker(inv.status as InvoiceStatus);
    if (blocker) throw new Error(blocker);
    await tx.update(t.invoices).set({ status: "VOID" }).where(eq(t.invoices.id, invoiceId));

    const number = await nextDocNumber(tx, "INV", "invoices");
    const [copy] = await tx
      .insert(t.invoices)
      .values({ number, status: "DRAFT", customerId: inv.customerId, jobId: inv.jobId, projectId: inv.projectId })
      .returning();
    if (inv.items.length > 0) {
      await tx.insert(t.invoiceLineItems).values(
        inv.items.map((i) => ({
          invoiceId: copy.id,
          priceBookItemId: i.priceBookItemId,
          description: i.description,
          qty: i.qty,
          unitPriceCents: i.unitPriceCents,
        }))
      );
    }
    return { inv, copy };
  });
  if (!created) return;

  await audit(session.userId, "VOID_AND_DUPLICATE", "Invoice", invoiceId, {
    voided: created.inv.number,
    draft: created.copy.number,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Invoice ${created.inv.number} voided and re-drafted as ${created.copy.number}`,
    userId: session.userId,
    customerId: created.inv.customerId,
  });
  revalidatePath("/invoices");
  redirect(`/invoices/${created.copy.id}`);
}

// ═══════════════════════════════ COMMISSIONS ═════════════════════════════════

const COMMISSION_KINDS = ["PERCENT_REVENUE", "PERCENT_MARGIN", "SPIFF"] as const;
const ROLES = ["TECH", "SALES_PM", "OFFICE", "ADMIN"] as const;

/** Edit a rule in place (a wrong rate is no longer stuck forever). */
export async function updateCommissionRule(formData: FormData) {
  const session = await guard("commissions.rules.manage");
  const ruleId = str(formData, "ruleId");
  const name = str(formData, "name");
  const rate = parseFloat(str(formData, "rate"));
  if (!ruleId || !name || !Number.isFinite(rate)) return;
  const kind = (COMMISSION_KINDS as readonly string[]).includes(str(formData, "kind"))
    ? (str(formData, "kind") as (typeof COMMISSION_KINDS)[number])
    : "PERCENT_REVENUE";
  const roleStr = str(formData, "role");
  const storedRate = kind === "SPIFF" ? Math.round(rate * 100) : rate;

  const rule = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.commissionRules.findFirst({ where: eq(t.commissionRules.id, ruleId) });
    if (!existing) return null;
    await tx
      .update(t.commissionRules)
      .set({
        name,
        kind,
        rate: storedRate,
        role: (ROLES as readonly string[]).includes(roleStr) ? (roleStr as (typeof ROLES)[number]) : null,
        category: str(formData, "category") || null,
      })
      .where(eq(t.commissionRules.id, ruleId));
    return existing;
  });
  if (!rule) return;
  await audit(session.userId, "UPDATE", "CommissionRule", ruleId, { name, kind, rate: storedRate, previousRate: rule.rate });
  revalidatePath("/settings");
  revalidatePath("/commissions");
}

/** Delete a rule outright (entries created under it are untouched). */
export async function deleteCommissionRule(formData: FormData) {
  const session = await guard("commissions.rules.manage");
  const ruleId = str(formData, "ruleId");
  if (!ruleId) return;
  const rule = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.commissionRules.findFirst({ where: eq(t.commissionRules.id, ruleId) });
    if (!existing) return null;
    await tx.delete(t.commissionRules).where(eq(t.commissionRules.id, ruleId));
    return existing;
  });
  if (!rule) return;
  await audit(session.userId, "RULE_DELETED", "CommissionRule", ruleId, { name: rule.name, rate: rule.rate });
  revalidatePath("/settings");
  revalidatePath("/commissions");
}

/** Bulk payroll run: approve all PENDING, or pay all APPROVED, for a period. */
export async function bulkCommission(formData: FormData) {
  const session = await guard("commissions.rules.manage");
  const period = str(formData, "period");
  const mode = str(formData, "mode"); // "approve" | "pay"
  if (!period || (mode !== "approve" && mode !== "pay")) return;
  const from = mode === "approve" ? "PENDING" : "APPROVED";
  const to = mode === "approve" ? "APPROVED" : "PAID";

  const affected = await withTenant(session.organizationId, async (tx) => {
    const rows = await tx.query.commissionEntries.findMany({
      where: and(eq(t.commissionEntries.period, period), eq(t.commissionEntries.status, from as CommissionStatus)),
    });
    if (rows.length > 0) {
      await tx
        .update(t.commissionEntries)
        .set({ status: to as CommissionStatus })
        .where(and(eq(t.commissionEntries.period, period), eq(t.commissionEntries.status, from as CommissionStatus)));
    }
    return rows;
  });

  await audit(session.userId, mode === "approve" ? "BULK_APPROVE" : "BULK_PAY", "CommissionEntry", period, {
    period,
    count: affected.length,
    totalCents: affected.reduce((s, e) => s + e.amountCents, 0),
  });
  revalidatePath("/commissions");
  revalidatePath("/settings");
  revalidatePath("/earnings");
}

/** Walk APPROVED back to PENDING with a reason. PAID stays immutable. */
export async function unapproveCommission(formData: FormData) {
  const session = await guard("commissions.rules.manage");
  const entryId = str(formData, "entryId");
  const reason = str(formData, "reason");
  if (!entryId) return;
  if (!reason) throw new Error("An un-approve reason is required");

  const entry = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.commissionEntries.findFirst({
      where: eq(t.commissionEntries.id, entryId),
      with: { user: true },
    });
    if (!existing) return null;
    const blocker = commissionUnapproveBlocker(existing.status as CommissionStatus);
    if (blocker) throw new Error(blocker);
    await tx.update(t.commissionEntries).set({ status: "PENDING" }).where(eq(t.commissionEntries.id, entryId));
    return existing;
  });
  if (!entry) return;
  await audit(session.userId, "COMMISSION_UNAPPROVED", "CommissionEntry", entryId, {
    user: entry.user.name,
    amountCents: entry.amountCents,
    reason,
  });
  revalidatePath("/commissions");
  revalidatePath("/earnings");
}

/** Manual entry — spiffs, corrections, adjustments (negative allowed). */
export async function createCommissionEntry(formData: FormData) {
  const session = await guard("commissions.rules.manage");
  const userId = str(formData, "userId");
  const description = str(formData, "description");
  const amountCents = dollarsToCents(formData, "amount");
  if (!userId || !description || amountCents == null || amountCents === 0) return;
  const period = /^\d{4}-\d{2}$/.test(str(formData, "period"))
    ? str(formData, "period")
    : new Date().toISOString().slice(0, 7);

  const [entry] = await withTenant(session.organizationId, (tx) =>
    tx
      .insert(t.commissionEntries)
      .values({
        userId,
        description: `${description} (manual entry by ${session.name})`,
        amountCents,
        period,
        status: "PENDING",
        sourceType: "MANUAL",
      })
      .returning()
  );
  await audit(session.userId, "COMMISSION_MANUAL", "CommissionEntry", entry.id, { userId, amountCents, period });
  await notify(userId, `💵 Commission entry added: ${money(amountCents)}`, description, "/earnings");
  revalidatePath("/commissions");
  revalidatePath("/earnings");
}
