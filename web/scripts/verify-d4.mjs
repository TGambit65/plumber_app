/* E2E: Phase D4 — human-gated AI dispatch (suggest, dismiss, accept, optimize, nudges). */
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

const ctx = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
const page = await ctx.newPage();
await login(page, "office@plumbzebra.demo");

// ── 1. Suggestion + nudge on the board ──────────────────────────────────────
{
  // Age the unassigned J-1047 so the anomaly nudge fires.
  await pz(`UPDATE jobs SET created_at = created_at - interval '3 days' WHERE number='J-1047'`);
  await page.goto(`${BASE}/dispatch`, { waitUntil: "networkidle" });
  const body = await page.textContent("body");
  check("unassigned job shows a human-gated suggestion (✨ Suggested + reasons)", body.includes("Suggested:") && body.includes("added drive"));
  check("suggestion shows the runner-up for transparency", body.includes("next best:"));
  check("anomaly nudge flags the 48h+ unassigned job", body.includes("Worth a look") && body.includes("J-1047"));
  check("✨ Optimize appears on a tech with 3+ mapped jobs", body.includes("✨ Optimize"));
}

// ── 2. Dismiss is audited (the rejection is training signal) ────────────────
{
  await page.locator('form:has(input[name="jobId"]) button:has-text("Dismiss")').first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(700);
  const [a] = await pz(`SELECT count(*) AS n FROM audit_logs WHERE action='AI_SUGGESTION_REJECTED'`);
  check(`dismiss recorded AI_SUGGESTION_REJECTED audit (${a.n})`, Number(a.n) >= 1);
}

// ── 3. Accept runs the full assignment pipeline ─────────────────────────────
{
  await page.goto(`${BASE}/dispatch`, { waitUntil: "networkidle" });
  const suggested = await page.locator('div:has-text("Suggested:") >> nth=0').textContent().catch(() => "");
  await page.locator('form:has(input[name="whenIso"]) button:has-text("Accept")').first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  const [job] = await pz(`SELECT status, assigned_to_id, scheduled_at FROM jobs WHERE number='J-1047'`);
  check(`accepted suggestion assigned J-1047 (${job?.status}, tech set: ${Boolean(job?.assigned_to_id)})`, job?.status === "SCHEDULED" && Boolean(job?.assigned_to_id) && Boolean(job?.scheduled_at));
  const [a] = await pz(`SELECT detail FROM audit_logs WHERE action='AI_SUGGESTION_ACCEPTED' ORDER BY created_at DESC LIMIT 1`);
  check("acceptance audited with reasons (training signal)", Boolean(a) && JSON.stringify(a.detail).includes("drive"));
  const [sms] = await pz(`SELECT delivery_status FROM outbound_messages WHERE kind='BOOKING_CONFIRMATION' ORDER BY created_at DESC LIMIT 1`);
  check(`same pipeline as manual assign — confirmation SMS attempted (${sms?.delivery_status})`, Boolean(sms?.delivery_status));
  const [lane] = await pz(`SELECT count(*) AS n FROM jobs WHERE assigned_to_id IS NULL AND status NOT IN ('COMPLETED','CANCELLED')`);
  check(`unassigned lane is now empty (${lane.n})`, Number(lane.n) === 0);
}

// ── 4. Optimize-my-day: diff → apply → impossible hop cleared ───────────────
{
  await page.goto(`${BASE}/dispatch`, { waitUntil: "networkidle" });
  const before = await page.textContent("body");
  check("board currently flags an impossible back-to-back (seed)", before.includes("Can't make it"));

  await page.locator('a:has-text("✨ Optimize")').first().click();
  await page.waitForURL(/\/dispatch\/optimize/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
  const diff = await page.textContent("body");
  check("optimize page shows the before/after drive totals", diff.includes("Drive today (current)") && diff.includes("Drive (proposed)"));
  check("diff lists Current vs Proposed schedules", diff.includes("Current") && diff.includes("Proposed"));
  check("nothing applied yet (explicit Apply button present)", diff.includes("Apply this schedule"));

  await page.locator('button:has-text("Apply this schedule")').click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  const [a] = await pz(`SELECT detail FROM audit_logs WHERE action='AI_OPTIMIZE_APPLIED' ORDER BY created_at DESC LIMIT 1`);
  check("apply audited (AI_OPTIMIZE_APPLIED with summary)", Boolean(a) && JSON.stringify(a.detail).includes("optimized"));
  await page.goto(`${BASE}/dispatch`, { waitUntil: "networkidle" });
  const after = await page.textContent("body");
  check("impossible back-to-back CLEARED after applying the optimized schedule", !after.includes("Can't make it"));
  const [notif] = await pz(`SELECT count(*) AS n FROM notifications WHERE title LIKE '%route was optimized%'`);
  check(`tech notified about the retimed route (${notif.n})`, Number(notif.n) >= 1);
}

await ctx.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL D4 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
