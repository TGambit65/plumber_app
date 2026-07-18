import "server-only";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db, t, withTenant } from "@/db";
import { getConnector } from "@/lib/connectors/providers";
import { decryptConfig } from "@/lib/connectors/secret-config";
import type { ConnectorConfig } from "@/lib/connectors/types";
import { isAutoSendKind, normalizePhone, renderTemplate, type TemplateParams, type TransactionalKind } from "./templates";

/**
 * Transactional SMS pipeline (dispatch D1).
 *
 * EVERY attempt is recorded in outbound_messages with an honest delivery
 * status — sent, failed, or skipped (opt-out / no phone / not connected) —
 * so the office can always see what the customer actually received.
 * Only templated kinds may pass through here (policy enforced at the top);
 * free-text still goes through the approval queue.
 */

/** Company display name for message templates (organizations is not RLS-scoped). */
export async function orgName(organizationId: string): Promise<string> {
  const org = await db.query.organizations.findFirst({
    where: eq(t.organizations.id, organizationId),
    columns: { name: true },
  });
  return org?.name ?? "your service company";
}

export type SendOutcome = {
  status: "SENT" | "FAILED" | "SKIPPED_OPTOUT" | "SKIPPED_NO_PHONE" | "SKIPPED_NOT_CONNECTED";
  sid?: string;
  error?: string;
};

export async function sendTransactionalSms(input: {
  organizationId: string;
  requestedById: string;
  kind: TransactionalKind;
  customerId: string;
  jobId?: string;
  params: TemplateParams;
}): Promise<SendOutcome> {
  const { organizationId, requestedById, kind, customerId, jobId, params } = input;
  if (!isAutoSendKind(kind)) {
    // Belt-and-braces: never auto-send a non-templated kind.
    throw new Error(`Kind ${kind} is not auto-sendable — route it through the approval queue`);
  }

  const body = renderTemplate(kind, params);

  // Resolve customer + opt-out + phone inside the tenant.
  const { customer, connRow } = await withTenant(organizationId, async (tx) => {
    const customer = await tx.query.customers.findFirst({ where: eq(t.customers.id, customerId) });
    const [connRow] = await tx
      .select()
      .from(t.integrationConnections)
      .where(eq(t.integrationConnections.provider, "TWILIO"));
    return { customer, connRow };
  });
  if (!customer) return { status: "FAILED", error: "customer not found" };

  const to = normalizePhone(customer.phone);
  let outcome: SendOutcome;

  if (customer.smsOptOut) {
    outcome = { status: "SKIPPED_OPTOUT" };
  } else if (!to) {
    outcome = { status: "SKIPPED_NO_PHONE", error: `unroutable phone: ${customer.phone ?? "none"}` };
  } else if (!connRow || connRow.status !== "CONNECTED") {
    outcome = { status: "SKIPPED_NOT_CONNECTED", error: "Twilio is not connected" };
  } else {
    const connector = getConnector("TWILIO");
    if (!connector?.messaging) {
      outcome = { status: "SKIPPED_NOT_CONNECTED", error: "Twilio connector unavailable" };
    } else {
      const config = decryptConfig(connector.descriptor, (connRow.config ?? {}) as ConnectorConfig);
      const result = await connector.messaging(config).sendSms(to, body);
      outcome = result.ok
        ? { status: "SENT", sid: result.externalId }
        : { status: "FAILED", error: result.message ?? "send failed" };
    }
  }

  // Record the attempt — always, whatever happened (loud, auditable).
  await withTenant(organizationId, (tx) =>
    tx.insert(t.outboundMessages).values({
      kind,
      status: outcome.status === "SENT" ? "APPROVED_SENT" : "CANCELLED",
      customerId,
      recipient: to ?? customer.phone ?? null,
      body,
      jobId: jobId ?? null,
      requestedById,
      decidedAt: new Date(),
      externalSid: outcome.sid ?? null,
      deliveryStatus: outcome.status,
      deliveryError: outcome.error ?? null,
    })
  );

  if (outcome.status === "FAILED") {
    console.error(`[SMS ${kind} FAILED] customer=${customerId} ${outcome.error}`);
  }
  return outcome;
}

/** True if this job already has a recorded attempt of `kind` (dedupe guard). */
export async function hasRecentSend(
  organizationId: string,
  jobId: string,
  kind: TransactionalKind,
  withinHours = 20
): Promise<boolean> {
  const since = new Date(Date.now() - withinHours * 3600 * 1000);
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({ id: t.outboundMessages.id })
      .from(t.outboundMessages)
      .where(
        and(
          eq(t.outboundMessages.jobId, jobId),
          eq(t.outboundMessages.kind, kind),
          inArray(t.outboundMessages.deliveryStatus, ["SENT", "SKIPPED_OPTOUT", "SKIPPED_NO_PHONE"]),
          gte(t.outboundMessages.createdAt, since)
        )
      )
      .limit(1)
  );
  return rows.length > 0;
}
