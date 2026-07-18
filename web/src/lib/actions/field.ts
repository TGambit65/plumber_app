"use server";

import { t, withTenant, type TenantDb } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, logActivity, notify } from "./helpers";
import { orgName, sendTransactionalSms } from "@/lib/comms/sms";
import { and, asc, eq, isNull, like } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// ── Internal helpers (not exported — "use server" files may only export async fns) ──

type JobStatus = typeof t.jobs.$inferSelect.status;

const STATUS_FLOW: JobStatus[] = ["SCHEDULED", "DISPATCHED", "EN_ROUTE", "IN_PROGRESS", "COMPLETED"];

function revalidateJob(jobId: string) {
  revalidatePath("/my-day");
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/jobs/${jobId}/closeout`);
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

async function getJobOrThrow(tx: TenantDb, jobId: string) {
  const job = await tx.query.jobs.findFirst({
    where: eq(t.jobs.id, jobId),
    with: { customer: true, property: true },
  });
  if (!job) throw new Error("Job not found");
  return job;
}

async function usersByRole(tx: TenantDb, role: "TECH" | "SALES_PM" | "OFFICE" | "ADMIN") {
  return tx.select().from(t.users).where(and(eq(t.users.role, role), eq(t.users.active, true)));
}

/** Simple canned AI summary per job type (demo of voice-note → AI summary). */
function aiDraftSummary(jobType: string, customerName: string): string {
  const jt = jobType.toLowerCase();
  if (jt.includes("water heater"))
    return `Replaced/serviced water heater at ${customerName}'s property. Shut off gas and water, completed installation per SOP, installed new connectors, leak-tested every joint with solution, verified draft and set temperature to 120°F. Tested T&P relief valve and confirmed proper discharge termination. Area cleaned and old unit hauled away. System operating normally at departure.`;
  if (jt.includes("drain") || jt.includes("camera"))
    return `Cleared blockage in drain line at ${customerName}'s property using mainline auger. Ran water for 10+ minutes to confirm full flow. Recommended camera inspection due to recurring clogs — probable root intrusion or belly in the line. Work area cleaned and sanitized.`;
  if (jt.includes("leak"))
    return `Located and repaired active leak at ${customerName}'s property. Isolated supply, cut out damaged section, and installed new fitting. Pressure-tested repair and monitored for 15 minutes — no drips. Checked surrounding areas for water damage and advised customer on drying.`;
  if (jt.includes("toilet"))
    return `Removed existing toilet and installed new unit at ${customerName}'s property with new wax ring and supply line. Verified level set, secure mount, and leak-free operation over multiple flush cycles. Old fixture hauled away.`;
  if (jt.includes("sump"))
    return `Installed sump pump at ${customerName}'s property. Verified float operation, check valve orientation, and discharge routing. Cycled pump multiple times under load — normal operation confirmed.`;
  if (jt.includes("grease"))
    return `Performed grease trap service at ${customerName}'s property. Pumped trap, scraped baffles, inspected gaskets, and logged FOG depth for health-inspection records. Left signed service tag on unit.`;
  if (jt.includes("faucet") || jt.includes("fixture"))
    return `Installed new fixture at ${customerName}'s property with braided supply lines. Checked for leaks under operating pressure and verified smooth operation. Work area cleaned.`;
  return `Completed ${jobType} at ${customerName}'s property per standard operating procedure. All work tested and verified functioning; site left clean. Customer walked through the completed work on-site.`;
}

// ── Status machine ───────────────────────────────────────────────────────────

/**
 * Advance a job one step along SCHEDULED → DISPATCHED → EN_ROUTE → IN_PROGRESS.
 * COMPLETED is only reachable through finishCloseout(). Skipping states is rejected.
 */
