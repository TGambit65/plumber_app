import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db, t, withTenant } from "@/db";
import { parseOrderMessage } from "@/lib/punchout/cxml";

export const dynamic = "force-dynamic";

/**
 * POST /api/punchout/return — the supplier's BrowserFormPost target.
 *
 * The supplier posts the PunchOutOrderMessage here via the user's browser as
 * `application/x-www-form-urlencoded` with the cXML in `cxml-urlencoded` (or
 * raw XML). This is a CROSS-SITE POST, so the user's sameSite session cookie
 * is NOT present — the unguessable buyerCookie (uuid, unique, minted by
 * startPunchout) is the capability token. It resolves to (session, org)
 * through the SECURITY DEFINER function punchout_session_by_cookie; everything
 * after re-enters withTenant(org), so RLS scopes all writes.
 *
 * The cart is STORED for review, never applied — an approver converts it to
 * estimate line items (constraint 8: approval-gated ingress of external data).
 */
export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    let xml = "";
    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      xml = String(form.get("cxml-urlencoded") ?? form.get("cXML-urlencoded") ?? form.get("cxml") ?? "");
    } else {
      xml = await req.text();
    }
    if (!xml.trim()) return NextResponse.json({ error: "empty_body" }, { status: 400 });

    const parsed = parseOrderMessage(xml);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    // Capability lookup: buyerCookie → (session id, org). SECURITY DEFINER —
    // the only global read of punchout_sessions.
    const result = await db.execute(
      sql`SELECT id, organization_id, status FROM punchout_session_by_cookie(${parsed.buyerCookie})`
    );
    const found = (result.rows as Array<{ id: string; organization_id: string; status: string }>)[0];
    if (!found) return NextResponse.json({ error: "unknown_buyer_cookie" }, { status: 404 });
    if (found.status !== "STARTED") return NextResponse.json({ error: "session_not_open" }, { status: 409 });

    // Store the cart org-scoped; look up the estimate for the redirect.
    const estimateId = await withTenant(found.organization_id, async (tx) => {
      await tx
        .update(t.punchoutSessions)
        .set({ status: "CART_RETURNED", cart: parsed.lines, returnedAt: new Date() })
        .where(eq(t.punchoutSessions.id, found.id));
      const po = await tx.query.punchoutSessions.findFirst({
        where: eq(t.punchoutSessions.id, found.id),
        with: { estimateOption: true },
      });
      return po?.estimateOption?.estimateId ?? null;
    });

    // 303: the user's browser follows with a GET — their session cookie applies
    // there, so they land authenticated on the estimate's review card.
    const target = estimateId ? `/estimates/${estimateId}` : "/approvals";
    return NextResponse.redirect(new URL(target, req.url), 303);
  } catch (err) {
    console.error(`[punchout/return] ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "punchout_return_failed" }, { status: 500 });
  }
}
