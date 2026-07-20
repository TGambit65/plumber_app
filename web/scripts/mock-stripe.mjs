/**
 * Mock Stripe API for e2e verification (dev/test only).
 * Implements: GET /v1/balance (health), POST /v1/checkout/sessions (returns a
 * hosted-checkout URL pointing back at this mock), GET /checkout/{id} (a tiny
 * "hosted page"), POST /__complete/{id} (test hook: fires the signed
 * checkout.session.completed webhook at WEBHOOK_URL). GET /__sessions lists
 * sessions for assertions.
 * Env: PORT (default 8910), KEY, WEBHOOK_SECRET, WEBHOOK_URL
 */
import http from "node:http";
import { createHmac } from "node:crypto";

const PORT = Number(process.env.PORT || 8910);
const KEY = process.env.KEY || "sk_test_e2e";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "whsec_e2e";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://localhost:3000/api/webhooks/stripe/plumb-zebra";
const sessions = new Map();

async function fireWebhook(session) {
  const payload = JSON.stringify({
    id: `evt_${session.id}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: session.id,
        client_reference_id: session.client_reference_id,
        amount_total: session.amount_total,
        payment_intent: session.payment_intent,
        payment_status: "paid",
      },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
    body: payload,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/__sessions") return send(200, [...sessions.values()]);

  // Test hook: complete a session → fire the signed webhook.
  if (req.method === "POST" && url.pathname.startsWith("/__complete/")) {
    const s = sessions.get(url.pathname.split("/")[2]);
    if (!s) return send(404, { error: "no such session" });
    s.status = "complete";
    const hook = await fireWebhook(s);
    return send(200, { ok: true, webhook: hook });
  }

  // "Hosted checkout page" (just enough to prove the redirect worked).
  if (req.method === "GET" && url.pathname.startsWith("/checkout/")) {
    const s = sessions.get(url.pathname.split("/")[2]);
    if (!s) return send(404, "not found", "text/plain");
    return send(200, `<html><body><h1>Mock Stripe Checkout</h1><p>${s.description} — $${(s.amount_total / 100).toFixed(2)}</p></body></html>`, "text/html");
  }

  if ((req.headers.authorization ?? "") !== `Bearer ${KEY}`) {
    return send(401, { error: { message: "Invalid API Key provided" } });
  }

  if (req.method === "GET" && url.pathname === "/v1/balance") {
    return send(200, { object: "balance", livemode: false, available: [{ amount: 0, currency: "usd" }] });
  }
  if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
    let body = "";
    for await (const c of req) body += c;
    const p = Object.fromEntries(new URLSearchParams(body));
    const id = `cs_test_${String(sessions.size + 1).padStart(6, "0")}`;
    const session = {
      id,
      object: "checkout.session",
      status: "open",
      url: `http://localhost:${PORT}/checkout/${id}`,
      client_reference_id: p.client_reference_id ?? null,
      amount_total: Number(p["line_items[0][price_data][unit_amount]"] ?? 0),
      description: p["line_items[0][price_data][product_data][name]"] ?? "",
      payment_intent: `pi_${id}`,
      success_url: p.success_url,
      cancel_url: p.cancel_url,
      customer_email: p.customer_email ?? null,
      at: new Date().toISOString(),
    };
    sessions.set(id, session);
    return send(200, session);
  }
  send(404, { error: { message: "not found" } });
});

server.listen(PORT, () => console.log(`mock-stripe on http://localhost:${PORT} → webhook ${WEBHOOK_URL}`));
