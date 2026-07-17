/**
 * cXML punchout primitives (supplier procurement round-trip).
 *
 * Implements the two documents Trade-Ops exchanges with a supplier:
 *   → PunchOutSetupRequest   (we POST this to the supplier's setup URL)
 *   ← PunchOutSetupResponse  (supplier returns the catalog StartPage URL)
 *   ← PunchOutOrderMessage   (supplier posts the cart back via BrowserFormPost)
 *
 * PURE module (no server-only/db imports) — build/parse logic is unit-tested.
 * Parsing is deliberately defensive: cXML in the wild is messy, so we extract
 * only the fields we consume and reject anything without them. Money converts
 * to integer cents at this boundary.
 */

export interface PunchoutLine {
  supplierPartId: string;
  description: string;
  qty: number;
  unitPriceCents: number;
  currency: string;
  uom: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Build the PunchOutSetupRequest we POST to the supplier's setup URL. */
export function buildSetupRequest(params: {
  buyerCookie: string;
  fromIdentity: string;
  toIdentity: string;
  sharedSecret: string;
  returnUrl: string; // our BrowserFormPost target
  payloadId: string;
  timestamp: string; // ISO
  userEmail?: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.014/cXML.dtd">
<cXML payloadID="${esc(params.payloadId)}" timestamp="${esc(params.timestamp)}">
  <Header>
    <From><Credential domain="NetworkID"><Identity>${esc(params.fromIdentity)}</Identity></Credential></From>
    <To><Credential domain="NetworkID"><Identity>${esc(params.toIdentity)}</Identity></Credential></To>
    <Sender>
      <Credential domain="NetworkID">
        <Identity>${esc(params.fromIdentity)}</Identity>
        <SharedSecret>${esc(params.sharedSecret)}</SharedSecret>
      </Credential>
      <UserAgent>Trade-Ops</UserAgent>
    </Sender>
  </Header>
  <Request deploymentMode="production">
    <PunchOutSetupRequest operation="create">
      <BuyerCookie>${esc(params.buyerCookie)}</BuyerCookie>
      ${params.userEmail ? `<Extrinsic name="UserEmail">${esc(params.userEmail)}</Extrinsic>` : ""}
      <BrowserFormPost><URL>${esc(params.returnUrl)}</URL></BrowserFormPost>
    </PunchOutSetupRequest>
  </Request>
</cXML>`;
}

const first = (xml: string, re: RegExp): string | undefined => xml.match(re)?.[1]?.trim();

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Parse the supplier's PunchOutSetupResponse → catalog StartPage URL. */
export function parseSetupResponse(xml: string): { ok: true; startPageUrl: string } | { ok: false; error: string } {
  const statusCode = first(xml, /<Status[^>]*\bcode="(\d+)"/i);
  if (statusCode && !statusCode.startsWith("2")) {
    const text = first(xml, /<Status[^>]*>([\s\S]*?)<\/Status>/i) ?? "";
    return { ok: false, error: `Supplier setup returned status ${statusCode}${text ? `: ${unescape(text).trim()}` : ""}` };
  }
  const url = first(xml, /<StartPage>\s*<URL>([\s\S]*?)<\/URL>\s*<\/StartPage>/i);
  if (!url) return { ok: false, error: "PunchOutSetupResponse has no StartPage URL" };
  return { ok: true, startPageUrl: unescape(url) };
}

/** Parse the PunchOutOrderMessage the supplier posts back with the cart. */
export function parseOrderMessage(
  xml: string
): { ok: true; buyerCookie: string; lines: PunchoutLine[]; totalCents: number } | { ok: false; error: string } {
  const buyerCookie = first(xml, /<BuyerCookie>([\s\S]*?)<\/BuyerCookie>/i);
  if (!buyerCookie) return { ok: false, error: "PunchOutOrderMessage has no BuyerCookie" };

  const lines: PunchoutLine[] = [];
  const itemRe = /<ItemIn\b([^>]*)>([\s\S]*?)<\/ItemIn>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const qty = Number(first(attrs, /quantity="([^"]*)"/i) ?? "");
    const supplierPartId = first(body, /<SupplierPartID>([\s\S]*?)<\/SupplierPartID>/i);
    const money = body.match(/<Money\b[^>]*currency="([^"]*)"[^>]*>([\s\S]*?)<\/Money>/i);
    const description = first(body, /<Description[^>]*>([\s\S]*?)<\/Description>/i);
    const uom = first(body, /<UnitOfMeasure>([\s\S]*?)<\/UnitOfMeasure>/i) ?? "EA";

    if (!supplierPartId || !money || !Number.isFinite(qty) || qty <= 0) {
      return { ok: false, error: `Malformed ItemIn (needs quantity, SupplierPartID, Money): ${m[0].slice(0, 120)}` };
    }
    const unitPrice = Number(money[2].trim());
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return { ok: false, error: `Malformed Money value '${money[2].trim()}' for part ${supplierPartId}` };
    }
    lines.push({
      supplierPartId: unescape(supplierPartId),
      description: unescape((description ?? supplierPartId).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
      qty,
      unitPriceCents: Math.round(unitPrice * 100),
      currency: money[1] || "USD",
      uom: unescape(uom),
    });
  }
  if (lines.length === 0) return { ok: false, error: "PunchOutOrderMessage contains no ItemIn lines" };

  const totalCents = lines.reduce((sum, l) => sum + Math.round(l.unitPriceCents * l.qty), 0);
  return { ok: true, buyerCookie: unescape(buyerCookie), lines, totalCents };
}

/** Defensive jsonb → lines reader for stored carts. */
export function readCartLines(blob: unknown): PunchoutLine[] {
  if (!Array.isArray(blob)) return [];
  const out: PunchoutLine[] = [];
  for (const l of blob) {
    if (
      l &&
      typeof l === "object" &&
      typeof (l as PunchoutLine).supplierPartId === "string" &&
      typeof (l as PunchoutLine).qty === "number" &&
      typeof (l as PunchoutLine).unitPriceCents === "number"
    ) {
      const line = l as PunchoutLine;
      out.push({
        supplierPartId: line.supplierPartId,
        description: typeof line.description === "string" ? line.description : line.supplierPartId,
        qty: line.qty,
        unitPriceCents: line.unitPriceCents,
        currency: typeof line.currency === "string" ? line.currency : "USD",
        uom: typeof line.uom === "string" ? line.uom : "EA",
      });
    }
  }
  return out;
}