export async function advanceJobStatus(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "jobs.work") && !can(session.role, "dispatch.manage"))
    throw new Error("Not allowed");

  const jobId = str(formData, "jobId");
  const to = str(formData, "to") as JobStatus;

  const job = await withTenant(session.organizationId, async (tx) => {
    const job = await getJobOrThrow(tx, jobId);

    const fromIdx = STATUS_FLOW.indexOf(job.status);
    const toIdx = STATUS_FLOW.indexOf(to);
    if (toIdx === -1 || fromIdx === -1) throw new Error(`Cannot advance from ${job.status}`);
    if (toIdx !== fromIdx + 1) throw new Error(`Invalid transition ${job.status} → ${to} (no skipping states)`);
    if (to === "COMPLETED") throw new Error("Completion goes through the closeout flow");

    await tx.update(t.jobs).set({ status: to }).where(eq(t.jobs.id, jobId));

    if (to === "EN_ROUTE") {
      // Travel clock starts
      await tx.insert(t.timeEntries).values({
        userId: session.userId,
        jobId,
        kind: "TRAVEL",
        startedAt: new Date(),
      });
    }

    if (to === "IN_PROGRESS") {
      // Close any open travel entry for this job, then start the work clock
      await tx
        .update(t.timeEntries)
        .set({ endedAt: new Date() })
        .where(
          and(
            eq(t.timeEntries.userId, session.userId),
            eq(t.timeEntries.jobId, jobId),
            isNull(t.timeEntries.endedAt)
          )
        );
      await tx.insert(t.timeEntries).values({
        userId: session.userId,
        jobId,
        kind: "WORK",
        startedAt: new Date(),
      });
    }

    return job;
  });

  await logActivity({
    kind: "STATUS",
    body: `Job ${job.number} status: ${job.status} → ${to} (${session.name})`,
    userId: session.userId,
    jobId,
    customerId: job.customerId,
  });

  if (to === "EN_ROUTE") {
    // D1: REAL on-my-way SMS via Twilio (templated → auto-send policy). The
    // activity log reflects what actually happened — never "sent" unless sent.
    const outcome = await sendTransactionalSms({
      organizationId: session.organizationId,
      requestedById: session.userId,
      kind: "ON_MY_WAY",
      customerId: job.customerId,
      jobId,
      params: {
        companyName: await orgName(session.organizationId),
        customerFirstName: job.customer.name,
        techName: session.name,
        jobType: job.jobType,
      },
    });
    await logActivity({
      kind: "SMS",
      body:
        outcome.status === "SENT"
          ? `On my way text sent to ${job.customer.name}`
          : `On my way text NOT sent to ${job.customer.name} (${outcome.status.toLowerCase().replace(/_/g, " ")}${outcome.error ? `: ${outcome.error}` : ""})`,
      userId: session.userId,
      jobId,
      customerId: job.customerId,
    });
  }

  await audit(session.userId, "JOB_STATUS_ADVANCE", "Job", jobId, { from: job.status, to });
  revalidateJob(jobId);
}

// ── Photos ───────────────────────────────────────────────────────────────────

export async function addJobPhoto(formData: FormData) {
  const session = await requireSession();
  const jobId = str(formData, "jobId");
  const kind = str(formData, "kind") as typeof t.jobPhotos.$inferSelect.kind;
  const caption = str(formData, "caption") || null;
  const url = str(formData, "url") || "/demo-photos/wh-before.svg";

  await withTenant(session.organizationId, async (tx) => {
    await getJobOrThrow(tx, jobId);
    await tx.insert(t.jobPhotos).values({ jobId, kind, url, caption, takenById: session.userId });
  });
  revalidateJob(jobId);
}

/** One-tap placeholder photo for the closeout flow (camera capture is simulated). */
export async function quickAddPhoto(formData: FormData) {
  const session = await requireSession();
  const jobId = str(formData, "jobId");
  const kind = str(formData, "kind") as typeof t.jobPhotos.$inferSelect.kind;

  const url = kind === "AFTER" ? "/demo-photos/wh-after.svg" : "/demo-photos/wh-before.svg";
  await withTenant(session.organizationId, async (tx) => {
    await getJobOrThrow(tx, jobId);
    await tx.insert(t.jobPhotos).values({
      jobId,
      kind,
      url,
      caption: `${kind.charAt(0) + kind.slice(1).toLowerCase()} photo (field capture)`,
      takenById: session.userId,
    });
  });
  revalidateJob(jobId);
}

// ── Forms ────────────────────────────────────────────────────────────────────

