import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { hubspotConnector } from "../hubspot";
import { quickbooksConnector } from "../quickbooks";

/**
 * Integration tests for the LIVE HubSpot + QuickBooks connector clients,
 * exercised against in-process mock servers that implement the vendors'
 * ACTUAL API shapes (paths, auth headers, payload contracts). Auth and
 * rate-limit failure paths included.
 */

const HS_TOKEN = "hs-good-token";
const QB_TOKEN = "qb-good-token";
const REALM = "4620816365291234570";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

// ── Mock HubSpot (CRM v3/v4 shapes) ─────────────────────────────────────────

const hsCaptured: Record<string, unknown> = {};
const hsServer = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const auth = req.headers.authorization ?? "";
  if (auth === "Bearer hs-rl-token") return send(429, { message: "You have reached your limit" });
  if (auth !== `Bearer ${HS_TOKEN}`) return send(401, { message: "Invalid token" });

  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const body = req.method === "GET" ? "" : await readBody(req);
  const json = body ? JSON.parse(body) : undefined;

  if (req.method === "GET" && path === "/crm/v3/objects/contacts") return send(200, { results: [] });

  if (req.method === "POST" && path === "/crm/v3/objects/deals/search") {
    hsCaptured.dealSearch = json;
    return send(200, {
      results: [
        { id: "9001", properties: { dealname: "Water heater replacement", amount: "2850.00", dealstage: "appointmentscheduled" } },
        { id: "9002", properties: { dealname: "Backflow testing x3", amount: null, dealstage: "qualifiedtobuy" } },
      ],
    });
  }

  if (req.method === "POST" && path === "/crm/v4/associations/deal/contact/batch/read") {
    return send(200, { results: [{ from: { id: "9001" }, to: [{ toObjectId: 501 }] }] });
  }

  if (req.method === "POST" && path === "/crm/v3/objects/contacts/batch/read") {
    return send(200, {
      results: [
        { id: "501", properties: { firstname: "Dana", lastname: "Whitfield", email: "dana.w@example.com", phone: "555-0161" } },
      ],
    });
  }

  if (req.method === "POST" && path === "/crm/v3/objects/contacts/search") {
    const email = json?.filterGroups?.[0]?.filters?.[0]?.value;
    if (email === "known@example.com") return send(200, { results: [{ id: "777", properties: { email } }] });
    return send(200, { results: [] });
  }

  if (req.method === "POST" && path === "/crm/v3/objects/contacts") {
    hsCaptured.contactCreate = json;
    return send(201, { id: "801", properties: json.properties });
  }

  if (req.method === "PATCH" && path === "/crm/v3/objects/contacts/777") {
    hsCaptured.contactPatch = json;
    return send(200, { id: "777", properties: json.properties });
  }

  if (req.method === "POST" && path === "/crm/v3/objects/notes") {
    hsCaptured.noteCreate = json;
    return send(201, { id: "n-4401", properties: json.properties });
  }

  send(404, { message: `no route ${req.method} ${path}` });
});

// ── Mock QuickBooks Online (Accounting API v3 shapes) ───────────────────────

