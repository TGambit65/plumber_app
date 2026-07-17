import { describe, expect, it } from "vitest";
import { buildSetupRequest, parseSetupResponse, parseOrderMessage, readCartLines } from "../punchout/cxml";

describe("cXML punchout primitives", () => {
  it("buildSetupRequest emits BuyerCookie, SharedSecret, and BrowserFormPost (escaped)", () => {
    const xml = buildSetupRequest({
      buyerCookie: "cookie-123",
      fromIdentity: "AN0100001",
      toIdentity: "AN0100002",
      sharedSecret: 'sec"<ret>',
      returnUrl: "https://app.example.com/api/punchout/return?a=1&b=2",
      payloadId: "p-1@trade-ops",
      timestamp: "2026-07-17T12:00:00Z",
      userEmail: "sales@apexplumbing.demo",
    });
    expect(xml).toContain("<BuyerCookie>cookie-123</BuyerCookie>");
    expect(xml).toContain("<SharedSecret>sec&quot;&lt;ret&gt;</SharedSecret>");
    expect(xml).toContain("<URL>https://app.example.com/api/punchout/return?a=1&amp;b=2</URL>");
    expect(xml).toContain('<Extrinsic name="UserEmail">sales@apexplumbing.demo</Extrinsic>');
    expect(xml).toContain('operation="create"');
  });

  it("parseSetupResponse extracts the StartPage URL and surfaces non-2xx statuses", () => {
    const ok = parseSetupResponse(
      `<cXML><Response><Status code="200" text="OK"/><PunchOutSetupResponse><StartPage><URL>https://supplier.example.com/store?s=abc&amp;x=1</URL></StartPage></PunchOutSetupResponse></Response></cXML>`
    );
    expect(ok).toEqual({ ok: true, startPageUrl: "https://supplier.example.com/store?s=abc&x=1" });

    const bad = parseSetupResponse(`<cXML><Response><Status code="401" text="Unauthorized">Bad shared secret</Status></Response></cXML>`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("401");

    const empty = parseSetupResponse(`<cXML><Response><Status code="200"/></Response></cXML>`);
    expect(empty.ok).toBe(false);
  });

  it("parseOrderMessage extracts cookie + typed lines with integer cents", () => {
    const r = parseOrderMessage(`<cXML>
      <Message><PunchOutOrderMessage>
        <BuyerCookie>bc-77</BuyerCookie>
        <ItemIn quantity="4">
          <ItemID><SupplierPartID>FRG-7741</SupplierPartID></ItemID>
          <ItemDetail>
            <UnitPrice><Money currency="USD">18.42</Money></UnitPrice>
            <Description xml:lang="en">3/4&quot; Brass Ball Valve</Description>
            <UnitOfMeasure>EA</UnitOfMeasure>
          </ItemDetail>
        </ItemIn>
        <ItemIn quantity="1">
          <ItemID><SupplierPartID>FRG-5580</SupplierPartID></ItemID>
          <ItemDetail><UnitPrice><Money currency="USD">612.00</Money></UnitPrice></ItemDetail>
        </ItemIn>
      </PunchOutOrderMessage></Message>
    </cXML>`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.buyerCookie).toBe("bc-77");
      expect(r.lines).toEqual([
        { supplierPartId: "FRG-7741", description: '3/4" Brass Ball Valve', qty: 4, unitPriceCents: 1842, currency: "USD", uom: "EA" },
        { supplierPartId: "FRG-5580", description: "FRG-5580", qty: 1, unitPriceCents: 61200, currency: "USD", uom: "EA" },
      ]);
      expect(r.totalCents).toBe(4 * 1842 + 61200);
    }
  });

  it("parseOrderMessage rejects missing cookie, empty carts, malformed items", () => {
    expect(parseOrderMessage("<cXML><Message></Message></cXML>").ok).toBe(false);
    expect(parseOrderMessage("<cXML><Message><PunchOutOrderMessage><BuyerCookie>x</BuyerCookie></PunchOutOrderMessage></Message></cXML>").ok).toBe(false);
    const badQty = parseOrderMessage(
      `<cXML><BuyerCookie>x</BuyerCookie><ItemIn quantity="-2"><ItemID><SupplierPartID>P</SupplierPartID></ItemID><ItemDetail><UnitPrice><Money currency="USD">1.00</Money></UnitPrice></ItemDetail></ItemIn></cXML>`
    );
    expect(badQty.ok).toBe(false);
    const badMoney = parseOrderMessage(
      `<cXML><BuyerCookie>x</BuyerCookie><ItemIn quantity="1"><ItemID><SupplierPartID>P</SupplierPartID></ItemID><ItemDetail><UnitPrice><Money currency="USD">1,00</Money></UnitPrice></ItemDetail></ItemIn></cXML>`
    );
    expect(badMoney.ok).toBe(false);
  });

  it("readCartLines defensively filters stored jsonb", () => {
    const good = { supplierPartId: "P1", description: "d", qty: 2, unitPriceCents: 100, currency: "USD", uom: "EA" };
    expect(readCartLines([good, { junk: true }, null, "x"])).toEqual([good]);
    expect(readCartLines(null)).toEqual([]);
    expect(readCartLines({})).toEqual([]);
  });
});
