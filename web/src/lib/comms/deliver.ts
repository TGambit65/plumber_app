import "server-only";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { t, withTenant } from "@/db";
import { getConnector } from "@/lib/connectors/providers";
import { decryptConfig } from "@/lib/connectors/secret-config";
import type { ConnectorConfig } from "@/lib/connectors/types";
import { normalizePhone } from "./templates";

/**
 * C1 — real customer-facing delivery of tokenized links (proposal / pay).
 *
 * Preference order: EMAIL (Mailgun connector) when the customer has an email
 * address, SMS (Twilio connector) as the fallback. Every outcome is explicit
 * and LOUD — a send that couldn't happen returns exactly why (no connector,
 * no address, opt-out, provider error) so callers can record it on the
 * outbound_messages row instead of silently pretending.
 */

export type LinkDeliveryOutcome = {
  channel: "EMAIL" | "SMS" | "NONE";
  status: "SENT" | "FAILED" | "SKIPPED_OPTOUT" | "SKIPPED_NO_PHONE" | "SKIPPED_NOT_CONNECTED";
  recipient?: string;
  externalId?: string;
  error?: string;
};

/** Absolute origin for public links: APP_URL env wins; else the request host. */
export function publicBaseUrl(): string {
  const env = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (env) return env;
  try {
    const h = headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) return `${h.get("x-forwarded-proto") ?? "http"}://${host}`;
  } catch {
    /* outside a request context (cron/webhook) — fall through */
  }
  return "http://localhost:3000";
}

export async function deliverCustomerLink(input: {
  organizationId: string;
  customerId: string;
  subject: string;
  emailBody: string;
  smsBody: string;
}): Promise<LinkDeliveryOutcome> {
  const { organizationId, customerId, subject, emailBody, smsBody } = input;

  const { customer, emailConn, smsConn } = await withTenant(organizationId, async (tx) => {
    const customer = await tx.query.customers.findFirst({ where: eq(t.customers.id, customerId) });
    const conns = await tx.query.integrationConnections.findMany();
    return {
      customer,
      emailConn: conns.find((c) => c.provider === "EMAIL"),
      smsConn: conns.find((c) => c.provider === "TWILIO"),
    };
  });
  if (!customer) return { channel: "NONE", status: "FAILED", error: "customer not found" };

  // ── Preferred: email ──
  const emailConnector = getConnector("EMAIL");
  if (customer.email && emailConn?.status === "CONNECTED" && emailConnector?.messaging) {
    const config = decryptConfig(emailConnector.descriptor, (emailConn.config ?? {}) as ConnectorConfig);
    const result = await emailConnector.messaging(config).sendEmail(customer.email, subject, emailBody);
    if (result.ok) {
      return { channel: "EMAIL", status: "SENT", recipient: customer.email, externalId: result.externalId };
    }
    console.error(`[deliver] email to ${customer.email} failed (${result.message}) — trying SMS fallback`);
  }

  // ── Fallback: SMS ──
  const to = normalizePhone(customer.phone);
  const smsConnector = getConnector("TWILIO");
  if (smsConn?.status === "CONNECTED" && smsConnector?.messaging) {
    if (customer.smsOptOut) return { channel: "SMS", status: "SKIPPED_OPTOUT", recipient: customer.phone ?? undefined };
    if (!to) return { channel: "SMS", status: "SKIPPED_NO_PHONE", error: `unroutable phone: ${customer.phone ?? "none"}` };
    const config = decryptConfig(smsConnector.descriptor, (smsConn.config ?? {}) as ConnectorConfig);
    const result = await smsConnector.messaging(config).sendSms(to, smsBody);
    return result.ok
      ? { channel: "SMS", status: "SENT", recipient: to, externalId: result.externalId }
      : { channel: "SMS", status: "FAILED", recipient: to, error: result.message ?? "send failed" };
  }

  // ── Neither connector — loud, honest, non-fatal ──
  const error = "No delivery connector — connect Email (Mailgun) or Twilio to reach customers";
  console.error(`[deliver DEGRADED] ${error}`);
  return { channel: "NONE", status: "SKIPPED_NOT_CONNECTED", error };
}