const qbCaptured: Record<string, unknown> = {};
const qbServer = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${QB_TOKEN}`) {
    return send(401, { Fault: { Error: [{ Message: "AuthenticationFailed", Detail: "Token expired" }] } });
  }
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  if (!path.startsWith(`/v3/company/${REALM}/`)) {
    return send(404, { Fault: { Error: [{ Message: "Wrong realm" }] } });
  }
  const op = path.slice(`/v3/company/${REALM}/`.length);
  const body = req.method === "GET" ? "" : await readBody(req);
  const json = body ? JSON.parse(body) : undefined;

  if (req.method === "GET" && op === `companyinfo/${REALM}`) {
    return send(200, { CompanyInfo: { CompanyName: "Apex Test Co" } });
  }

  if (req.method === "GET" && op === "query") {
    const query = url.searchParams.get("query") ?? "";
    qbCaptured.lastQuery = query;
    if (query.includes("from Customer") && query.includes("'Known Corp'")) {
      return send(200, { QueryResponse: { Customer: [{ Id: "12", DisplayName: "Known Corp" }] } });
    }
    if (query.includes("from Customer")) return send(200, { QueryResponse: {} });
    if (query.includes("from Invoice") && query.includes("'INV-1001'")) {
      return send(200, { QueryResponse: { Invoice: [{ Id: "33", DocNumber: "INV-1001", CustomerRef: { value: "12" }, Balance: 450.0 }] } });
    }
    if (query.includes("from Invoice")) return send(200, { QueryResponse: {} });
    return send(400, { Fault: { Error: [{ Message: "Unsupported query" }] } });
  }

  if (req.method === "POST" && op === "customer") {
    qbCaptured.customerCreate = json;
    return send(200, { Customer: { Id: "55", DisplayName: json.DisplayName } });
  }

  if (req.method === "POST" && op === "invoice") {
    qbCaptured.invoiceCreate = json;
    return send(200, { Invoice: { Id: "90", DocNumber: json.DocNumber } });
  }

  if (req.method === "POST" && op === "payment") {
    qbCaptured.paymentCreate = json;
    return send(200, { Payment: { Id: "70" } });
  }

  send(404, { Fault: { Error: [{ Message: `no route ${req.method} ${op}` }] } });
});

let hsBase = "";
let qbBase = "";

beforeAll(async () => {
  hsBase = await listen(hsServer);
  qbBase = await listen(qbServer);
});

afterAll(() => {
  hsServer.close();
  qbServer.close();
});

// ── HubSpot ──────────────────────────────────────────────────────────────────

describe("HubSpot live connector", () => {
  const config = () => ({ apiKey: HS_TOKEN, baseUrl: hsBase });

  it("health authenticates with the private-app bearer token", async () => {
    const h = await hubspotConnector.health(config());
    expect(h.ok).toBe(true);
    expect(h.degraded).toBe(false);
  });

  it("health fails LOUDLY on a bad token (401), degraded on rate-limit (429)", async () => {
    const bad = await hubspotConnector.health({ apiKey: "wrong", baseUrl: hsBase });
    expect(bad.ok).toBe(false);
    expect(bad.degraded).toBe(true);
    expect(bad.message).toContain("401");

    const rl = await hubspotConnector.health({ apiKey: "hs-rl-token", baseUrl: hsBase });
    expect(rl.ok).toBe(false);
    expect(rl.degraded).toBe(true);
    expect(rl.message).toContain("429");
  });

  it("pullLeads maps deals + associated contacts to ExternalLead (cents at the boundary)", async () => {
    const ops = hubspotConnector.crm!(config());
    const since = new Date("2026-07-01T00:00:00Z");
    const pull = await ops.pullLeads(since);
    expect(pull.ok).toBe(true);
    expect(pull.records).toHaveLength(2);

    const [withContact, noContact] = pull.records;
    expect(withContact).toMatchObject({
      provider: "HUBSPOT",
      externalId: "9001",
      title: "Water heater replacement",
      contactName: "Dana Whitfield",
      email: "dana.w@example.com",
      phone: "555-0161",
      expectedRevenueCents: 285000, // "2850.00" → cents
      stage: "appointmentscheduled",
    });
    // Deal without an associated contact falls back to the deal name.
    expect(noContact.contactName).toBe("Backflow testing x3");
    expect(noContact.expectedRevenueCents).toBeUndefined();

    // The search filter used the epoch-millis GTE contract.
    const search = hsCaptured.dealSearch as { filterGroups: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }> };
    expect(search.filterGroups[0].filters[0]).toMatchObject({
      propertyName: "hs_lastmodifieddate",
      operator: "GTE",
      value: String(since.getTime()),
    });
  });

  it("upsertContact dedupes by email: PATCHes known, POSTs unknown", async () => {
    const ops = hubspotConnector.crm!(config());
    const updated = await ops.upsertContact({ name: "Known Person", email: "known@example.com" });
    expect(updated).toMatchObject({ ok: true, externalId: "777" });
    expect((hsCaptured.contactPatch as { properties: { firstname: string } }).properties.firstname).toBe("Known");

    const created = await ops.upsertContact({ name: "New Person", email: "new@example.com", phone: "555-9" });
    expect(created).toMatchObject({ ok: true, externalId: "801" });
    expect((hsCaptured.contactCreate as { properties: { lastname: string } }).properties.lastname).toBe("Person");
  });

  it("pushActivity posts a note associated to the deal (type 214)", async () => {
    const ops = hubspotConnector.crm!(config());
    const r = await ops.pushActivity({ kind: "note", body: "Called the customer", subject: "Follow-up", relatedExternalId: "9001" });
    expect(r).toMatchObject({ ok: true, externalId: "n-4401" });
    const note = hsCaptured.noteCreate as { associations: Array<{ to: { id: string }; types: Array<{ associationTypeId: number }> }> };
    expect(note.associations[0].to.id).toBe("9001");
    expect(note.associations[0].types[0].associationTypeId).toBe(214);
  });

  it("unconfigured ops fail loudly without throwing", async () => {
    const ops = hubspotConnector.crm!({});
    const pull = await ops.pullLeads();
    expect(pull.ok).toBe(false);
    expect(pull.message).toContain("not configured");
  });
});

// ── QuickBooks ───────────────────────────────────────────────────────────────

describe("QuickBooks live connector", () => {
  const config = () => ({ realmId: REALM, apiKey: QB_TOKEN, baseUrl: qbBase });

  it("health reads companyinfo for the realm", async () => {
    const h = await quickbooksConnector.health(config());
    expect(h.ok).toBe(true);
    expect(h.message).toContain("Apex Test Co");
  });

  it("health degrades LOUDLY on 401 with the vendor Fault message", async () => {
    const h = await quickbooksConnector.health({ realmId: REALM, apiKey: "expired", baseUrl: qbBase });
    expect(h.ok).toBe(false);
    expect(h.degraded).toBe(true);
    expect(h.message).toContain("401");
  });

  it("pushInvoice reuses an existing customer and converts cents → decimal", async () => {
    const ops = quickbooksConnector.accounting!(config());
    const r = await ops.pushInvoice({
      number: "INV-2007",
      customerName: "Known Corp",
      totalCents: 123456,
      issuedAt: "2026-07-17",
      memo: "Sewer line repair",
    });
    expect(r).toMatchObject({ ok: true, externalId: "90" });
    const inv = qbCaptured.invoiceCreate as { CustomerRef: { value: string }; Line: Array<{ Amount: number }>; DocNumber: string };
    expect(inv.CustomerRef.value).toBe("12"); // found, not created
    expect(inv.Line[0].Amount).toBe(1234.56);
    expect(inv.DocNumber).toBe("INV-2007");
  });

  it("pushInvoice creates the customer when absent", async () => {
    const ops = quickbooksConnector.accounting!(config());
    const r = await ops.pushInvoice({ number: "INV-2008", customerName: "Brand New LLC", totalCents: 50000 });
    expect(r.ok).toBe(true);
    expect((qbCaptured.customerCreate as { DisplayName: string }).DisplayName).toBe("Brand New LLC");
    expect((qbCaptured.invoiceCreate as { CustomerRef: { value: string } }).CustomerRef.value).toBe("55");
  });

  it("pushPayment resolves the invoice by DocNumber and links the txn", async () => {
    const ops = quickbooksConnector.accounting!(config());
    const r = await ops.pushPayment({ invoiceNumber: "INV-1001", amountCents: 45000, method: "card", receivedAt: "2026-07-17T15:00:00Z" });
    expect(r).toMatchObject({ ok: true, externalId: "70" });
    const pay = qbCaptured.paymentCreate as { TotalAmt: number; CustomerRef: { value: string }; Line: Array<{ LinkedTxn: Array<{ TxnId: string; TxnType: string }> }> };
    expect(pay.TotalAmt).toBe(450);
    expect(pay.CustomerRef.value).toBe("12");
    expect(pay.Line[0].LinkedTxn[0]).toMatchObject({ TxnId: "33", TxnType: "Invoice" });
  });

  it("pushPayment degrades when the invoice is unknown", async () => {
    const ops = quickbooksConnector.accounting!(config());
    const r = await ops.pushPayment({ invoiceNumber: "INV-NOPE", amountCents: 100 });
    expect(r.ok).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.message).toContain("not found");
  });
});
