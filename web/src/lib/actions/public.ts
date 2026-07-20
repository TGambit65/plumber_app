"use server";

/**
 * C1 — PUBLIC (sessionless) actions for the customer proposal page.
 *
 * No session exists here: the caller proves access with an unguessable
 * 48-hex-char token minted when the estimate was sent. Every action
 * re-resolves the token server-side via the SECURITY DEFINER lookup
 * (estimate_by_public_token) — the token in the form is never trusted to
 * carry ids — then re-enters withTenant(org) so RLS applies as usual.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db, t, withTenant } from "@/db";
import { approveEstimateCore } from "@/lib/actions/sales";
import { auditOrg, logActivityOrg, notifyOrg } from "@/lib/actions/helpers";
import { publicBaseUrl } from "@/lib/comms/deliver";
import { getConnector } from "@/lib/connectors/providers";
import { decryptConfig } from "@/lib/connectors/secret-config";
import type { ConnectorConfig } from "@/lib/connectors/types";
import { lineTotal } from "@/lib/format";

/** Resolve a public token to {id, organizationId} or null. Global lookup —
 * runs outside any tenant scope via SECURITY DEFINER. */
async function resolveToken(token: string): Promise<{ id: string; organizationId: string } | null> {
  if (!token || token.length < 16 || token.length > 128) return null;
  const res = await db.execute(
    sql`SELECT id, organization_id FROM estimate_by_public_token(${token})`
  );
  const row = (res.rows?.[0] ?? null) as { id: string; organization_id: string } | null;
  return row ? { id: row.id, organizationId: row.organization_id } : null;
}

/** Customer picks an option and e-signs from the proposal page. */
export async function publicApproveEstimate(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const optionId = String(formData.get("optionId") ?? "");
  const signedName = String(formData.get("signedName") ?? "").trim();
  if (!optionId || !signedName) throw new Error("Pick an option and type your name to sign.");

  const hit = await resolveToken(token);
  if (!hit) throw new Error("This proposal link is no longer valid.");

  // Refuse terminal states before running the pipeline.
  const est = await withTenant(hit.organizationId, (tx) =>
    tx.query.estimates.findFirst({ where: eq(t.estimates.id, hit.id) })
  );
  if (!est) throw new Error("This proposal link is no longer valid.");
  if (est.status === "APPROVED") throw new Error("This proposal has already been approved.");
  if (est.status === "DECLINED") throw new Error("This proposal was declined. Contact us to reopen it.");
  if (est.status === "EXPIRED" || (est.expiresAt && est.expiresAt < new Date()))
    throw new Error("This proposal has expired. Contact us for a refreshed quote.");

  await approveEstimateCore(hit.organizationId, hit.id, optionId, signedName, {
    userId: null,
    label: signedName,
  });

  revalidatePath(`/proposal/${token}`);
}

/** Resolve an invoice pay token to {id, organizationId} or null. */
async function resolveInvoiceToken(token: string): Promise<{ id: string; organizationId: string } | null> {
  if (!token || token.length < 16 || token.length > 128) return null;
  const res = await db.execute(sql`SELECT id, organization_id FROM invoice_by_public_token(${token})`);
  const row = (res.rows?.[0] ?? null) as { id: string; organization_id: string } | null;
  return row ? { id: row.id, organizationId: row.organization_id } : null;
}