export async function completeJobForm(formData: FormData) {
  const session = await requireSession();
  const formId = str(formData, "formId");
  const note = str(formData, "note");

  const form = await withTenant(session.organizationId, async (tx) => {
    const form = await tx.query.jobForms.findFirst({ where: eq(t.jobForms.id, formId) });
    if (!form) throw new Error("Form not found");
    if (form.completedAt) return null;

    await tx
      .update(t.jobForms)
      .set({ completedAt: new Date(), data: { note: note || "Completed in field", completedBy: session.name } })
      .where(eq(t.jobForms.id, formId));
    return form;
  });
  if (!form) return;

  await logActivity({
    kind: "NOTE",
    body: `Form completed: ${form.name}`,
    userId: session.userId,
    jobId: form.jobId,
  });
  revalidateJob(form.jobId);
}

// ── Materials (truck stock decrement) ────────────────────────────────────────

export async function addMaterialUsage(formData: FormData) {
  const session = await requireSession();
  const jobId = str(formData, "jobId");
  const priceBookItemId = str(formData, "priceBookItemId");
  const qty = Math.max(0.1, Number(str(formData, "qty") || "1"));

  const { job, item, lowStock } = await withTenant(session.organizationId, async (tx) => {
    const job = await getJobOrThrow(tx, jobId);

    const item = await tx.query.priceBookItems.findFirst({ where: eq(t.priceBookItems.id, priceBookItemId) });
    if (!item) throw new Error("Price book item not found");

    await tx.insert(t.materialUsages).values({ jobId, priceBookItemId, qty });

    // Decrement the tech's truck stock if a matching stock row exists
    let lowStock: { newQty: number; minQty: number } | null = null;
    const [truck] = await tx
      .select()
      .from(t.inventoryLocations)
      .where(eq(t.inventoryLocations.userId, session.userId));
    if (truck) {
      const [stock] = await tx
        .select()
        .from(t.stockLevels)
        .where(and(eq(t.stockLevels.locationId, truck.id), eq(t.stockLevels.priceBookItemId, priceBookItemId)));
      if (stock) {
        const newQty = Math.max(0, stock.qtyOnHand - qty);
        await tx.update(t.stockLevels).set({ qtyOnHand: newQty }).where(eq(t.stockLevels.id, stock.id));
        if (newQty < stock.minQty) lowStock = { newQty, minQty: stock.minQty };
      }
    }

    return { job, item, lowStock };
  });

  if (lowStock) {
    await notify(
      session.userId,
      `Truck below min: ${item.name} (${lowStock.newQty} of ${lowStock.minQty})`,
      "Added to your replenishment list.",
      "/inventory"
    );
  }

  await logActivity({
    kind: "NOTE",
    body: `Material used on ${job.number}: ${qty} × ${item.name}`,
    userId: session.userId,
    jobId,
  });
  revalidateJob(jobId);
}

// ── Part requests ────────────────────────────────────────────────────────────

export async function createPartRequest(formData: FormData) {
  const session = await requireSession();
  const jobId = str(formData, "jobId") || null;
  const description = str(formData, "description");
  const qty = Math.max(1, Number(str(formData, "qty") || "1"));
  if (!description) throw new Error("Description required");

  const office = await withTenant(session.organizationId, async (tx) => {
    await tx.insert(t.partRequests).values({
      requestedById: session.userId,
      jobId,
      description,
      qty,
      status: "OPEN",
    });
    return usersByRole(tx, "OFFICE");
  });

  for (const u of office) {
    await notify(
      u.id,
      `Part request from ${session.name}: ${description}`,
      `Qty ${qty}${jobId ? " — filed from a job" : ""}`,
      "/inventory"
    );
  }
  if (jobId) {
    await logActivity({
      kind: "NOTE",
      body: `Part requested: ${qty} × ${description}`,
      userId: session.userId,
      jobId,
    });
    revalidateJob(jobId);
  }
  revalidatePath("/my-day");
}

// ── Tech lead-flag (spiff) ───────────────────────────────────────────────────

