/* E2E: Phase D1 — real SMS loop (confirmation, on-my-way, reminders, STOP opt-out). */
import { chromium } from "playwright";
import { createHmac } from "node:crypto";
import { Pool } from "pg";

const BASE = "http://localhost:3000";
const TWILIO = "http://localhost:8904";
const AUTH_TOKEN = "twilio-e2e-token";
const PHONE = "+15095550142";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let failures = 0;
const check = (l, ok) => { console.log(`${ok ? "✅" : "❌"} ${l}`); if (!ok) failures++; };
const mockMessages = async () => (await fetch(`${TWILIO}/__messages`)).json();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function pz(sqlText) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_org',(SELECT id FROM organizations WHERE slug='plumb-zebra'),true)");
    const r = await c.query(sqlText);
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

// Reset state so re-runs are deterministic.
await pz(`UPDATE customers SET sms_opt_out=false WHERE phone='${PHONE}'`);
await pz(`DELETE FROM outbound_messages WHERE kind IN ('ON_MY_WAY','BOOKING_CONFIRMATION','REMINDER')`);
await pz(`UPDATE jobs SET status='DISPATCHED' WHERE status='EN_ROUTE'`);

// ── 1. Booking confirmation on assign (office) ──────────────────────────────
const office = await browser.newContext();
{
  const page = await office.newPage();
  await login(page, "office@plumbzebra.demo");
  const before = (await mockMessages()).length;

  // Book a job for Tom & Erica Boyd TOMORROW (also feeds the reminder test).
  await page.goto(`${BASE}/dispatch`);
  const [cust] = await pz(`SELECT id FROM customers WHERE name='Tom & Erica Boyd'`);
  const [prop] = await pz(`SELECT id FROM properties WHERE customer_id='${cust.id}' LIMIT 1`);
  const [tech] = await pz(`SELECT id FROM users WHERE email='tech@plumbzebra.demo'`);
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const dt = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}T10:00`;

  const bookForm = page.locator('form:has(select[name="customerId"])');
  await bookForm.locator('select[name="customerId"]').selectOption(cust.id);
  await bookForm.locator('select[name="propertyId"]').selectOption(prop.id);
  await bookForm.locator('select[name="jobType"]').selectOption({ index: 1 });
  await bookForm.locator('input[name="scheduledAt"]').fill(dt);
  await bookForm.locator('select[name="techId"]').selectOption(tech.id);
  await bookForm.locator('button:has-text("Book job")').click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200);

  const after = await mockMessages();
  const conf = after.slice(before).find((m) => m.body.includes("You're booked"));
  check("booking a scheduled job sends a REAL confirmation SMS via mock Twilio", Boolean(conf));
  check(`confirmation went to the customer's number (${conf?.to})`, conf?.to === PHONE);
  const [row] = await pz(`SELECT kind, delivery_status, external_sid FROM outbound_messages WHERE kind='BOOKING_CONFIRMATION' ORDER BY created_at DESC LIMIT 1`);
  check(`outbound_messages records SENT with Twilio SID (${row?.external_sid})`, row?.delivery_status === "SENT" && /^SM/.test(row?.external_sid ?? ""));
}

// ── 2. On-my-way on EN_ROUTE (tech, online path) ────────────────────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "tech@plumbzebra.demo");
  const before = (await mockMessages()).length;

  await page.goto(`${BASE}/my-day`);
  const omwBtn = page.locator('button:has-text("On my way")').first();
  check("tech has an 'On my way' advance available (DISPATCHED job today)", (await omwBtn.count()) > 0);
  await omwBtn.click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200);

  const after = await mockMessages();
  const omw = after.slice(before).find((m) => m.body.includes("on the way"));
  check("EN_ROUTE sends the REAL on-my-way SMS", Boolean(omw));
  check("on-my-way names the tech (Jake)", (omw?.body ?? "").includes("Jake"));
  const acts = await pz(`SELECT body FROM activities WHERE kind='SMS' ORDER BY created_at DESC LIMIT 1`);
  check(`activity log reflects truth (${(acts[0]?.body ?? "").slice(0, 40)}…)`, (acts[0]?.body ?? "").includes("On my way text sent"));
  await ctx.close();
}

