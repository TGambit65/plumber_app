"use server";

/* M1 customer management actions — edit/archive customer, edit/archive
 * property (re-geocoding on address change), edit/remove equipment, and
 * membership management. Archive-over-delete throughout (plan §2). */

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, logActivity } from "@/lib/actions/helpers";
import { geocodeProperty } from "@/lib/geo/service";
import { customerArchiveBlocker, propertyArchiveBlocker, OPEN_JOB_STATUSES } from "@/lib/manage/lifecycle";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

async function guardEdit() {
  const session = await requireSession();
  if (!can(session.role, "customers.edit")) throw new Error("Not allowed");
  return session;
}

function revalidateCustomers(customerId?: string) {
  revalidatePath("/customers");
  revalidatePath("/dispatch");
  if (customerId) revalidatePath(`/customers/${customerId}`);
}

// ── Customer ─────────────────────────────────────────────────────────────────

/** Edit the customer record — name, company, contact, type, notes, SMS opt-out. */
export async function updateCustomer(formData: FormData) {
  const session = await guardEdit();
  const customerId = str(formData, "customerId");
  const name = str(formData, "name");
  if (!customerId || !name) return;
  const type = str(formData, "type") === "COMMERCIAL" ? ("COMMERCIAL" as const) : ("RESIDENTIAL" as const);
  const smsOptOut = str(formData, "smsOptOut") === "on";

  const found = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.customers.findFirst({ where: eq(t.customers.id, customerId) });
    if (!existing) return null;
    await tx
      .update(t.customers)
      .set({
        name,
        type,
        company: str(formData, "company") || null,
        email: str(formData, "email") || null,
        phone: str(formData, "phone") || null,
        notes: str(formData, "notes") || null,
        smsOptOut,
      })
      .where(eq(t.customers.id, customerId));
    return existing;
  });
  if (!found) return;

  await audit(session.userId, "UPDATE", "Customer", customerId, {
    name,
    type,
    smsOptOut,
    smsOptOutChanged: found.smsOptOut !== smsOptOut,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Customer record updated by ${session.name}${found.smsOptOut !== smsOptOut ? ` — SMS opt-out ${smsOptOut ? "SET" : "cleared"}` : ""}`,
    userId: session.userId,
    customerId,
  });
  revalidateCustomers(customerId);
}

/** Archive a customer — blocked while open jobs or unpaid invoices exist. */
export async function archiveCustomer(formData: FormData) {
  const session = await guardEdit();
  const customerId = str(formData, "customerId");
  if (!customerId) return;

  const customer = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.customers.findFirst({ where: eq(t.customers.id, customerId) });
    if (!existing) return null;
    const openJobs = await tx.query.jobs.findMany({
      where: and(
        eq(t.jobs.customerId, customerId),
        inArray(t.jobs.status, OPEN_JOB_STATUSES),
        isNull(t.jobs.deletedAt)
      ),
      columns: { id: true },
    });
    const openInvoices = await tx.query.invoices.findMany({
      where: and(eq(t.invoices.customerId, customerId), inArray(t.invoices.status, ["SENT", "PARTIAL", "OVERDUE"])),
      columns: { id: true },
    });
    const blocker = customerArchiveBlocker({ openJobs: openJobs.length, openInvoices: openInvoices.length });
    if (blocker) throw new Error(blocker);
    await tx.update(t.customers).set({ archivedAt: new Date() }).where(eq(t.customers.id, customerId));
    return existing;
  });
  if (!customer) return;

  await audit(session.userId, "CUSTOMER_ARCHIVED", "Customer", customerId, { name: customer.name });
  revalidateCustomers(customerId);
}

export async function unarchiveCustomer(formData: FormData) {
  const session = await guardEdit();
  const customerId = str(formData, "customerId");
  if (!customerId) return;
  const customer = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.customers.findFirst({ where: eq(t.customers.id, customerId) });
    if (!existing?.archivedAt) return null;
    await tx.update(t.customers).set({ archivedAt: null }).where(eq(t.customers.id, customerId));
    return existing;
  });
  if (!customer) return;
  await audit(session.userId, "CUSTOMER_UNARCHIVED", "Customer", customerId, { name: customer.name });
  revalidateCustomers(customerId);
}

// ── Properties ───────────────────────────────────────────────────────────────

/** Edit a property's label/address — re-geocodes when the address changed. */
export async function updateProperty(formData: FormData) {
  const session = await guardEdit();
  const propertyId = str(formData, "propertyId");
  const customerId = str(formData, "customerId");
  const address = str(formData, "address");
  const city = str(formData, "city");
  const state = str(formData, "state");
  const zip = str(formData, "zip");
  if (!propertyId || !address || !city || !state || !zip) return;

  const addressChanged = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.properties.findFirst({ where: eq(t.properties.id, propertyId) });
    if (!existing) return null;
    const changed =
      existing.address !== address || existing.city !== city || existing.state !== state || existing.zip !== zip;
    await tx
      .update(t.properties)
      .set({
        label: str(formData, "label") || null,
        address,
        city,
        state,
        zip,
        // Stale coordinates are worse than none — clear until re-geocoded.
        ...(changed ? { lat: null, lng: null, geocodedAt: null } : {}),
      })
      .where(eq(t.properties.id, propertyId));
    return changed;
  });
  if (addressChanged === null) return;

  if (addressChanged) await geocodeProperty(session.organizationId, propertyId);
  await audit(session.userId, "UPDATE", "Property", propertyId, { address, city, addressChanged });
  await logActivity({
    kind: "SYSTEM",
    body: `Property updated: ${address}, ${city}${addressChanged ? " (re-geocoded)" : ""}`,
    userId: session.userId,
    customerId: customerId || undefined,
  });
  revalidateCustomers(customerId);
}

/** Archive a property — blocked while open jobs reference it. */
export async function archiveProperty(formData: FormData) {
  const session = await guardEdit();
  const propertyId = str(formData, "propertyId");
  const customerId = str(formData, "customerId");
  if (!propertyId) return;

  await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.properties.findFirst({ where: eq(t.properties.id, propertyId) });
    if (!existing) return;
    const openJobs = await tx.query.jobs.findMany({
      where: and(
        eq(t.jobs.propertyId, propertyId),
        inArray(t.jobs.status, OPEN_JOB_STATUSES),
        isNull(t.jobs.deletedAt)
      ),
      columns: { id: true },
    });
    const blocker = propertyArchiveBlocker({ openJobs: openJobs.length });
    if (blocker) throw new Error(blocker);
    await tx.update(t.properties).set({ archivedAt: new Date() }).where(eq(t.properties.id, propertyId));
  });

  await audit(session.userId, "PROPERTY_ARCHIVED", "Property", propertyId, {});
  revalidateCustomers(customerId);
}

export async function unarchiveProperty(formData: FormData) {
  const session = await guardEdit();
  const propertyId = str(formData, "propertyId");
  const customerId = str(formData, "customerId");
  if (!propertyId) return;
  await withTenant(session.organizationId, (tx) =>
    tx.update(t.properties).set({ archivedAt: null }).where(eq(t.properties.id, propertyId))
  );
  await audit(session.userId, "PROPERTY_UNARCHIVED", "Property", propertyId, {});
  revalidateCustomers(customerId);
}

// ── Equipment ────────────────────────────────────────────────────────────────

/** Edit equipment basics (brand/model/serial/installed/notes; kind is fixed). */
export async function updateEquipment(formData: FormData) {
  const session = await guardEdit();
  const equipmentId = str(formData, "equipmentId");
  const customerId = str(formData, "customerId");
  if (!equipmentId) return;
  const installedAt = str(formData, "installedAt");

  await withTenant(session.organizationId, (tx) =>
    tx
      .update(t.equipment)
      .set({
        brand: str(formData, "brand") || null,
        model: str(formData, "model") || null,
        serial: str(formData, "serial") || null,
        installedAt: installedAt ? new Date(installedAt) : null,
        notes: str(formData, "notes") || null,
      })
      .where(eq(t.equipment.id, equipmentId))
  );
  await audit(session.userId, "UPDATE", "Equipment", equipmentId, {});
  revalidateCustomers(customerId);
}

/** Remove (archive) equipment — history stays intact. */
export async function removeEquipment(formData: FormData) {
  const session = await guardEdit();
  const equipmentId = str(formData, "equipmentId");
  const customerId = str(formData, "customerId");
  if (!equipmentId) return;
  await withTenant(session.organizationId, (tx) =>
    tx.update(t.equipment).set({ archivedAt: new Date() }).where(eq(t.equipment.id, equipmentId))
  );
  await audit(session.userId, "EQUIPMENT_REMOVED", "Equipment", equipmentId, {});
  await logActivity({
    kind: "SYSTEM",
    body: `Equipment removed from property record by ${session.name}`,
    userId: session.userId,
    customerId: customerId || undefined,
  });
  revalidateCustomers(customerId);
}

// ── Membership ───────────────────────────────────────────────────────────────

const MEMBERSHIP_STATUSES = ["ACTIVE", "PAUSED", "CANCELLED"] as const;

/** Create or update the customer's membership (one per customer). */
export async function saveMembership(formData: FormData) {
  const session = await guardEdit();
  const customerId = str(formData, "customerId");
  const plan = str(formData, "plan");
  if (!customerId || !plan) return;
  const status = (MEMBERSHIP_STATUSES as readonly string[]).includes(str(formData, "status"))
    ? str(formData, "status")
    : "ACTIVE";
  const renewsAtRaw = str(formData, "renewsAt");
  const renewsAt = renewsAtRaw ? new Date(renewsAtRaw) : null;

  const created = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.memberships.findFirst({ where: eq(t.memberships.customerId, customerId) });
    if (existing) {
      await tx.update(t.memberships).set({ plan, status, renewsAt }).where(eq(t.memberships.id, existing.id));
      return false;
    }
    await tx.insert(t.memberships).values({ customerId, plan, status, renewsAt });
    return true;
  });

  await audit(session.userId, created ? "MEMBERSHIP_CREATED" : "MEMBERSHIP_UPDATED", "Membership", customerId, {
    plan,
    status,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Membership ${created ? "created" : "updated"}: ${plan} (${status.toLowerCase()})`,
    userId: session.userId,
    customerId,
  });
  revalidateCustomers(customerId);
}

/** Cancel the membership (kept on record as CANCELLED, not deleted). */
export async function cancelMembership(formData: FormData) {
  const session = await guardEdit();
  const customerId = str(formData, "customerId");
  if (!customerId) return;
  const existing = await withTenant(session.organizationId, async (tx) => {
    const row = await tx.query.memberships.findFirst({ where: eq(t.memberships.customerId, customerId) });
    if (!row) return null;
    await tx.update(t.memberships).set({ status: "CANCELLED" }).where(eq(t.memberships.id, row.id));
    return row;
  });
  if (!existing) return;
  await audit(session.userId, "MEMBERSHIP_CANCELLED", "Membership", existing.id, { plan: existing.plan });
  await logActivity({
    kind: "SYSTEM",
    body: `Membership cancelled (${existing.plan})`,
    userId: session.userId,
    customerId,
  });
  revalidateCustomers(customerId);
}
