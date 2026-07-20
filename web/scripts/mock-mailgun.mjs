/**
 * Mock Mailgun Messages API for e2e verification (dev/test only).
 * Implements: GET /v3/domains/{domain} (health), POST /v3/{domain}/messages
 * (send, form-encoded). Records every message; GET /__messages returns them
 * for assertions.
 * Env: PORT (default 8909), DOMAIN, KEY
 */
import http from "node:http";

const PORT = Number(process.env.PORT || 8909);
const DOMAIN = process.env.DOMAIN || "mg.plumbzebra.demo";
const KEY = process.env.KEY || "mailgun-e2e-key";
const messages = [];

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/__messages") return send(200, messages);

  const expected = "Basic " + Buffer.from(`api:${KEY}`).toString("base64");
  if ((req.headers.authorization ?? "") !== expected) {
    return send(401, { message: "Invalid private key" });
  }

  if (req.method === "GET" && url.pathname === `/v3/domains/${DOMAIN}`) {
    return send(200, { domain: { name: DOMAIN, state: "active" } });
  }
  if (req.method === "POST" && url.pathname === `/v3/${DOMAIN}/messages`) {
    let body = "";
    for await (const c of req) body += c;
    const p = Object.fromEntries(new URLSearchParams(body));
    const id = `<mock-${String(messages.length + 1).padStart(6, "0")}@${DOMAIN}>`;
    messages.push({ id, from: p.from, to: p.to, subject: p.subject, text: p.text, at: new Date().toISOString() });
    return send(200, { id, message: "Queued. Thank you." });
  }
  send(404, { message: "not found" });
});

server.listen(PORT, () => console.log(`mock-mailgun on http://localhost:${PORT} (domain ${DOMAIN})`));
