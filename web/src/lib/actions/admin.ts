"use server";

import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can, ALL_PERMISSIONS, type Permission } from "@/lib/permissions";
import type { Role } from "@/lib/auth";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { audit, notify } from "./helpers";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const ROLES = ["TECH", "SALES_PM", "OFFICE", "ADMIN"] as const;

async function ensureAdmin() {
  const session = await requireSession();
  if (!can(session.role, "users.manage")) throw new Error("Not allowed");
  return session;
}

/** Change a user's base role. */
export async function setUserRole(formData: FormData) {
  const session = await ensureAdmin();
  const userId = str(formData, "userId");
  const role = str(formData, "role");
  if (!userId || !(ROLES as readonly string[]).includes(role)) return;
  const before = await withTenant(session.organizationId, async (tx) => {
    const [b] = await tx.select({ role: t.users.role }).from(t.users).where(eq(t.users.id, userId));
    await tx.update(t.users).set({ role: role as Role }).where(eq(t.users.id, userId));
    return b;
  });
  await audit(session.userId, "UPDATE_ROLE", "User", userId, { from: before?.role, to: role });
  await notify(userId, "Your role was updated", `You are now a ${role.replace("_", "/")}.`, "/");
  revalidatePath("/settings");
}

/**
 * Set a single permission override for a user.
 * mode: "grant" (add on top of role), "revoke" (remove from role), "clear" (back to role default).
 */
export async function setPermissionOverride(formData: FormData) {
  const session = await ensureAdmin();
  const userId = str(formData, "userId");
  const permission = str(formData, "permission") as Permission;
  const mode = str(formData, "mode"); // grant | revoke | clear
  if (!userId || !ALL_PERMISSIONS.includes(permission)) return;

  await withTenant(session.organizationId, async (tx) => {
    await tx
      .delete(t.userPermissionOverrides)
      .where(
        and(eq(t.userPermissionOverrides.userId, userId), eq(t.userPermissionOverrides.permission, permission))
      );

    if (mode === "grant" || mode === "revoke") {
      await tx.insert(t.userPermissionOverrides).values({ userId, permission, granted: mode === "grant" });
    }
  });
  await audit(session.userId, "PERMISSION_OVERRIDE", "User", userId, { permission, mode });
  revalidatePath("/settings");
}

/** Reset all of a user's overrides back to the role default. */
export async function clearAllOverrides(formData: FormData) {
  const session = await ensureAdmin();
  const userId = str(formData, "userId");
  if (!userId) return;
  await withTenant(session.organizationId, (tx) =>
    tx.delete(t.userPermissionOverrides).where(eq(t.userPermissionOverrides.userId, userId))
  );
  await audit(session.userId, "PERMISSION_OVERRIDE_CLEAR_ALL", "User", userId);
  revalidatePath("/settings");
}

/** Save OrgMemory gateway config and mark it connected. */
export async function configureOrgMemory(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "integrations.manage")) throw new Error("Not allowed");
  const gatewayUrl = str(formData, "gatewayUrl");
  const submittedToken = str(formData, "token");
  const namespace = str(formData, "namespace") || "plumber_app";

  // Keep the existing (encrypted) token when the field is left blank on re-save.
  const [existingRow] = await withTenant(session.organizationId, (tx) =>
    tx.select().from(t.integrationConnections).where(eq(t.integrationConnections.provider, "ORGMEMORY"))
  );
  const existingToken = (existingRow?.config as { token?: string } | undefined)?.token ?? "";
  const plainToken = submittedToken || (existingToken ? decryptSecret(existingToken) : "");
  const connected = Boolean(gatewayUrl && plainToken);
  const values = {
    status: (connected ? "CONNECTED" : "DISCONNECTED") as "CONNECTED" | "DISCONNECTED",
    // The MCP access token is a secret — store it encrypted at rest.
    config: { gatewayUrl, token: plainToken ? encryptSecret(plainToken) : "", namespace },
    lastSyncAt: connected ? new Date() : null,
  };
  await withTenant(session.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(t.integrationConnections)
      .where(eq(t.integrationConnections.provider, "ORGMEMORY"));
    if (existing) {
      await tx.update(t.integrationConnections).set(values).where(eq(t.integrationConnections.id, existing.id));
    } else {
      await tx.insert(t.integrationConnections).values({ provider: "ORGMEMORY", ...values });
    }
  });
  await audit(session.userId, connected ? "CONNECT" : "UPDATE", "Integration", "ORGMEMORY", { gatewayUrl, namespace });
  revalidatePath("/settings");
  revalidatePath("/kb");
}