/** Customer clicks "Pay now" on the public invoice page → Stripe Checkout. */
export async function publicStartCheckout(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const hit = await resolveInvoiceToken(token);
  if (!hit) throw new Error("This payment link is no longer valid.");

  const { inv, balance, connRow } = await withTenant(hit.organizationId, async (tx) => {
    const inv = await tx.query.invoices.findFirst({
      where: eq(t.invoices.id, hit.id),
      with: { customer: true, items: true, payments: true },
    });
    if (!inv) throw new Error("This payment link is no longer valid.");
    const balance = lineTotal(inv.items) - inv.payments.reduce((s, p) => s + p.amountCents, 0);
    const [connRow] = await tx
      .select()
      .from(t.integrationConnections)
      .where(eq(t.integrationConnections.provider, "STRIPE"));
    return { inv, balance, connRow };
  });

  if (["PAID", "VOID"].includes(inv.status)) throw new Error("This invoice is settled — nothing to pay.");
  if (balance <= 0) throw new Error("This invoice has no open balance.");
  if (!connRow || connRow.status !== "CONNECTED") {
    throw new Error("Online payment isn't set up — please call the office to pay.");
  }
  const connector = getConnector("STRIPE");
  if (!connector?.payments) throw new Error("Online payment isn't available right now.");

  const config = decryptConfig(connector.descriptor, (connRow.config ?? {}) as ConnectorConfig);
  const base = publicBaseUrl();
  const result = await connector.payments(config).createCheckoutSession({
    amountCents: balance,
    description: `Invoice ${inv.number}`,
    successUrl: `${base}/pay/${token}?paid=1`,
    cancelUrl: `${base}/pay/${token}`,
    reference: inv.id,
    customerEmail: inv.customer.email ?? undefined,
  });
  if (!result.ok || !result.url) {
    throw new Error(`Couldn't start checkout — ${result.message ?? "payment provider error"}`);
  }

  await logActivityOrg(hit.organizationId, {
    kind: "SYSTEM",
    body: `Customer opened online checkout for ${inv.number} (${result.sessionId ?? "session"})`,
    customerId: inv.customerId,
  });
  redirect(result.url);
}

/** Customer declines from the proposal page (optional reason). */
export async function publicDeclineEstimate(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();

  const hit = await resolveToken(token);
  if (!hit) throw new Error("This proposal link is no longer valid.");

  const est = await withTenant(hit.organizationId, async (tx) => {
    const found = await tx.query.estimates.findFirst({ where: eq(t.estimates.id, hit.id) });
    if (!found) throw new Error("This proposal link is no longer valid.");
    if (found.status === "APPROVED") throw new Error("This proposal has already been approved.");
    if (found.status === "DECLINED") return found; // idempotent

    await tx
      .update(t.estimates)
      .set({ status: "DECLINED" })
      .where(eq(t.estimates.id, hit.id));

    // Stop the automated follow-up sequence — the customer answered.
    await tx
      .update(t.followUps)
      .set({ status: "SKIPPED" })
      .where(and(eq(t.followUps.estimateId, hit.id), eq(t.followUps.status, "PENDING")));

    // Lead goes LOST, with the customer's own words as the reason.
    if (found.leadId) {
      const lead = await tx.query.leads.findFirst({ where: eq(t.leads.id, found.leadId) });
      if (lead) {
        const lostReason = reason || "Declined via proposal link";
        await tx
          .update(t.leads)
          .set({ stage: "LOST", lostReason, lastContactAt: new Date() })
          .where(eq(t.leads.id, found.leadId));
        await tx.insert(t.activities).values({
          kind: "STATUS",
          body: `Lead marked LOST — ${lostReason}`,
          leadId: found.leadId,
          customerId: lead.customerId ?? undefined,
        });
      }
    }
    return found;
  });

  if (est.status !== "DECLINED") {
    await logActivityOrg(hit.organizationId, {
      kind: "NOTE",
      body: `Estimate ${est.number} declined by customer via proposal link${reason ? ` — "${reason}"` : ""}`,
      customerId: est.customerId ?? undefined,
      leadId: est.leadId ?? undefined,
    });
    await notifyOrg(
      hit.organizationId,
      est.createdById,
      `Proposal ${est.number} declined`,
      reason ? `Customer's reason: ${reason}` : "Declined via the proposal link (no reason given).",
      `/estimates/${est.id}`
    );
    await auditOrg(hit.organizationId, null, "ESTIMATE_DECLINED", "estimate", est.id, {
      via: "public_proposal",
      reason: reason || undefined,
    });
  }

  revalidatePath(`/proposal/${token}`);
}