// ── 3. Reminder sweep + dedupe (office) ─────────────────────────────────────
{
  const page = await office.newPage();
  await login(page, "office@plumbzebra.demo").catch(() => {});
  await page.goto(`${BASE}/dispatch`);
  const before = (await mockMessages()).length;
  await page.click('button:has-text("Send tomorrow")');
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  const afterFirst = (await mockMessages()).length;
  const reminders = (await mockMessages()).slice(before).filter((m) => m.body.includes("Reminder"));
  check(`reminder sweep texts tomorrow's booked customer (${reminders.length} reminder[s])`, reminders.length >= 1);

  await page.goto(`${BASE}/dispatch`);
  await page.click('button:has-text("Send tomorrow")');
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  const afterSecond = (await mockMessages()).length;
  check("running the sweep AGAIN sends nothing (deduped)", afterSecond === afterFirst);
}

// ── 4. STOP webhook → opt-out honored ───────────────────────────────────────
{
  const url = `${BASE}/api/sms/inbound/plumb-zebra`;
  const params = { From: PHONE, Body: "STOP" };
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const sig = createHmac("sha1", AUTH_TOKEN).update(data).digest("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    body: new URLSearchParams(params),
  });
  check(`STOP webhook accepted with valid Twilio signature (${res.status})`, res.status === 200);

  const badRes = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "forged=" },
    body: new URLSearchParams(params),
  });
  check(`forged signature rejected (${badRes.status})`, badRes.status === 403);

  const [c] = await pz(`SELECT sms_opt_out FROM customers WHERE phone='${PHONE}'`);
  check("customer flagged smsOptOut after STOP", c?.sms_opt_out === true);

  // A new confirmation for the opted-out customer must be SKIPPED, not sent.
  const before = (await mockMessages()).length;
  const page = await office.newPage();
  await login(page, "office@plumbzebra.demo").catch(() => {});
  await page.goto(`${BASE}/dispatch`);
  const [cust] = await pz(`SELECT id FROM customers WHERE phone='${PHONE}'`);
  const [prop] = await pz(`SELECT id FROM properties WHERE customer_id='${cust.id}' LIMIT 1`);
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const dt = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}T14:00`;
  const bookForm2 = page.locator('form:has(select[name="customerId"])');
  await bookForm2.locator('select[name="customerId"]').selectOption(cust.id);
  await bookForm2.locator('select[name="propertyId"]').selectOption(prop.id);
  await bookForm2.locator('select[name="jobType"]').selectOption({ index: 1 });
  await bookForm2.locator('input[name="scheduledAt"]').fill(dt);
  await bookForm2.locator('button:has-text("Book job")').click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200);
  const after = (await mockMessages()).length;
  const [skip] = await pz(`SELECT delivery_status FROM outbound_messages WHERE kind='BOOKING_CONFIRMATION' ORDER BY created_at DESC LIMIT 1`);
  check(`opted-out customer NOT texted (mock count ${before}→${after}); recorded SKIPPED_OPTOUT`, after === before && skip?.delivery_status === "SKIPPED_OPTOUT");
}

// ── 5. Delivery visibility on the job detail page ───────────────────────────
{
  const [job] = await pz(`SELECT job_id FROM outbound_messages WHERE kind='BOOKING_CONFIRMATION' AND delivery_status='SENT' LIMIT 1`);
  const page = await office.newPage();
  await login(page, "office@plumbzebra.demo").catch(() => {});
  await page.goto(`${BASE}/jobs/${job.job_id}`);
  await page.waitForLoadState("networkidle");
  const body = await page.textContent("body");
  check("job detail shows 'Customer notifications' panel with the sent text", body.includes("Customer notifications") && body.includes("You're booked"));
  check("panel shows honest delivery status (Sent badge)", /Sent/.test(body));
}

await office.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL D1 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
