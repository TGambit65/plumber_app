"use server";

import { db, t } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, logActivity, notify } from "@/lib/actions/helpers";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { lineTotal, money, fmtDateTime } from "@/lib/format";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

const JOB_PRIORITIES = ["LOW", "NORMAL", "HIGH", "EMERGENCY"] as const;
const PAYMENT_METHODS = ["CARD", "ACH", "CASH", "CHECK", "FINANCING"] as const;
const ROLES = ["TECH", "SALES_PM", "OFFICE", "ADMIN"] as const;
const COMMISSION_KINDS = ["PERCENT_REVENUE", "PERCENT_MARGIN", "SPIFF"] as const;

function pick<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

async function nextJobNumber(): Promise<string> {
  const rows = await db.select({ number: t.jobs.number }).from(t.jobs);
  const max = rows.reduce((m, r) => {
    const n = parseInt(r.number.replace(/^J-/, ""), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 1000);
  return `J-${max + 1}`;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export async function assignJob(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "dispatch.manage")) throw new Error("Not allowed");
  const jobId = str(formData, "jobId");
  const techId = str(formData, "techId");
  const when = str(formData, "scheduledAt");
  if (!jobId || !techId || !when) return;

  const job = await db.query.jobs.findFirst({
    where: eq(t.jobs.id, jobId),
    with: { customer: true, property: true },
  });
  if (!job) return;

  const scheduledAt = new Date(when);
  await db
    .update(t.jobs)
    .set({ assignedToId: techId, scheduledAt, status: "SCHEDULED" })
    .where(eq(t.jobs.id, jobId));

  await logActivity({
    kind: "STATUS",
    body: `Job ${job.number} scheduled for ${fmtDateTime(scheduledAt)} and assigned`,
    userId: session.userId,
    jobId,
    customerId: job.customerId,
  });
  await notify(
    techId,
    `New job assigned: ${job.number} — ${job.jobType}`,
    `${job.customer.name} · ${job.property.address} · ${fmtDateTime(scheduledAt)}`,
    "/my-day"
  );
  revalidatePath("/dispatch");
  revalidatePath("/jobs");
}

export async function bookJob(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "dispatch.manage")) throw new Error("Not allowed");
  const customerId = str(formData, "customerId");
  const propertyId = str(formData, "propertyId");
  const jobType = str(formData, "jobType");
  const priority = pick(str(formData, "priority"), JOB_PRIORITIES, "NORMAL");
  const description = str(formData, "description");
  const scheduledStr = str(formData, "scheduledAt");
  const techId = str(formData, "techId");
  if (!customerId || !propertyId || !jobType) return;

  // Hard cross-field validation: property must belong to the selected customer.
  const property = await db.query.properties.findFirst({
    where: eq(t.properties.id, propertyId),
    with: { customer: true },
  });
  if (!property || property.customerId !== customerId) {
    throw new Error("Selected property does not belong to the selected customer");
  }

  const scheduledAt = scheduledStr ? new Date(scheduledStr) : null;
  const number = await nextJobNumber();
  const [job] = await db
    .insert(t.jobs)
    .values({
      number,
      jobType,
      priority,
      description: description || null,
      customerId,
      propertyId,
      assignedToId: techId || null,
      scheduledAt,
      status: scheduledAt ? "SCHEDULED" : "UNSCHEDULED",
    })
    .returning();

  await logActivity({
    kind: "SYSTEM",
    body: `Job ${number} (${jobType}) booked by ${session.name}${scheduledAt ? ` for ${fmtDateTime(scheduledAt)}` : " — unscheduled"}`,
    userId: session.userId,
    jobId: job.id,
    customerId,
  });
  if (techId) {
    await notify(
      techId,
      `New job booked for you: ${number} — ${jobType}`,
      `${property.customer.name} · ${property.address}${scheduledAt ? ` · ${fmtDateTime(scheduledAt)}` : ""}`,
      "/my-day"
    );
  }
  revalidatePath("/dispatch");
  revalidatePath("/jobs");
}

// ── Customers ────────────────────────────────────────────────────────────────

export async function createCustomer(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "customers.edit")) throw new Error("Not allowed");
  const name = str(formData, "name");
  if (!name) return;
  const type = pick(str(formData, "type"), ["RESIDENTIAL", "COMMERCIAL"] as const, "RESIDENTIAL");
  const [customer] = await db
    .insert(t.customers)
    .values({
      name,
      type,
      company: str(formData, "company") || null,
      email: str(formData, "email") || null,
      phone: str(formData, "phone") || null,
    })
    .returning();
  await logActivity({
    kind: "SYSTEM",
    body: `Customer record created by ${session.name}`,
    userId: session.userId,
    customerId: customer.id,
  });
  revalidatePath("/customers");
  redirect(`/customers/${customer.id}`);
}