export async function flagOpportunity(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "leads.create")) throw new Error("Not allowed");

  const jobId = str(formData, "jobId");
  const title = str(formData, "title");
  const description = str(formData, "description") || null;
  const estValue = Number(str(formData, "estValue") || "0");
  if (!title) throw new Error("Title required");

  const { job, lead, salesUsers } = await withTenant(session.organizationId, async (tx) => {
    const job = await getJobOrThrow(tx, jobId);

    const [lead] = await tx
      .insert(t.leads)
      .values({
        source: "TECH_FLAGGED",
        stage: "NEW",
        title,
        contactName: job.customer.name,
        phone: job.customer.phone,
        email: job.customer.email,
        description,
        estValueCents: estValue > 0 ? Math.round(estValue * 100) : null,
        customerId: job.customerId,
        propertyId: job.propertyId,
        createdById: session.userId,
        techFlagged: true,
        spiffCents: 5000,
      })
      .returning();

    const salesUsers = await usersByRole(tx, "SALES_PM");
    return { job, lead, salesUsers };
  });

  for (const u of salesUsers) {
    await notify(
      u.id,
      `⚠ Tech-flagged opportunity: ${title}`,
      `${session.name} flagged this on ${job.number} (${job.customer.name}). $50 spiff attached.`,
      "/leads"
    );
  }

  await logActivity({
    kind: "NOTE",
    body: `Opportunity flagged for sales: "${title}" ($50 spiff pending)`,
    userId: session.userId,
    jobId,
    customerId: job.customerId,
    leadId: lead.id,
  });
  await audit(session.userId, "LEAD_TECH_FLAG", "Lead", lead.id, { jobId, title });
  revalidateJob(jobId);
}

// ── Closeout: work summary ───────────────────────────────────────────────────

export async function saveWorkSummary(formData: FormData) {
  const session = await requireSession();
  const jobId = str(formData, "jobId");
  const mode = str(formData, "mode");

  const { job, summary } = await withTenant(session.organizationId, async (tx) => {
    const job = await getJobOrThrow(tx, jobId);

    let summary = str(formData, "summary");
    if (mode === "ai" || !summary) summary = aiDraftSummary(job.jobType, job.customer.name);

    const stamp = `[Closeout summary — ${session.name}] ${summary}`;
    await tx
      .update(t.jobs)
      .set({ internalNotes: job.internalNotes ? `${job.internalNotes}\n\n${stamp}` : stamp })
      .where(eq(t.jobs.id, jobId));
    return { job, summary };
  });

  await logActivity({
    kind: "NOTE",
    body: `Work summary: ${summary}`,
    userId: session.userId,
    jobId,
    customerId: job.customerId,
  });
  revalidateJob(jobId);
}

// ── Closeout: invoice ────────────────────────────────────────────────────────

