"use server";

import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, notify } from "@/lib/actions/helpers";
import { getConnector } from "@/lib/connectors/providers";
import type { ConnectorConfig } from "@/lib/connectors/types";
import { readCartLines } from "@/lib/punchout/cxml";
import { money } from "@/lib/format";

/**
 * Supplier punchout actions (procurement).
 *
 * Flow: startPunchout creates an org-scoped punchout_sessions row with an
 * unguessable buyerCookie, runs the cXML setup handshake through the
 * CXML_SUPPLIER connector, and redirects the browser to the supplier's
 * StartPage. The supplier posts the cart back to /api/punchout/return
 * (matched by buyerCookie). The cart NEVER lands on the estimate directly —
 * approvePunchoutCart (approvals.manage) converts lines to estimate line
 * items with a parts markup (constraint 8: approval-gated). All audited.
 */

const PROVIDER = "CXML_SUPPLIER";
/** Default parts markup applied when converting supplier cost → sell price. */
const PARTS_MARKUP = 1.5;

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function startPunchout(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "estimates.create")) throw new Error("Not allowed");
  const optionId = str(formData, "optionId");
  const estimateId = str(formData, "estimateId");
  if (!optionId || !estimateId) return;

  const connector = getConnector(PROVIDER);
  if (!connector?.procurement) return;

  // Load the org's supplier connection + verify the option belongs to the org.
  const { row, option } = await withTenant(session.organizationId, async (tx) => {
    const [conn] = await tx
      .select()
      .from(t.integrationConnections)
      .where(eq(t.integrationConnections.provider, PROVIDER));
    const opt = await tx.query.estimateOptions.findFirst({ where: eq(t.estimateOptions.id, optionId) });
    return { row: conn, option: opt };
  });
  if (!option) return;
  if (!row || row.status !== "CONNECTED") {
    await notify(
      session.userId,
      "⚠️ Supplier punchout not connected",
      "Configure the Supplier punchout (cXML) connector in Settings → Integrations first.",
      "/settings?tab=integrations"
    );
    return;
  }

  const config = (row.config ?? {}) as ConnectorConfig;
  const buyerCookie = randomUUID();

  await withTenant(session.organizationId, (tx) =>
    tx.insert(t.punchoutSessions).values({
      provider: PROVIDER,
      supplierName: (config.supplierName ?? "Supplier") as string,
      estimateOptionId: optionId,
      buyerCookie,
      requestedById: session.userId,
    })
  );

  const origin = headers().get("origin") ?? `http://${headers().get("host") ?? "localhost:3000"}`;
  const setup = await connector.procurement(config).setupPunchout({
    buyerCookie,
    returnUrl: `${origin}/api/punchout/return`,
    userEmail: session.email,
  });

  await audit(session.userId, setup.ok ? "PUNCHOUT_START" : "PUNCHOUT_START_FAILED", "PunchoutSession", buyerCookie, {
    optionId,
    supplier: config.supplierName,
    message: setup.message,
  });

  if (!setup.ok || !setup.startPageUrl) {
    await notify(
      session.userId,
      "⚠️ Supplier punchout failed",
      setup.message ?? "The supplier's setup endpoint did not return a catalog URL.",
      `/estimates/${estimateId}`
    );
    revalidatePath(`/estimates/${estimateId}`);
    return;
  }

  redirect(setup.startPageUrl);
}

/** Approve a returned cart: convert lines → estimate line items (marked-up). */
export async function approvePunchoutCart(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "approvals.manage")) throw new Error("Not allowed");
  const sessionId = str(formData, "sessionId");
  const estimateId = str(formData, "estimateId");
  if (!sessionId) return;

  const added = await withTenant(session.organizationId, async (tx) => {
    const po = await tx.query.punchoutSessions.findFirst({
      where: and(eq(t.punchoutSessions.id, sessionId), eq(t.punchoutSessions.status, "CART_RETURNED")),
    });
    if (!po) return 0;
    const lines = readCartLines(po.cart);
    if (lines.length === 0) return 0;

    for (const line of lines) {
      await tx.insert(t.estimateLineItems).values({
        optionId: po.estimateOptionId,
        description: `[${po.supplierName ?? "Supplier"} #${line.supplierPartId}] ${line.description}`,
        qty: line.qty,
        unitCostCents: line.unitPriceCents,
        unitPriceCents: Math.round(line.unitPriceCents * PARTS_MARKUP),
      });
    }
    await tx
      .update(t.punchoutSessions)
      .set({ status: "APPROVED", decidedById: session.userId, decidedAt: new Date() })
      .where(eq(t.punchoutSessions.id, sessionId));
    return lines.length;
  });

  if (added > 0) {
    await audit(session.userId, "PUNCHOUT_APPROVE", "PunchoutSession", sessionId, { lines: added });
    await notify(
      session.userId,
      "✅ Supplier cart approved",
      `${added} part line(s) added to the estimate at ${PARTS_MARKUP}× markup.`,
      estimateId ? `/estimates/${estimateId}` : "/approvals"
    );
  }
  if (estimateId) revalidatePath(`/estimates/${estimateId}`);
}

/** Reject a returned cart — nothing lands on the estimate. */
export async function rejectPunchoutCart(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "approvals.manage")) throw new Error("Not allowed");
  const sessionId = str(formData, "sessionId");
  const estimateId = str(formData, "estimateId");
  if (!sessionId) return;

  const totalCents = await withTenant(session.organizationId, async (tx) => {
    const po = await tx.query.punchoutSessions.findFirst({
      where: and(eq(t.punchoutSessions.id, sessionId), eq(t.punchoutSessions.status, "CART_RETURNED")),
    });
    if (!po) return null;
    const total = readCartLines(po.cart).reduce((s, l) => s + Math.round(l.unitPriceCents * l.qty), 0);
    await tx
      .update(t.punchoutSessions)
      .set({ status: "REJECTED", decidedById: session.userId, decidedAt: new Date() })
      .where(eq(t.punchoutSessions.id, sessionId));
    return total;
  });

  if (totalCents !== null) {
    await audit(session.userId, "PUNCHOUT_REJECT", "PunchoutSession", sessionId, {
      totalCents,
      totalLabel: money(totalCents),
    });
    if (estimateId) revalidatePath(`/estimates/${estimateId}`);
  }
}
