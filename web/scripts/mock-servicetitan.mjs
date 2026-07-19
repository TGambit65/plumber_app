/* Mock ServiceTitan v2 API for e2e (vendor-shaped: OAuth2 client-credentials
   at /connect/token, ST-App-Key header enforced, tenant-scoped jpm/crm paths).
   One server plays both auth + api hosts — the connector's baseUrl/tokenUrl
   overrides both point here. */
import http from "node:http";
const PORT = Number(process.env.PORT || 8908);
const CLIENT_ID = "cid.e2e";
const CLIENT_SECRET = "cs1.e2e-secret";
const APP_KEY = "ak1.e2e-app-key";
const TENANT = "543210987";

const stJobs = [
  { id: 88213, jobNumber: "88213", summary: "No-heat call — rooftop unit 4", jobStatus: "Dispatched", customerId: 301, locationId: 401, start: "2026-07-20T15:30:00Z", end: "2026-07-20T17:30:00Z" },
  { id: 88214, jobNumber: "88214", summary: "Water softener install", jobStatus: "Scheduled", customerId: 302, locationId: 402, start: "2026-07-23T16:00:00Z", end: "2026-07-23T19:00:00Z" },
];
const stCustomers = [
  { id: 301, name: "Grandview Plaza", email: "facilities@grandview.example.com", phoneNumber: "509-555-0107" },
  { id: 302, name: "T. Alvarez", email: null, phoneNumber: "509-555-0188" },
];
const stLocations = [
  { id: 401, address: { street: "400 Grandview Ave", city: "Spokane", state: "WA", zip: "99201" } },
  { id: 402, address: { street: "9 Larchwood Dr", city: "Spokane Valley", state: "WA", zip: "99206" } },
];

const server = http.createServer(async (req, res) => {
  const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = ""; for await (const c of req) body += c;

  if (req.method === "POST" && url.pathname === "/connect/token") {
    const p = new URLSearchParams(body);
    if (p.get("grant_type") !== "client_credentials" || p.get("client_id") !== CLIENT_ID || p.get("client_secret") !== CLIENT_SECRET) {
      return send(400, { error: "invalid_client" });
    }
    return send(200, { access_token: "st-e2e-access", expires_in: 900, token_type: "Bearer" });
  }

  if ((req.headers.authorization ?? "") !== "Bearer st-e2e-access") return send(401, { title: "Unauthorized" });
  if ((req.headers["st-app-key"] ?? "") !== APP_KEY) return send(401, { title: "Missing ST-App-Key" });

  const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).map(Number);
  const byIds = (rows) => (ids.length ? rows.filter((r) => ids.includes(r.id)) : rows);
  if (url.pathname === `/jpm/v2/tenant/${TENANT}/jobs`) return send(200, { data: stJobs });
  if (url.pathname === `/crm/v2/tenant/${TENANT}/customers`) return send(200, { data: byIds(stCustomers) });
  if (url.pathname === `/crm/v2/tenant/${TENANT}/locations`) return send(200, { data: byIds(stLocations) });
  send(404, { title: `no route ${req.method} ${url.pathname}` });
});
server.listen(PORT, () => console.log(`mock-servicetitan on http://localhost:${PORT}`));