export async function addProperty(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "customers.edit")) throw new Error("Not allowed");
  const customerId = str(formData, "customerId");
  const address = str(formData, "address");
  const city = str(formData, "city");
  const state = str(formData, "state");
  const zip = str(formData, "zip");
  if (!customerId || !address || !city || !state || !zip) return;
  await db.insert(t.properties).values({
    customerId,
    label: str(formData, "label") || null,
    address,
    city,
    state,
    zip,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Property added: ${address}, ${city}`,
    userId: session.userId,
    customerId,
  });
  revalidatePath(`/customers/${customerId}`);
}

export async function updatePropertyMemory(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "customers.edit")) throw new Error("Not allowed");
  const propertyId = str(formData, "propertyId");
  const customerId = str(formData, "customerId");
  if (!propertyId) return;
  await db
    .update(t.properties)
    .set({
      gateCode: str(formData, "gateCode") || null,
      shutoffLocation: str(formData, "shutoffLocation") || null,
      petNotes: str(formData, "petNotes") || null,
      parkingNotes: str(formData, "parkingNotes") || null,
      accessNotes: str(formData, "accessNotes") || null,
    })
    .where(eq(t.properties.id, propertyId));
  await logActivity({
    kind: "SYSTEM",
    body: `Property memory updated by ${session.name}`,
    userId: session.userId,
    customerId: customerId || undefined,
  });
  revalidatePath(`/customers/${customerId}`);
}

export async function logCustomerActivity(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "customers.view")) throw new Error("Not allowed");
  const customerId = str(formData, "customerId");
  const kind = pick(str(formData, "kind"), ["NOTE", "CALL"] as const, "NOTE");
  const body = str(formData, "body");
  if (!customerId || !body) return;
  await logActivity({ kind, body, userId: session.userId, customerId });
  revalidatePath(`/customers/${customerId}`);
}

// ── Invoices / AR ────────────────────────────────────────────────────────────

export async function recordPayment(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "payments.take")) throw new Error("Not allowed");
  const invoiceId = str(formData, "invoiceId");
  const amountCents = Math.round(parseFloat(str(formData, "amount")) * 100);
  const method = pick(str(formData, "method"), PAYMENT_METHODS, "CARD");
  if (!invoiceId || !Number.isFinite(amountCents) || amountCents <= 0) return;

  await db.insert(t.payments).values({ invoiceId, amountCents, method });

  const inv = await db.query.invoices.findFirst({
    where: eq(t.invoices.id, invoiceId),
    with: { items: true, payments: true },
  });
  if (inv) {
    const total = lineTotal(inv.items);
    const paid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
    await db
      .update(t.invoices)
      .set({ status: paid >= total ? "PAID" : "PARTIAL" })
      .where(eq(t.invoices.id, invoiceId));
    await logActivity({
      kind: "PAYMENT",
      body: `Payment ${money(amountCents)} (${method.toLowerCase()}) recorded on ${inv.number}`,
      userId: session.userId,
      customerId: inv.customerId,
      jobId: inv.jobId ?? undefined,
    });
  }
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
}

export async function markInvoiceSent(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "invoices.create")) throw new Error("Not allowed");
  const invoiceId = str(formData, "invoiceId");
  if (!invoiceId) return;
  const inv = await db.query.invoices.findFirst({ where: eq(t.invoices.id, invoiceId) });
  if (!inv || inv.status !== "DRAFT") return;
  const now = new Date();
  const dueAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await db.update(t.invoices).set({ status: "SENT", issuedAt: now, dueAt }).where(eq(t.invoices.id, invoiceId));
  await logActivity({
    kind: "SYSTEM",
    body: `Invoice ${inv.number} sent to customer (due ${fmtDateTime(dueAt)})`,
    userId: session.userId,
    customerId: inv.customerId,
  });
  revalidatePath("/invoices");
}

export async function voidInvoice(formData: FormData) {
  const session = await requireSession();
  if (session.role !== "ADMIN") throw new Error("Only admins can void invoices");
  const invoiceId = str(formData, "invoiceId");
  if (!invoiceId) return;
  const inv = await db.query.invoices.findFirst({ where: eq(t.invoices.id, invoiceId) });
  if (!inv || inv.status === "VOID") return;
  await db.update(t.invoices).set({ status: "VOID" }).where(eq(t.invoices.id, invoiceId));
  await audit(session.userId, "VOID", "Invoice", invoiceId, { number: inv.number, previousStatus: inv.status });
  revalidatePath("/invoices");
}

// ── Settings: team ───────────────────────────────────────────────────────────

export async function inviteUser(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "users.manage")) throw new Error("Not allowed");
  const name = str(formData, "name");
  const email = str(formData, "email").toLowerCase();
  const role = pick(str(formData, "role"), ROLES, "TECH");
  const phone = str(formData, "phone");
  const password = str(formData, "password");
  if (!name || !email || !password) return;
  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(t.users)
    .values({ name, email, role, phone: phone || null, passwordHash })
    .returning();
  await audit(session.userId, "CREATE", "User", user.id, { name, email, role });
  revalidatePath("/settings");
}

export async function toggleUserActive(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "users.manage")) throw new Error("Not allowed");
  const userId = str(formData, "userId");
  const next = str(formData, "next") === "true";
  if (!userId || userId === session.userId) return; // can't deactivate yourself
  await db.update(t.users).set({ active: next }).where(eq(t.users.id, userId));
  await audit(session.userId, "UPDATE", "User", userId, { active: next });
  revalidatePath("/settings");
}

// ── Settings: integrations ───────────────────────────────────────────────────

export async function connectIntegration(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "integrations.manage")) throw new Error("Not allowed");
  const id = str(formData, "id");
  if (!id) return;
  const conn = await db.query.integrationConnections.findFirst({ where: eq(t.integrationConnections.id, id) });
  if (!conn) return;
  await db
    .update(t.integrationConnections)
    .set({ status: "CONNECTED", lastSyncAt: new Date() })
    .where(eq(t.integrationConnections.id, id));
  await audit(session.userId, "CONNECT", "Integration", id, { provider: conn.provider });
  revalidatePath("/settings");
}

export async function disconnectIntegration(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "integrations.manage")) throw new Error("Not allowed");
  const id = str(formData, "id");
  if (!id) return;
  const conn = await db.query.integrationConnections.findFirst({ where: eq(t.integrationConnections.id, id) });
  if (!conn) return;
  await db
    .update(t.integrationConnections)
    .set({ status: "DISCONNECTED" })
    .where(eq(t.integrationConnections.id, id));
  await audit(session.userId, "DISCONNECT", "Integration", id, { provider: conn.provider });
  revalidatePath("/settings");
}

export async function syncIntegration(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "integrations.manage")) throw new Error("Not allowed");
  const id = str(formData, "id");
  if (!id) return;
  const conn = await db.query.integrationConnections.findFirst({ where: eq(t.integrationConnections.id, id) });
  if (!conn || conn.status !== "CONNECTED") return;
  await db
    .update(t.integrationConnections)
    .set({ lastSyncAt: new Date() })
    .where(eq(t.integrationConnections.id, id));
  await notify(session.userId, `✅ ${conn.provider} sync complete`, "Demo sync finished with no changes.", "/settings?tab=integrations");
  revalidatePath("/settings");
}

// ── Settings: commissions ────────────────────────────────────────────────────

export async function addCommissionRule(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "commissions.rules.manage")) throw new Error("Not allowed");
  const name = str(formData, "name");
  const kind = pick(str(formData, "kind"), COMMISSION_KINDS, "PERCENT_REVENUE");
  const rate = parseFloat(str(formData, "rate"));
  const roleStr = str(formData, "role");
  const category = str(formData, "category");
  if (!name || !Number.isFinite(rate)) return;
  // SPIFF rates are entered in dollars, stored as cents; percent kinds stored as-is.
  const storedRate = kind === "SPIFF" ? Math.round(rate * 100) : rate;
  const [rule] = await db
    .insert(t.commissionRules)
    .values({
      name,
      kind,
      rate: storedRate,
      role: (ROLES as readonly string[]).includes(roleStr) ? (roleStr as (typeof ROLES)[number]) : null,
      category: category || null,
    })
    .returning();
  await audit(session.userId, "CREATE", "CommissionRule", rule.id, { name, kind, rate: storedRate });
  revalidatePath("/settings");
}

export async function toggleCommissionRule(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "commissions.rules.manage")) throw new Error("Not allowed");
  const id = str(formData, "id");
  const next = str(formData, "next") === "true";
  if (!id) return;
  await db.update(t.commissionRules).set({ active: next }).where(eq(t.commissionRules.id, id));
  await audit(session.userId, "UPDATE", "CommissionRule", id, { active: next });
  revalidatePath("/settings");
}

export async function approveCommissionEntry(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "commissions.rules.manage")) throw new Error("Not allowed");
  const id = str(formData, "id");
  if (!id) return;
  await db.update(t.commissionEntries).set({ status: "APPROVED" }).where(eq(t.commissionEntries.id, id));
  await audit(session.userId, "APPROVE", "CommissionEntry", id);
  revalidatePath("/settings");
}

export async function payCommissionEntry(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "commissions.rules.manage")) throw new Error("Not allowed");
  const id = str(formData, "id");
  if (!id) return;
  await db.update(t.commissionEntries).set({ status: "PAID" }).where(eq(t.commissionEntries.id, id));
  await audit(session.userId, "MARK_PAID", "CommissionEntry", id);
  revalidatePath("/settings");
}
