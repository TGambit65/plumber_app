/* Mock Jobber GraphQL API for e2e (vendor-shaped: /api/graphql envelope,
   bearer auth, X-JOBBER-GRAPHQL-VERSION enforced). Stateful: PATCH /__jobs/:n
   mutates a job so webhook-triggered refetches see the change. */
import http from "node:http";
const PORT = Number(process.env.PORT || 8907);
const TOKEN = "jobber-e2e-token";

const jobs = new Map([
  ["5501", {
    id: "gid://Jobber/Job/5501", jobNumber: 5501,
    title: "Annual boiler service — Hartley residence", jobStatus: "upcoming",
    instructions: "Gate code 4411. Dog in yard.",
    startAt: "2026-07-21T13:00:00Z", endAt: "2026-07-21T15:00:00Z",
    client: { name: "J. Hartley", emails: [{ address: "j.hartley@example.com" }], phones: [{ number: "509-555-0142" }] },
    property: { address: { street: "18 Birchwood Ln", city: "Spokane", province: "WA", postalCode: "99203" } },
  }],
  ["5502", {
    id: "gid://Jobber/Job/5502", jobNumber: 5502,
    title: "Sump pump replacement", jobStatus: "scheduled",
    instructions: null,
    startAt: "2026-07-22T16:00:00Z", endAt: "2026-07-22T18:00:00Z",
    client: { name: "Rosa Delgado", emails: [], phones: [{ number: "509-555-0175" }] },
    property: { address: { street: "902 Cannon Hill Blvd", city: "Spokane", province: "WA", postalCode: "99204" } },
  }],
  ["5503", {
    id: "gid://Jobber/Job/5503", jobNumber: 5503,
    title: "Hose bib repair — leave invoice in mailbox", jobStatus: "archived",
    instructions: "Customer travels; no need to be home.",
    startAt: "2026-07-10T15:00:00Z", endAt: "2026-07-10T16:00:00Z",
    client: { name: "Wes Chandler", emails: [{ address: "wes.c@example.com" }], phones: [] },
    property: { address: { street: "5610 Regal St, Spokane, WA 99223" } }, // single-line: exercises splitAddress
  }],
]);

const server = http.createServer(async (req, res) => {
  const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = ""; for await (const c of req) body += c;

  // Test control: mutate a job in place (reschedule/status) for webhook tests.
  if (req.method === "PATCH" && url.pathname.startsWith("/__jobs/")) {
    const n = url.pathname.split("/").pop();
    const job = jobs.get(n);
    if (!job) return send(404, { error: "no such job" });
    Object.assign(job, JSON.parse(body));
    return send(200, job);
  }

  if (req.method !== "POST" || url.pathname !== "/api/graphql") return send(404, { message: "not found" });
  if ((req.headers.authorization ?? "") !== `Bearer ${TOKEN}`) return send(401, { message: "bad token" });
  if (!req.headers["x-jobber-graphql-version"]) {
    return send(200, { errors: [{ message: "X-JOBBER-GRAPHQL-VERSION header is required" }] });
  }

  const { query, variables } = JSON.parse(body);
  if (query.includes("account")) return send(200, { data: { account: { name: "Plumb Zebra (Jobber sandbox)" } } });
  if (query.includes("job(id:")) {
    // Webhook fetch-by-id: accept the gid or the bare number.
    const id = String(variables?.id ?? "");
    const n = id.replace(/\D/g, "").slice(-4);
    const job = jobs.get(n) ?? null;
    return send(200, { data: { job } });
  }
  if (query.includes("jobs")) return send(200, { data: { jobs: { nodes: [...jobs.values()] } } });
  return send(200, { errors: [{ message: `unhandled query` }] });
});
server.listen(PORT, () => console.log(`mock-jobber on http://localhost:${PORT}`));
