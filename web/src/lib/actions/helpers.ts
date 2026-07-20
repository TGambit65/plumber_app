import "server-only";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";

/**
 * These helpers write to org-scoped tables (audit_logs, activities,
 * notifications), so each resolves the caller's org from the session and runs
 * inside withTenant — the organization_id column default fills from the GUC
 * and RLS (once enabled) admits the row. They open their own short
 * transactions, which is fine alongside a caller's withTenant block.
 */

/** Write an audit-log row for a sensitive action. */
export async function audit(
  userId: string,
  action: string,
  entity: string,
  entityId?: string,
  detail?: Record<string, unknown>
) {
  const session = await requireSession();
  await withTenant(session.organizationId, (tx) =>
    tx.insert(t.auditLogs).values({ userId, action, entity, entityId, detail })
  );
}

/** Append to the customer/job/lead/project timeline. */
export async function logActivity(input: {
  kind: "CALL" | "SMS" | "EMAIL" | "NOTE" | "STATUS" | "SYSTEM" | "ESTIMATE_VIEW" | "PAYMENT" | "REVIEW";
  body: string;
  userId?: string;
  customerId?: string;
  jobId?: string;
  leadId?: string;
  projectId?: string;
}) {
  const session = await requireSession();
  await withTenant(session.organizationId, (tx) => tx.insert(t.activities).values(input));
}

/** Notify a user in-app. */
export async function notify(userId: string, title: string, body?: string, href?: string) {
  const session = await requireSession();
  await withTenant(session.organizationId, (tx) =>
    tx.insert(t.notifications).values({ userId, title, body, href })
  );
}

// ── C1: org-scoped variants for PUBLIC (sessionless) surfaces ────────────────
// The public proposal/pay pages resolve the org from an unguessable token, not
// a session — these take organizationId explicitly instead of requireSession.

export async function auditOrg(
  organizationId: string,
  userId: string | null,
  action: string,
  entity: string,
  entityId?: string,
  detail?: Record<string, unknown>
) {
  await withTenant(organizationId, (tx) =>
    tx.insert(t.auditLogs).values({ userId, action, entity, entityId, detail })
  );
}

export async function logActivityOrg(
  organizationId: string,
  input: {
    kind: "CALL" | "SMS" | "EMAIL" | "NOTE" | "STATUS" | "SYSTEM" | "ESTIMATE_VIEW" | "PAYMENT" | "REVIEW";
    body: string;
    userId?: string;
    customerId?: string;
    jobId?: string;
    leadId?: string;
    projectId?: string;
  }
) {
  await withTenant(organizationId, (tx) => tx.insert(t.activities).values(input));
}

export async function notifyOrg(organizationId: string, userId: string, title: string, body?: string, href?: string) {
  await withTenant(organizationId, (tx) =>
    tx.insert(t.notifications).values({ userId, title, body, href })
  );
}
