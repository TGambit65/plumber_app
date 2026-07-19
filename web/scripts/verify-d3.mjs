/* E2E: Phase D3 — geography on the board (drive chips, impossible warnings, day map, routed switch, geocode hook). */
import { chromium } from "playwright";
import { Pool } from "pg";

const BASE = "http://localhost:3000";
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

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
}

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await login(page, "office@plumbzebra.demo");

// ── 1. Estimate mode (no geo connector) ─────────────────────────────────────
{
  await page.goto(`${BASE}/dispatch`, { waitUntil: "networkidle" });
  const body = await page.textContent("body");
  check("board shows drive-time chips between consecutive jobs", body.includes("min drive"));
  check("chips are labeled as ESTIMATES when no geo connector", body.includes("est."));
  check("impossible back-to-back flagged (seed: Fernwood→Quarry, 30 min gap)", body.includes("Can't make it"));
  check("day map card renders with per-tech legend", body.includes("Day map") && body.includes("Jake Sullivan"));
  const circles = await page.locator("svg[aria-label='Day map of scheduled stops'] circle").count();
  check(`day map plots stops as SVG circles (${circles})`, circles >= 4);
  check("drive-times card explains the legend + how to get routed times", body.includes("connect Google Maps"));
}

// ── 2. Routed mode (mock Google Maps connected) ─────────────────────────────
{
  await pz(`INSERT INTO integration_connections (id, organization_id, provider, status, config)
    SELECT 'gmaps-pz-1', current_setting('app.current_org'), 'GOOGLE_MAPS', 'CONNECTED',
    '{"apiKey":"gmaps-e2e-key","baseUrl":"http://localhost:8906","routesUrl":"http://localhost:8906"}'::jsonb
    ON CONFLICT (organization_id, provider) DO UPDATE SET status='CONNECTED', config=EXCLUDED.config`);

  await page.goto(`${BASE}/dispatch`, { waitUntil: "networkidle" });
  const body = await page.textContent("body");
  check("board switches to ROUTED drive times", body.includes("Routed via Google Maps"));
  check("chips show the routed 12-min hops (mock returns 720s)", body.includes("~12 min drive"));
  check("no 'est.' label in routed mode", !body.includes("min drive · est.") && !/~12 min drive[^·]*est\./.test(body));
  // With 12-min routed hops, the 30-min gap is now feasible → impossible flag clears.
  check("impossible flag clears when routing says the hop fits", !body.includes("Can't make it"));
  const stats = await (await fetch("http://localhost:8906/__stats")).json();
  check(`the board actually called the Routes API (${stats.routes} route calls)`, stats.routes > 0);
}

// ── 3. Geocode-on-create hook ───────────────────────────────────────────────
{
  const [cust] = await pz(`SELECT id FROM customers ORDER BY created_at LIMIT 1`);
  const before = await (await fetch("http://localhost:8906/__stats")).json();
  await page.goto(`${BASE}/customers/${cust.id}`, { waitUntil: "networkidle" });
  await page.click('summary:has-text("Add property")');
  const form = page.locator('form:has(input[name="address"])').last();
  await form.locator('input[name="address"]').fill("999 Geocode Test Blvd");
  await form.locator('input[name="city"]').fill("Spokane");
  await form.locator('input[name="state"]').fill("WA");
  await form.locator('input[name="zip"]').fill("99201");
  await form.locator('button:has-text("Add property")').click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  const [prop] = await pz(`SELECT lat, lng, geocoded_at FROM properties WHERE address='999 Geocode Test Blvd'`);
  const after = await (await fetch("http://localhost:8906/__stats")).json();
  check(`new property geocoded + cached (lat=${prop?.lat}, geocoder calls +${after.geocodes - before.geocodes})`,
    prop?.lat === 47.6042 && prop?.lng === -117.3925 && prop?.geocoded_at !== null && after.geocodes > before.geocodes);
}

await ctx.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL D3 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