async function nextInvoiceNumber(tx: TenantDb): Promise<string> {
  const rows = await tx
    .select({ number: t.invoices.number })
    .from(t.invoices)
    .where(like(t.invoices.number, "INV-%"));
  const max = rows
    .map((r) => parseInt(r.number.slice(4), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 3000);
  return `INV-${max + 1}`;
}

export async function generateInvoice(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "invoices.create")) throw new Error("Not allowed");
  const jobId = str(formData, "jobId");

  const created = await withTenant(session.organizationId, async (tx) => {
    const job = await getJobOrThrow(tx, jobId);

    const existing = await tx.query.invoices.findFirst({ where: eq(t.invoices.jobId, jobId) });
    if (existing) return null; // idempotent

    const number = await nextInvoiceNumber(tx);
    const dueAt = new Date();
    dueAt.setDate(dueAt.getDate() + 30);

    const [invoice] = await tx
      .insert(t.invoices)
      .values({
        number,
        status: "SENT",
        customerId: job.customerId,
        jobId,
        issuedAt: new Date(),
        dueAt,
      })
      .returning();

    // Lines from materials used (price book prices)
    const materials = await tx.query.materialUsages.findMany({
      where: eq(t.materialUsages.jobId, jobId),
      with: { priceBookItem: true },
    });
    const lines: (typeof t.invoiceLineItems.$inferInsert)[] = materials.map((m) => ({
      invoiceId: invoice.id,
      priceBookItemId: m.priceBookItemId,
      description: m.priceBookItem.name,
      qty: m.qty,
      unitPriceCents: m.priceBookItem.unitPriceCents,
    }));

    // Labor line: flat-rate from price book if the job type matches, else standard labor
    const items = await tx
      .select()
      .from(t.priceBookItems)
      .where(eq(t.priceBookItems.active, true))
      .orderBy(asc(t.priceBookItems.unitPriceCents));
    const jt = job.jobType.toLowerCase();
    const singular = (s: string) => s.toLowerCase().replace(/s$/, "");
    const flatRate =
      items.find((i) => i.laborHours != null && i.name.toLowerCase().includes(jt)) ??
      items.find((i) => i.laborHours != null && jt.includes(singular(i.category)));
    if (flatRate && !materials.some((m) => m.priceBookItemId === flatRate.id)) {
      lines.push({
        invoiceId: invoice.id,
        priceBookItemId: flatRate.id,
        description: `${flatRate.name} (flat rate)`,
        qty: 1,
        unitPriceCents: flatRate.unitPriceCents,
      });
    } else if (!flatRate) {
      lines.push({
        invoiceId: invoice.id,
        description: "Service labor",
        qty: 1,
        unitPriceCents: 18900,
      });
    }
    if (lines.length) await tx.insert(t.invoiceLineItems).values(lines);

    return { job, invoice, number };
  });
  if (!created) return;

  await logActivity({
    kind: "SYSTEM",
    body: `Invoice ${created.number} generated for ${created.job.number}`,
    userId: session.userId,
    jobId,
    customerId: created.job.customerId,
  });
  await audit(session.userId, "INVOICE_CREATE", "Invoice", created.invoice.id, { jobId, number: created.number });
  revalidateJob(jobId);
}

export async function addInvoiceLine(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "invoices.create")) throw new Error("Not allowed");
  const invoiceId = str(formData, "invoiceId");
  const priceBookItemId = str(formData, "priceBookItemId");
  const qty = Math.max(0.1, Number(str(formData, "qty") || "1"));

  const invoice = await withTenant(session.organizationId, async (tx) => {
    const invoice = await tx.query.invoices.findFirst({ where: eq(t.invoices.id, invoiceId) });
    if (!invoice) throw new Error("Invoice not found");
    const item = await tx.query.priceBookItems.findFirst({ where: eq(t.priceBookItems.id, priceBookItemId) });
    if (!item) throw new Error("Price book item not found");

    await tx.insert(t.invoiceLineItems).values({
      invoiceId,
      priceBookItemId,
      description: item.name,
      qty,
      unitPriceCents: item.unitPriceCents,
    });
    return invoice;
  });
  if (invoice.jobId) revalidateJob(invoice.jobId);
}

// ── Closeout: sign & pay ─────────────────────────────────────────────────────

export async function signInvoice(formData: FormData) {
  const session = await requireSession();
  const invoiceId = str(formData, "invoiceId");
  const signedName = str(formData, "signedName");
  if (!signedName) throw new Error("Signature name required");

  const invoice = await withTenant(session.organizationId, async (tx) => {
    const invoice = await tx.query.invoices.findFirst({ where: eq(t.invoices.id, invoiceId) });
    if (!invoice) throw new Error("Invoice not found");

    await tx
      .update(t.invoices)
      .set({ signedName, signedAt: new Date() })
      .where(eq(t.invoices.id, invoiceId));
    return invoice;
  });

  if (invoice.jobId) {
    await logActivity({
      kind: "NOTE",
      body: `Invoice ${invoice.number} signed on-site by ${signedName}`,
      userId: session.userId,
      jobId: invoice.jobId,
      customerId: invoice.customerId,
    });
    revalidateJob(invoice.jobId);
  }
}

