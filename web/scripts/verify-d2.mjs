/* E2E: Phase D2 — ICS feeds + Google Calendar push + busy-window conflicts. */
import { chromium } from "playwright";
import { Pool } from "pg";

const BASE = "http://localhost:3000";
const GCAL = "http://localhost:8905";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let failures = 0;
const check = (l, ok) => { console.log(`${ok ? "✅" : "❌"} ${l}`); if (!ok) failures++; };
const gcalEvents = async () => (await fetch(`${GCAL}/__events`)).json();

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

const ctx = await browser.newContext();
const page = await ctx.newPage();
await login(page, "owner@plumbzebra.demo");

// ── 1. ICS feeds: create org + tech feed via settings, fetch, revoke ─────────
{
  await page.goto(`${BASE}/settings?tab=integrations`);
  await page.click('button:has-text("Whole-schedule feed")');
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);

  const feedForm = page.locator('form:has(select[name="userId"])');
  await feedForm.locator('select[name="userId"]').selectOption({ index: 1 }); // first tech (Jake)
  await feedForm.locator('button:has-text("Create")').click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);

  const feeds = await pz(`SELECT token, scope FROM calendar_feeds WHERE revoked_at IS NULL ORDER BY created_at`);
  check(`two feeds created via UI (${feeds.map((f) => f.scope).join(",")})`, feeds.length === 2 && feeds.some((f) => f.scope === "ORG") && feeds.some((f) => f.scope === "TECH"));

  const orgFeed = feeds.find((f) => f.scope === "ORG");
  const techFeed = feeds.find((f) => f.scope === "TECH");

  // Fetch WITHOUT any session — the token is the capability.
  const res = await fetch(`${BASE}/api/calendar/${orgFeed.token}`);
  const ics = await res.text();
  check(`org feed serves ICS with no auth (${res.status}, ${res.headers.get("content-type")})`, res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/calendar"));
  check("feed is a valid VCALENDAR with job VEVENTs", ics.startsWith("BEGIN:VCALENDAR") && ics.includes("BEGIN:VEVENT") && /J-\d{4}/.test(ics));
  check("events carry location + status description", ics.includes("LOCATION:") && ics.includes("Status:"));

  const techIcs = await (await fetch(`${BASE}/api/calendar/${techFeed.token}`)).text();
  const orgCount = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
  const techCount = (techIcs.match(/BEGIN:VEVENT/g) ?? []).length;
  check(`tech feed is a subset of the org feed (${techCount} ≤ ${orgCount})`, techCount > 0 && techCount <= orgCount);

  // Revoke the org feed in the UI → URL dies immediately.
  await page.goto(`${BASE}/settings?tab=integrations`);
  await page.locator(`li:has-text("${orgFeed.token.slice(0, 12)}") button:has-text("Revoke")`).first().click().catch(async () => {
    await page.locator('li:has-text("Whole schedule") button:has-text("Revoke")').first().click();
  });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
  const revoked = await fetch(`${BASE}/api/calendar/${orgFeed.token}`);
  check(`revoked feed 404s immediately (${revoked.status})`, revoked.status === 404);
}

// ── 2. Google Calendar push on assign ────────────────────────────────────────
{
  const before = (await gcalEvents()).length;
  await page.goto(`${BASE}/dispatch`);

  // Assign the first unassigned job to a tech at 16:00 today.
  const assignForm = page.locator('form:has(select[name="techId"]):has(input[name="scheduledAt"])').first();
  const hasUnassigned = (await assignForm.count()) > 0;
  check("dispatch board has an unassigned job to assign", hasUnassigned);
  if (hasUnassigned) {
    const today = new Date();
    const dt = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}T16:00`;
    await assignForm.locator('select[name="techId"]').selectOption({ index: 1 });
    await assignForm.locator('input[name="scheduledAt"]').fill(dt);
    await assignForm.locator('button:has-text("Assign")').click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1200);

    const after = await gcalEvents();
    const created = after.slice(before).find((e) => /J-\d{4}/.test(e.summary ?? ""));
    check(`assignment pushed a REAL event to Google Calendar (${created?.summary?.slice(0, 40) ?? "none"})`, Boolean(created));
    check("event carries location + start/end", Boolean(created?.location && created?.start?.dateTime && created?.end?.dateTime));
    const [job] = await pz(`SELECT number, calendar_event_id FROM jobs WHERE calendar_event_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`);
    check(`job stores the calendar event id (${job?.number} → ${job?.calendar_event_id})`, /^gev-/.test(job?.calendar_event_id ?? ""));
  }
}

// ── 3. Busy windows + soft conflicts on the board ────────────────────────────
{
  await page.goto(`${BASE}/dispatch`);
  await page.waitForLoadState("networkidle");
  const body = await page.textContent("body");
  check("board shows the Google Calendar busy-window strip", body.includes("Google Calendar busy windows"));
  check("board flags overlapping jobs as soft conflicts", body.includes("job(s) overlap") && body.includes("Overlaps a calendar busy window"));
}

await ctx.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL D2 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
