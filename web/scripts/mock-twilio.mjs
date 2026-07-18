/**
 * Mock Twilio Messages API for e2e verification (dev/test only).
 * Implements: GET account (health), POST Messages.json (send). Records every
 * message; GET /__messages returns them for assertions.
 * Env: PORT (default 8904), SID, TOKEN
 */
import http from "node:http";

const PORT = Number(process.env.PORT || 8904);
const SID = process.env.SID || "AC00000000000000000000000000000042";
const TOKEN = process.env.TOKEN || "twilio-e2e-token";
const messages = [];

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/__messages") return send(200, messages);

  const expected = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");
  if ((req.headers.authorization ?? "") !== expected) {
    return send(401, { code: 20003, message: "Authentication Error" });
  }

  if (req.method === "GET" && url.pathname === `/2010-04-01/Accounts/${SID}.json`) {
    return send(200, { sid: SID, friendly_name: "Plumb Zebra (mock)" });
  }
  if (req.method === "POST" && url.pathname === `/2010-04-01/Accounts/${SID}/Messages.json`) {
    let body = "";
    for await (const c of req) body += c;
    const p = Object.fromEntries(new URLSearchParams(body));
    const sid = `SM${String(messages.length + 1).padStart(6, "0")}`;
    messages.push({ sid, to: p.To, from: p.From, body: p.Body, at: new Date().toISOString() });
    return send(201, { sid, status: "queued" });
  }
  send(404, { message: "not found" });
});

server.listen(PORT, () => console.log(`mock-twilio on http://localhost:${PORT} (sid ${SID})`));
