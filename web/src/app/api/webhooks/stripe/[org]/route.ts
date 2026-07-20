import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db, t, withTenant } from "@/db";
import { getConnector } from "@/lib/connectors/providers";
import { decryptConfig } from "@/lib/connectors/secret-config";
import type { ConnectorConfig } from "@/lib/connectors/types";
import { lineTotal, money } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/stripe/[org] — Stripe webhook receiver (C1 payments).
 *
 * On checkout.session.completed we record the payment against the invoice the
 * session was created for (client_reference_id round-trips OUR invoice id) and
 * roll the invoice to PAID/PARTIAL — the same math as the internal
 * recordPayment action. Idempotent: a session id we've already recorded as a
 * payment reference is acknowledged and skipped (Stripe retries deliveries).
 *
 * Security (mirrors the Jobber webhook): Stripe-Signature carries
 * `t=<ts>,v1=<hex(HMAC-SHA256(`${ts}.${rawBody}`, webhookSecret))>`. We verify
 * with a constant-time compare against the org's encrypted-at-rest signing
 * secret. Invalid/absent signature → 403; no secret configured → REJECT
 * (fail closed).
 */

function validStripeSignature(secret: string, rawBody: string, header: string): boolean {
  const parts = new Map(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as const;
    })
  );
  const ts = parts.get("t");
  const v1 = parts.get("v1");
  if (!ts || !v1) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest, { params: routeParams }: { params: { org: string } }) {
  try {
    const org = await db.query.organizations.findFirst({
      where: eq(t.organizations.slug, routeParams.org.toLowerCase().trim()),
    });
    if (!org || !org.active) return NextResponse.json({ error: "unknown org" }, { status: 404 });

    const [conn] = await withTenant(org.id, (tx) =>
      tx.select().from(t.integrationConnections).where(eq(t.integrationConnections.provider, "STRIPE"))
    );
    const connector = getConnector("STRIPE");
    if (!conn || !connector) return NextResponse.json({ error: "stripe not configured" }, { status: 404 });
    const config = decryptConfig(connector.descriptor, (conn.config ?? {}) as ConnectorConfig);

    // Fail closed: verification REQUIRES the signing secret.
    const webhookSecret = (config.webhookSecret ?? "").trim();
    const signature = req.headers.get("stripe-signature") ?? "";
    const rawBody = await req.text();
    if (!webhookSecret || !signature || !validStripeSignature(webhookSecret, rawBody, signature)) {
      console.error(`[stripe webhook ${org.slug}] invalid or missing signature`);
      return NextResponse.json({ error: "invalid signature" }, { status: 403 });
    }

    let event: {
      type?: string;
      data?: {
        object?: {
          id?: string;
          client_reference_id?: string | null;
          amount_total?: number;
          payment_intent?: string | null;
          payment_status?: string;
        };
      };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }

    if (event.type !== "checkout.session.completed") {
      // Not an event we act on — acknowledge so Stripe doesn't retry.
      return NextResponse.json({ ok: true, ignored: event.type ?? "no type" });
    }

    const session = event.data?.object ?? {};
    const invoiceId = session.client_reference_id ?? "";
    const amountCents = Math.round(session.amount_total ?? 0);
    const reference = session.payment_intent ?? session.id ?? "stripe-checkout";
    if (!invoiceId || amountCents <= 0) {
      console.error(`[stripe webhook ${org.slug}] session missing reference/amount`);
      return NextResponse.json({ ok: true, recorded: false });
    }

    const outcome = await withTenant(org.id, async (tx) => {
      const inv = await tx.query.invoices.findFirst({
        where: eq(t.invoices.id, invoiceId),
        with: { items: true, payments: true },
      });
      if (!inv) return { recorded: false as const, reason: "invoice not found" };
      // Idempotency: Stripe retries — skip if this session/intent is recorded.
      if (inv.payments.some((p) => p.reference === reference)) {
        return { recorded: false as const, reason: "duplicate delivery" };
      }
      await tx.insert(t.payments).values({ invoiceId, amountCents, method: "CARD", reference });
      const total = lineTotal(inv.items);
      const paid = inv.payments.reduce((s, p) => s + p.amountCents, 0) + amountCents;
      const status = paid >= total ? ("PAID" as const) : ("PARTIAL" as const);
      await tx.update(t.invoices).set({ status }).where(eq(t.invoices.id, invoiceId));
      await tx.insert(t.activities).values({
        kind: "PAYMENT",
        body: `Online payment ${money(amountCents)} (card) received on ${inv.number} via Stripe Checkout${
          status === "PARTIAL" ? " — partial" : " — paid in full"
        }`,
        customerId: inv.customerId,
        jobId: inv.jobId ?? undefined,
      });
      await tx.insert(t.auditLogs).values({
        userId: null,
        action: "ONLINE_PAYMENT_RECORDED",
        entity: "Invoice",
        entityId: invoiceId,
        detail: { amountCents, reference, status, via: "stripe_webhook" },
      });
      return { recorded: true as const, status, amountCents };
    });

    console.log(`[stripe webhook ${org.slug}] checkout.session.completed → ${JSON.stringify(outcome)}`);
    return NextResponse.json({ ok: true, ...outcome });
  } catch (e) {
    console.error(`[stripe webhook] ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "webhook failed" }, { status: 500 });
  }
}