export async function disconnectOrgMemory() {
  const session = await requireSession();
  if (!can(session.role, "integrations.manage")) throw new Error("Not allowed");
  await withTenant(session.organizationId, (tx) =>
    tx
      .update(t.integrationConnections)
      .set({ status: "DISCONNECTED" })
      .where(eq(t.integrationConnections.provider, "ORGMEMORY"))
  );
  await audit(session.userId, "DISCONNECT", "Integration", "ORGMEMORY");
  revalidatePath("/settings");
  revalidatePath("/kb");
}

const OPEN_JOB = ["UNSCHEDULED", "SCHEDULED", "DISPATCHED", "EN_ROUTE", "IN_PROGRESS"] as const;
const OPEN_LEAD = ["NEW", "CONTACTED", "ESTIMATE_SCHEDULED", "ESTIMATE_SENT", "FOLLOW_UP"] as const;
const OPEN_ESTIMATE = ["DRAFT", "SENT", "VIEWED"] as const;

/** Count the open work currently owned by a user (for the confirm dialog). */
export async function countOpenWork(userId: string) {
  const session = await requireSession();
  const [jobs, leads, estimates] = await withTenant(session.organizationId, (tx) =>
    Promise.all([
      tx.select({ id: t.jobs.id }).from(t.jobs).where(and(eq(t.jobs.assignedToId, userId), inArray(t.jobs.status, [...OPEN_JOB]))),
      tx.select({ id: t.leads.id }).from(t.leads).where(and(eq(t.leads.assignedToId, userId), inArray(t.leads.stage, [...OPEN_LEAD]))),
      tx.select({ id: t.estimates.id }).from(t.estimates).where(and(eq(t.estimates.createdById, userId), inArray(t.estimates.status, [...OPEN_ESTIMATE]))),
    ])
  );
  return { jobs: jobs.length, leads: leads.length, estimates: estimates.length };
}

/**
 * Reassign a user's open work to another user, then (optionally) deactivate them.
 * Reassigns: open jobs (assignedTo), open leads (assignedTo), open estimates (createdBy).
 */
export async function reassignAndDeactivate(formData: FormData) {
  const session = await ensureAdmin();
  const fromId = str(formData, "fromUserId");
  const toId = str(formData, "toUserId");
  const deactivate = str(formData, "deactivate") === "true";
  if (!fromId || !toId || fromId === toId) return;

  const summary = await withTenant(session.organizationId, async (tx) => {
    const jobsRes = await tx
      .update(t.jobs)
      .set({ assignedToId: toId })
      .where(and(eq(t.jobs.assignedToId, fromId), inArray(t.jobs.status, [...OPEN_JOB])))
      .returning({ id: t.jobs.id });

    const leadsRes = await tx
      .update(t.leads)
      .set({ assignedToId: toId })
      .where(and(eq(t.leads.assignedToId, fromId), inArray(t.leads.stage, [...OPEN_LEAD])))
      .returning({ id: t.leads.id });

    const estRes = await tx
      .update(t.estimates)
      .set({ createdById: toId })
      .where(and(eq(t.estimates.createdById, fromId), inArray(t.estimates.status, [...OPEN_ESTIMATE])))
      .returning({ id: t.estimates.id });

    if (deactivate && fromId !== session.userId) {
      await tx.update(t.users).set({ active: false }).where(eq(t.users.id, fromId));
    }

    return { jobs: jobsRes.length, leads: leadsRes.length, estimates: estRes.length, deactivated: deactivate };
  });

  await audit(session.userId, "REASSIGN_WORK", "User", fromId, { toId, ...summary });
  await notify(
    toId,
    "Work reassigned to you",
    `${summary.jobs} jobs, ${summary.leads} leads, ${summary.estimates} estimates.`,
    "/dispatch"
  );
  revalidatePath("/settings");
  revalidatePath("/dispatch");
}
