import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { renderTemplate, isAutoSendKind, normalizePhone } from "../comms/templates";
import { twilioConnector } from "../connectors/twilio";

/** Mock Twilio Messages API (2010-04-01 shapes, basic auth). */
const SID = "AC00000000000000000000000000000042";
const TOKEN = "twilio-good-token";
const captured: Array<Record<string, string>> = [];

const server = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const auth = req.headers.authorization ?? "";
  const expected = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");
  if (auth !== expected) return send(401, { code: 20003, message: "Authentication Error" });

  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === `/2010-04-01/Accounts/${SID}.json`) {
    return send(200, { sid: SID, friendly_name: "Plumb Zebra Test" });
  }
  if (req.method === "POST" && url.pathname === `/2010-04-01/Accounts/${SID}/Messages.json`) {
    let body = "";
    for await (const c of req) body += c;
    const params = Object.fromEntries(new URLSearchParams(body));
    captured.push(params);
    if (params.To === "+15550000000") {
      return send(400, { code: 21211, message: "The 'To' number is not a valid phone number." });
    }
    return send(201, { sid: `SM${captured.length.toString().padStart(6, "0")}`, status: "queued" });
  }
  send(404, { message: "not found" });
});

let base = "";
beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") base = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    })
);
afterAll(() => server.close());

const config = () => ({ accountSid: SID, apiKey: TOKEN, fromNumber: "+15550199", baseUrl: base });

describe("Twilio live connector", () => {
  it("health authenticates with basic auth and reads the account", async () => {
    const h = await twilioConnector.health(config());
    expect(h.ok).toBe(true);
    expect(h.message).toContain("Plumb Zebra Test");
  });

  it("health degrades LOUDLY on bad credentials (401)", async () => {
    const h = await twilioConnector.health({ ...config(), apiKey: "wrong" });
    expect(h.ok).toBe(false);
    expect(h.degraded).toBe(true);
    expect(h.message).toContain("401");
  });

  it("sendSms posts To/From/Body form-encoded and returns the message SID", async () => {
    const r = await twilioConnector.messaging!(config()).sendSms("+15095550142", "Test body");
    expect(r.ok).toBe(true);
    expect(r.externalId).toMatch(/^SM/);
    const last = captured[captured.length - 1];
    expect(last).toMatchObject({ To: "+15095550142", From: "+15550199", Body: "Test body" });
  });

  it("sendSms surfaces the Twilio error message on failure", async () => {
    const r = await twilioConnector.messaging!(config()).sendSms("+15550000000", "x");
    expect(r.ok).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.message).toContain("not a valid phone number");
  });

  it("sendEmail fails loudly — SMS-only connector", async () => {
    const r = await twilioConnector.messaging!(config()).sendEmail("a@b.c", "s", "b");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("SMS-only");
  });

  it("unconfigured ops fail loudly without throwing", async () => {
    const r = await twilioConnector.messaging!({}).sendSms("+15095550142", "x");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("not configured");
  });
});

describe("transactional templates + policy", () => {
  it("renders the three templated kinds with STOP notice and no free text", () => {
    const p = { companyName: "Plumb Zebra", customerFirstName: "Tom Boyd", techName: "Jake", jobType: "Leak Repair", when: "Jul 19, 9:00 AM", address: "9 Quarry Rd" };
    const omw = renderTemplate("ON_MY_WAY", p);
    expect(omw).toContain("this is Plumb Zebra");
    expect(omw).toContain("Jake is on the way");
    expect(omw).toContain("Reply STOP");
    expect(renderTemplate("BOOKING_CONFIRMATION", p)).toContain("You're booked: Leak Repair on Jul 19, 9:00 AM");
    expect(renderTemplate("REMINDER", p)).toContain("Reminder: your Leak Repair appointment");
    // Greets by FIRST name only.
    expect(omw).toContain("Hi Tom,");
  });

  it("only templated kinds may auto-send — free text stays gated", () => {
    expect(isAutoSendKind("ON_MY_WAY")).toBe(true);
    expect(isAutoSendKind("BOOKING_CONFIRMATION")).toBe(true);
    expect(isAutoSendKind("REMINDER")).toBe(true);
    expect(isAutoSendKind("CUSTOMER_MESSAGE")).toBe(false);
    expect(isAutoSendKind("ESTIMATE_SEND")).toBe(false);
  });

  it("normalizePhone: US 10/11-digit → E.164; demo short numbers unroutable", () => {
    expect(normalizePhone("(509) 555-0142")).toBe("+15095550142");
    expect(normalizePhone("15095550142")).toBe("+15095550142");
    expect(normalizePhone("+447911123456")).toBe("+447911123456");
    expect(normalizePhone("555-0100")).toBeNull(); // seed-style fake
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});
