import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db, t, withTenant } from "@/db";
import { getConnector } from "@/lib/connectors/providers";
import { fetchJobberJob } from "@/lib/connectors/jobber";
import { decryptConfig } from "@/lib/connectors/secret-config";
import type { ConnectorConfig } from "@/lib/connectors/types";
import { upsertExternalJobs } from "@/lib/fsm/import";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/jobber/[org] — Jobber webhook receiver (dispatch D5).
 *
 * Jobber pushes { data: { webHookEvent: { topic, itemId, occurredAt } } }
 * whenever a subscribed record changes. On JOB_CREATE / JOB_UPDATE /
 * JOB_COMPLETE we fetch the changed job via GraphQL and run it through the
 * SAME upsert pipeline as the manual "Import jobs" button — so a reschedule
 * inside Jobber lands on the local dispatch board without anyone clicking
 * anything, deduped by external_ref exactly like a full re-import.
 *
 * Security (mirrors the Twilio inbound route): every request must carry
 * X-Jobber-Hmac-SHA256 = base64(HMAC-SHA256(rawBody, clientSecret)). We
 * verify against the org's stored (encrypted-at-rest) client secret with a
 * constant-time compare. Invalid/absent signature → 403; org without a
 * Jobber connection → 404. If no client secret is configured we REJECT
 * (fail closed) rather than accept unauthenticated pushes.
 */

const JOB_TOPICS = new Set(["JOB_CREATE", "JOB_UPDATE", "JOB_COMPLETE"]);

function validSignature(clientSecret: string, rawBody: string, signature: string): boolean {
  const expected = createHmac("sha256", clientSecret).update(rawBody, "utf8").digest("base64");
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

    const [conn] = await withTenant(org.id, (tx) =>
      tx.select().from(t.integrationConnections).where(eq(t.integrationConnections.provider, "JOBBER"))
    );
    const connector = getConnector("JOBBER");
    if (!conn || !connector) return NextResponse.json({ error: "jobber not configured" }, { status: 404 });
    const config = decryptConfig(connector.descriptor, (conn.config ?? {}) as ConnectorConfig);

    // Fail closed: webhook verification REQUIRES the client secret.
    const clientSecret = (config.clientSecret ?? "").trim();
    const signature = req.headers.get("x-jobber-hmac-sha256") ?? "";
    const rawBody = await req.text();
    if (!clientSecret || !signature || !validSignature(clientSecret, rawBody, signature)) {
      console.error(`[jobber webhook ${org.slug}] invalid or missing HMAC signature`);
      return NextResponse.json({ error: "invalid signature" }, { status: 403 });
    }

    let topic = "";
    let itemId = "";
    try {
      const payload = JSON.parse(rawBody) as { data?: { webHookEvent?: { topic?: string; itemId?: string } } };
      topic = payload.data?.webHookEvent?.topic ?? "";
      itemId = payload.data?.webHookEvent?.itemId ?? "";
    } catch {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }

    if (!JOB_TOPICS.has(topic) || !itemId) {
      // Not a topic we act on — acknowledge so Jobber doesn't retry.
      return NextResponse.json({ ok: true, ignored: topic || "no topic" });
    }

    const job = await fetchJobberJob(config, itemId);
    if (!job) {
      // Fetch failed (deleted record / API hiccup) — 200 so Jobber doesn't
      // hammer retries; the next manual/scheduled import reconciles.
      console.error(`[jobber webhook ${org.slug}] could not fetch job ${itemId} after ${topic}`);
      return NextResponse.json({ ok: true, fetched: false });
    }

    const summary = await upsertExternalJobs(org.id, "JOBBER", [job]);
    console.log(
      `[jobber webhook ${org.slug}] ${topic} job ${itemId} → created=${summary.created} updated=${summary.updated}`
    );
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error(`[jobber webhook] ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "webhook failed" }, { status: 500 });
  }
}
