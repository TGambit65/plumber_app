import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db, t, withTenant } from "@/db";
import { getConnector } from "@/lib/connectors/providers";
import { decryptConfig } from "@/lib/connectors/secret-config";
import type { ConnectorConfig } from "@/lib/connectors/types";
import { normalizePhone } from "@/lib/comms/templates";

export const dynamic = "force-dynamic";

/**
 * POST /api/sms/inbound/[org] — Twilio inbound-SMS webhook (per-org URL,
 * configured on the org's Twilio number).
 *
 * Handles STOP/UNSUBSCRIBE/CANCEL (sets customers.smsOptOut) and
 * START/UNSTOP (clears it), matching the sender's number to a customer
 * INSIDE the org's tenant (RLS-scoped). Carriers enforce STOP at their layer
 * too — this keeps OUR records honest so the pipeline skips opted-out
 * customers on every future send.
 *
 * Security: requests are verified against Twilio's X-Twilio-Signature
 * (HMAC-SHA1 of the exact URL + sorted POST params, keyed by the org's auth
 * token). Invalid signature → 403. If the org has no Twilio connection the
 * webhook 404s.
 */

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);

function validSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  // Twilio spec: append each POST param (sorted by key) as key+value to the URL, HMAC-SHA1, base64.
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest, { params: routeParams }: { params: { org: string } }) {
  try {
    const org = await db.query.organizations.findFirst({
      where: eq(t.organizations.slug, routeParams.org.toLowerCase().trim()),
    });
    if (!org || !org.active) return NextResponse.json({ error: "unknown org" }, { status: 404 });

    // Load the org's Twilio auth token (decrypted) for signature verification.
    const [conn] = await withTenant(org.id, (tx) =>
      tx.select().from(t.integrationConnections).where(eq(t.integrationConnections.provider, "TWILIO"))
    );
    const connector = getConnector("TWILIO");
    if (!conn || !connector) return NextResponse.json({ error: "twilio not configured" }, { status: 404 });
    const config = decryptConfig(connector.descriptor, (conn.config ?? {}) as ConnectorConfig);
    const authToken = (config.apiKey ?? "").trim();

    const form = await req.formData();
    const bodyParams: Record<string, string> = {};
    form.forEach((v, k) => {
      if (typeof v === "string") bodyParams[k] = v;
    });

    const signature = req.headers.get("x-twilio-signature") ?? "";
    if (authToken && !validSignature(authToken, req.url, bodyParams, signature)) {
      console.error(`[sms inbound ${org.slug}] invalid Twilio signature`);
      return NextResponse.json({ error: "invalid signature" }, { status: 403 });
    }

    const from = normalizePhone(bodyParams.From ?? "");
    const word = (bodyParams.Body ?? "").trim().toUpperCase().split(/\s+/)[0] ?? "";
    if (!from) return twiml();

    const optOut = STOP_WORDS.has(word) ? true : START_WORDS.has(word) ? false : null;
    if (optOut === null) return twiml(); // not a keyword — acknowledge, take no action

    await withTenant(org.id, async (tx) => {
      const customers = await tx.query.customers.findMany({ columns: { id: true, phone: true } });
      const matches = customers.filter((c) => normalizePhone(c.phone) === from);
      for (const c of matches) {
        await tx.update(t.customers).set({ smsOptOut: optOut }).where(eq(t.customers.id, c.id));
      }
      console.log(`[sms inbound ${org.slug}] ${word} from ${from} → ${matches.length} customer(s) smsOptOut=${optOut}`);
    });
    return twiml();
  } catch (e) {
    console.error(`[sms inbound] ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "inbound failed" }, { status: 500 });
  }
}

/** Empty TwiML response — tells Twilio "received, no reply" (carrier auto-replies to STOP). */
function twiml() {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    status: 200,
    headers: { "content-type": "text/xml" },
  });
}
