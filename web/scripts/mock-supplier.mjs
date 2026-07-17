/**
 * Mock cXML supplier for punchout verification (dev/test only).
 *
 * POST /cxml/setup  — validates the PunchOutSetupRequest (shared secret!) and
 *                     returns a PunchOutSetupResponse with a StartPage URL.
 * GET  /store       — a tiny catalog page. "Submit cart" posts a
 *                     PunchOutOrderMessage (cxml-urlencoded) to the
 *                     BrowserFormPost URL captured at setup, echoing the
 *                     BuyerCookie — exactly how real suppliers return carts.
 *
 * Env: PORT (default 8903), SECRET (default "mascott-shared-secret")
 */
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8903);
const BASE = `http://localhost:${PORT}`;
const SECRET = process.env.SECRET || "mascott-shared-secret";

/** sessionKey → { buyerCookie, returnUrl } */
const sessions = new Map();

const CATALOG = [
  { part: "FRG-7741", desc: '3/4" Brass Ball Valve, Full Port', price: "18.42", uom: "EA", qty: 4 },
  { part: "FRG-2210", desc: "PEX-A Expansion Fitting Kit (50 pc)", price: "96.10", uom: "BX", qty: 1 },
  { part: "FRG-5580", desc: "40 gal Gas Water Heater, 40k BTU", price: "612.00", uom: "EA", qty: 1 },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);

  if (req.method === "POST" && url.pathname === "/cxml/setup") {
    let body = "";
    for await (const c of req) body += c;
    const secret = body.match(/<SharedSecret>([\s\S]*?)<\/SharedSecret>/)?.[1];
    const buyerCookie = body.match(/<BuyerCookie>([\s\S]*?)<\/BuyerCookie>/)?.[1];
    const returnUrl = body.match(/<BrowserFormPost>\s*<URL>([\s\S]*?)<\/URL>/)?.[1];
    if (secret !== SECRET) {
      res.writeHead(200, { "content-type": "text/xml" });
      return res.end(`<?xml version="1.0"?><cXML payloadID="e" timestamp="t"><Response><Status code="401" text="Unauthorized">Bad shared secret</Status></Response></cXML>`);
    }
    if (!buyerCookie || !returnUrl) {
      res.writeHead(200, { "content-type": "text/xml" });
      return res.end(`<?xml version="1.0"?><cXML payloadID="e" timestamp="t"><Response><Status code="400" text="Bad Request">Missing BuyerCookie/BrowserFormPost</Status></Response></cXML>`);
    }
    const key = crypto.randomBytes(8).toString("hex");
    sessions.set(key, { buyerCookie, returnUrl });
    res.writeHead(200, { "content-type": "text/xml" });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<cXML payloadID="${Date.now()}@mock-supplier" timestamp="${new Date().toISOString()}">
  <Response>
    <Status code="200" text="OK"/>
    <PunchOutSetupResponse>
      <StartPage><URL>${BASE}/store?s=${key}</URL></StartPage>
    </PunchOutSetupResponse>
  </Response>
</cXML>`);
  }

  if (req.method === "GET" && url.pathname === "/store") {
    const s = sessions.get(url.searchParams.get("s") ?? "");
    if (!s) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<h1>Unknown punchout session</h1>");
    }
    const orderMessage = `<?xml version="1.0" encoding="UTF-8"?>
<cXML payloadID="${Date.now()}.cart@mock-supplier" timestamp="${new Date().toISOString()}">
  <Message>
    <PunchOutOrderMessage>
      <BuyerCookie>${s.buyerCookie}</BuyerCookie>
      <PunchOutOrderMessageHeader operationAllowed="create">
        <Total><Money currency="USD">781.78</Money></Total>
      </PunchOutOrderMessageHeader>
      ${CATALOG.map(
        (i) => `<ItemIn quantity="${i.qty}">
        <ItemID><SupplierPartID>${i.part}</SupplierPartID></ItemID>
        <ItemDetail>
          <UnitPrice><Money currency="USD">${i.price}</Money></UnitPrice>
          <Description xml:lang="en">${i.desc}</Description>
          <UnitOfMeasure>${i.uom}</UnitOfMeasure>
        </ItemDetail>
      </ItemIn>`
      ).join("\n      ")}
    </PunchOutOrderMessage>
  </Message>
</cXML>`;
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><html><head><title>Ferguson Mock Catalog</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto">
  <h1>🛒 Ferguson (mock) — punchout catalog</h1>
  <ul>${CATALOG.map((i) => `<li>${i.qty} × ${i.desc} — $${i.price}/${i.uom}</li>`).join("")}</ul>
  <form method="POST" action="${s.returnUrl}">
    <input type="hidden" name="cxml-urlencoded" value="${orderMessage.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}" />
    <button type="submit" id="submit-cart" style="font-size:16px;padding:10px 18px">Submit cart to Trade-Ops</button>
  </form>
</body></html>`);
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`mock-supplier listening on ${BASE} (secret ${SECRET})`));
