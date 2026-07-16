import "server-only";
import { db, t } from "@/db";

/** Write an audit-log row for a sensitive action. */
export async function audit(
  userId: string,
  action: string,
  entity: string,
  entityId?: string,
  detail?: Record<string, unknown>
) {
  await db.insert(t.auditLogs).values({ userId, action, entity, entityId, detail });
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
  await db.insert(t.activities).values(input);
}

/** Notify a user in-app. */
export async function notify(userId: string, title: string, body?: string, href?: string) {
  await db.insert(t.notifications).values({ userId, title, body, href });
}
