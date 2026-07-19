/* E2E: Phase D5 — FSM coexistence: live Jobber + ServiceTitan import,
   provenance dedupe, webhook (valid + forged HMAC), descriptor-driven badges.
   Requires: next on :3000, mock-jobber on :8907, mock-servicetitan on :8908. */
import { chromium } from "playwright";
import { Pool } from "pg";
import { createHmac } from "node:crypto";

const BASE = "http://localhost:3000";
const JOBBER = "http://localhost:8907";
const JOBBER_TOKEN = "jobber-e2e-token";
const JOBBER_SECRET = "jobber-e2e-webhook-secret";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let failures = 0;
const check = (l, ok) => { console.log(`${ok ? "✅" : "❌"} ${l}`); if (!ok) failures++; };

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function pz(q) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_org',(SELECT id FROM organizations WHERE slug='plumb-zebra'),true)");
    const r = await c.query(q);
    await c.query("COMMIT");
    return r.rows;
  } finally { c.release(); }
}

// ── Reset from prior runs ────────────────────────────────────────────────────
await pz(`DELETE FROM jobs WHERE external_ref IS NOT NULL`);
await pz(`DELETE FROM properties WHERE customer_id IN (SELECT id FROM customers WHERE notes LIKE 'Imported from %')`);
await pz(`DELETE FROM customers WHERE notes LIKE 'Imported from %'`);
await pz(`DELETE FROM integration_connections WHERE provider IN ('JOBBER','SERVICETITAN')`);

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
}

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await login(page, "owner@plumbzebra.demo");

const card = (provider) => page.locator(`div.rounded-xl:has(input[name="provider"][value="${provider}"])`).first();

// ── 1. Descriptor-driven badges ──────────────────────────────────────────────
{
  await page.goto(`${BASE}/settings?tab=integrations`, { waitUntil: "networkidle" });
  check("Jobber card shows the Live API badge", (await card("JOBBER").textContent()).includes("Live API"));
  check("ServiceTitan card shows the Live API badge", (await card("SERVICETITAN").textContent()).includes("Live API"));
  check("Housecall Pro (stub) still shows Demo stub", (await card("HOUSECALL_PRO").textContent()).includes("Demo stub"));
}

// ── 2. Configure Jobber via the UI → real health() against mock GraphQL ─────
{
  const c = card("JOBBER");
  await c.locator("summary").click();
  await c.locator('input[name="apiKey"]').fill(JOBBER_TOKEN);
  await c.locator('input[name="clientSecret"]').fill(JOBBER_SECRET);
  await c.locator('input[name="baseUrl"]').fill(JOBBER);
  await c.locator('button:has-text("Save & connect")').click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);

  const [conn] = await pz(`SELECT status, config FROM integration_connections WHERE provider='JOBBER'`);
  check(`Jobber connects via GraphQL health check (${conn?.status})`, conn?.status === "CONNECTED");
  check("stored secrets are encrypted at rest (enc:v1:)", String(conn?.config?.apiKey ?? "").startsWith("enc:v1:") && String(conn?.config?.clientSecret ?? "").startsWith("enc:v1:"));
  check("card reports the connected Jobber account", (await card("JOBBER").textContent()).includes("Connected"));
}

// ── 3. Import jobs → provenance, mapping, unassigned ─────────────────────────
{
  await card("JOBBER").locator('button:has-text("Import jobs")').click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  const jobs = await pz(`SELECT number, status, external_ref, assigned_to_id, scheduled_at, description FROM jobs WHERE external_ref LIKE 'JOBBER:%' ORDER BY number`);
  check(`import created 3 Jobber jobs with JB- numbers (${jobs.map((j) => j.number).join(",")})`, jobs.length === 3 && jobs.every((j) => j.number.startsWith("JB-")));
  check("provenance refs stored (JOBBER:5501…)", jobs.every((j) => /^JOBBER:\d+$/.test(j.external_ref)));
  check("imported jobs arrive UNASSIGNED (crew stays a local decision)", jobs.every((j) => j.assigned_to_id === null));
  const s5501 = jobs.find((j) => j.number === "JB-5501");
  const s5503 = jobs.find((j) => j.number === "JB-5503");
  check(`statuses mapped (upcoming→SCHEDULED, archived→COMPLETED)`, s5501?.status === "SCHEDULED" && s5503?.status === "COMPLETED");
  check("Jobber instructions land in the description", (s5501?.description ?? "").includes("Gate code 4411"));

  const custs = await pz(`SELECT name, phone FROM customers WHERE notes LIKE 'Imported from JOBBER'`);
  check(`customers created from Jobber clients (${custs.length})`, custs.length === 3 && custs.some((c) => c.name === "J. Hartley" && c.phone === "509-555-0142"));

  const [prop] = await pz(`SELECT p.address, p.city, p.state, p.zip FROM properties p JOIN jobs j ON j.property_id=p.id WHERE j.number='JB-5503'`);
  check(`single-line address split into parts (${prop?.address} / ${prop?.city} ${prop?.state} ${prop?.zip})`,
    prop?.address === "5610 Regal St" && prop?.city === "Spokane" && prop?.state === "WA" && prop?.zip === "99223");
}