export async function recordPayment(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "payments.take")) throw new Error("Not allowed");
  const invoiceId = str(formData, "invoiceId");
  const method = str(formData, "method") as typeof t.payments.$inferSelect.method;
  const amountCents = Math.round(Number(str(formData, "amount") || "0") * 100);
  if (amountCents <= 0) throw new Error("Amount must be positive");

  const { invoice, status } = await withTenant(session.organizationId, async (tx) => {
    const invoice = await tx.query.invoices.findFirst({
      where: eq(t.invoices.id, invoiceId),
      with: { items: true, payments: true },
    });
    if (!invoice) throw new Error("Invoice not found");

    await tx.insert(t.payments).values({
      invoiceId,
      amountCents,
      method,
      reference: `field_${method.toLowerCase()}_${invoice.number.replace("INV-", "")}`,
    });

    const total = invoice.items.reduce((s, i) => s + Math.round(i.qty * i.unitPriceCents), 0);
    const paid = invoice.payments.reduce((s, p) => s + p.amountCents, 0) + amountCents;
    const status = paid >= total ? "PAID" : "PARTIAL";
    await tx.update(t.invoices).set({ status }).where(eq(t.invoices.id, invoiceId));

    return { invoice, status };
  });

  await logActivity({
    kind: "PAYMENT",
    body: `Payment $${(amountCents / 100).toFixed(2)} (${method.toLowerCase()}) on ${invoice.number}${status === "PARTIAL" ? " — partial" : ""}`,
    userId: session.userId,
    jobId: invoice.jobId ?? undefined,
    customerId: invoice.customerId,
  });
  await audit(session.userId, "PAYMENT_TAKE", "Invoice", invoiceId, { amountCents, method, status });
  if (invoice.jobId) revalidateJob(invoice.jobId);
}

// ── Closeout: finish ─────────────────────────────────────────────────────────

export async function finishCloseout(formData: FormData) {
  const session = await requireSession();
  const jobId = str(formData, "jobId");

  const result = await withTenant(session.organizationId, async (tx) => {
    const job = await getJobOrThrow(tx, jobId);
    if (job.status === "COMPLETED") return { alreadyDone: true as const };

    // Server-side validation: photos + required forms + invoice paid-or-sent
    const photos = await tx.select().from(t.jobPhotos).where(eq(t.jobPhotos.jobId, jobId));
    if (!photos.some((p) => p.kind === "BEFORE") || !photos.some((p) => p.kind === "AFTER"))
      throw new Error("Closeout blocked: need at least one BEFORE and one AFTER photo");

    const forms = await tx.select().from(t.jobForms).where(eq(t.jobForms.jobId, jobId));
    if (forms.some((f) => f.required && !f.completedAt))
      throw new Error("Closeout blocked: required forms incomplete");

    const invoice = await tx.query.invoices.findFirst({ where: eq(t.invoices.jobId, jobId) });
    if (!invoice || !["SENT", "PARTIAL", "PAID"].includes(invoice.status))
      throw new Error("Closeout blocked: invoice must be generated (sent or paid)");

    const now = new Date();
    await tx.update(t.jobs).set({ status: "COMPLETED", completedAt: now }).where(eq(t.jobs.id, jobId));

    // Stop all open clocks on this job
    await tx
      .update(t.timeEntries)
      .set({ endedAt: now })
      .where(and(eq(t.timeEntries.jobId, jobId), isNull(t.timeEntries.endedAt)));

    const office = await usersByRole(tx, "OFFICE");
    return { alreadyDone: false as const, job, invoice, office };
  });

  if (result.alreadyDone) redirect("/my-day");
  const { job, invoice, office } = result;

  await logActivity({
    kind: "STATUS",
    body: `Job ${job.number} completed by ${session.name} (two-minute closeout)`,
    userId: session.userId,
    jobId,
    customerId: job.customerId,
  });
  await logActivity({
    kind: "REVIEW",
    body: `Review request sent to ${job.customer.name}`,
    userId: session.userId,
    jobId,
    customerId: job.customerId,
  });

  for (const u of office) {
    await notify(
      u.id,
      `✅ ${job.number} completed — ${job.jobType}`,
      `${session.name} closed out at ${job.customer.name}. Invoice ${invoice.number} is ${invoice.status}.`,
      `/jobs/${jobId}`
    );
  }
  await audit(session.userId, "JOB_COMPLETE", "Job", jobId, { invoice: invoice.number });

  revalidateJob(jobId);
  redirect("/my-day");
}