// ── 4. Re-import dedupes by external_ref ─────────────────────────────────────
{
  await card("JOBBER").locator('button:has-text("Import jobs")').click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  const [{ n: jobCount }] = await pz(`SELECT count(*)::int AS n FROM jobs WHERE external_ref LIKE 'JOBBER:%'`);
  const [{ n: custCount }] = await pz(`SELECT count(*)::int AS n FROM customers WHERE notes LIKE 'Imported from JOBBER'`);
  check(`re-import creates NO duplicates (jobs=${jobCount}, customers=${custCount})`, jobCount === 3 && custCount === 3);
}

// ── 5. Webhook: reschedule in Jobber lands locally; forged HMAC rejected ─────
{
  // Mutate the job inside "Jobber" (mock): dispatcher there moved it + started work.
  await fetch(`${JOBBER}/__jobs/5501`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobStatus: "in_progress", startAt: "2026-07-21T17:00:00Z", endAt: "2026-07-21T19:00:00Z" }),
  });

  const payload = JSON.stringify({ data: { webHookEvent: { topic: "JOB_UPDATE", itemId: "gid://Jobber/Job/5501", occurredAt: new Date().toISOString() } } });
  const sig = createHmac("sha256", JOBBER_SECRET).update(payload, "utf8").digest("base64");

  const ok = await fetch(`${BASE}/api/webhooks/jobber/plumb-zebra`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jobber-hmac-sha256": sig },
    body: payload,
  });
  const okJson = await ok.json();
  check(`valid-HMAC webhook accepted (${ok.status}, updated=${okJson.updated})`, ok.status === 200 && okJson.updated === 1);

  const [job] = await pz(`SELECT status, scheduled_at FROM jobs WHERE number='JB-5501'`);
  check(`Jobber reschedule + status change landed locally (${job?.status})`, job?.status === "IN_PROGRESS" && new Date(job?.scheduled_at).toISOString() === "2026-07-21T17:00:00.000Z");

  const forged = await fetch(`${BASE}/api/webhooks/jobber/plumb-zebra`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jobber-hmac-sha256": createHmac("sha256", "wrong-secret").update(payload).digest("base64") },
    body: payload,
  });
  check(`forged HMAC rejected (${forged.status})`, forged.status === 403);
  const missing = await fetch(`${BASE}/api/webhooks/jobber/plumb-zebra`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
  check(`missing signature rejected — fail closed (${missing.status})`, missing.status === 403);
  const badOrg = await fetch(`${BASE}/api/webhooks/jobber/not-a-tenant`, { method: "POST", headers: { "x-jobber-hmac-sha256": sig }, body: payload });
  check(`unknown org 404s (${badOrg.status})`, badOrg.status === 404);
}

// ── 6. ServiceTitan: OAuth2 handshake + tenant-scoped import ─────────────────
{
  await page.goto(`${BASE}/settings?tab=integrations`, { waitUntil: "networkidle" });
  const c = card("SERVICETITAN");
  await c.locator("summary").click();
  await c.locator('input[name="clientId"]').fill("cid.e2e");
  await c.locator('input[name="clientSecret"]').fill("cs1.e2e-secret");
  await c.locator('input[name="appKey"]').fill("ak1.e2e-app-key");
  await c.locator('input[name="tenantId"]').fill("543210987");
  await c.locator('input[name="baseUrl"]').fill("http://localhost:8908");
  await c.locator('input[name="tokenUrl"]').fill("http://localhost:8908");
  await c.locator('button:has-text("Save & connect")').click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);

  const [conn] = await pz(`SELECT status FROM integration_connections WHERE provider='SERVICETITAN'`);
  check(`ServiceTitan connects (client-credentials + ST-App-Key) (${conn?.status})`, conn?.status === "CONNECTED");

  await card("SERVICETITAN").locator('button:has-text("Import jobs")').click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  const jobs = await pz(`SELECT number, status, external_ref FROM jobs WHERE external_ref LIKE 'SERVICETITAN:%' ORDER BY number`);
  check(`ServiceTitan import created ST- jobs (${jobs.map((j) => j.number).join(",")})`, jobs.length === 2 && jobs.every((j) => j.number.startsWith("ST-")));
  check("ST statuses mapped (Dispatched→DISPATCHED, Scheduled→SCHEDULED)", jobs.find((j) => j.number === "ST-88213")?.status === "DISPATCHED" && jobs.find((j) => j.number === "ST-88214")?.status === "SCHEDULED");
  const [prop] = await pz(`SELECT p.address, p.city FROM properties p JOIN jobs j ON j.property_id=p.id WHERE j.number='ST-88213'`);
  check(`ST location joined into a structured property (${prop?.address}, ${prop?.city})`, prop?.address === "400 Grandview Ave" && prop?.city === "Spokane");
}

// ── 7. Imported jobs sit next to local ones in the app ───────────────────────
{
  await page.goto(`${BASE}/jobs`, { waitUntil: "networkidle" });
  const body = await page.textContent("body");
  check("jobs list shows JB- and ST- numbers next to local J- jobs", body.includes("JB-5501") && body.includes("ST-88213") && /J-\d{4}/.test(body));
}

await ctx.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL D5 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
