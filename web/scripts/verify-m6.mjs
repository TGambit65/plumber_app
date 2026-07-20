/* E2E: Phase M6 — polish: pricebook detail editing + CSV round-trip,
   dashboard range/export/drill-through, earnings dispute, bulk operations,
   KB unpublished view.
   Requires: next on :3000 (fresh build), seeded Plumb Zebra tenant. */
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
const audits = async (action) => pz(`SELECT * FROM audit_logs WHERE action='${action}' ORDER BY created_at DESC LIMIT 5`);

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
}
const settle = async (page, ms = 900) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(ms); };

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();
await login(page, "owner@plumbzebra.demo");

// ═══ PRICE BOOK ══════════════════════════════════════════════════════════════
{
  const [item] = await pz(`SELECT id, code, name FROM price_book_items WHERE active LIMIT 1`);
  await page.goto(`${BASE}/pricebook`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  // Detail edit — name/category finally editable.
  const details = page.locator(`details:has(form:has(input[name="id"][value="${item.id}"]):has(input[name="name"]))`).first();
  await details.locator("summary").click();
  await page.waitForTimeout(300);
  await details.locator('input[name="name"]').fill(`${item.name} (M6)`);
  await details.locator('input[name="laborHours"]').fill("2.5");
  await details.locator('button:has-text("Save details")').click();
  await settle(page);
  const [after] = await pz(`SELECT name, labor_hours FROM price_book_items WHERE id='${item.id}'`);
  check("pricebook name + labor hours edited (no longer stuck forever)", after.name.endsWith("(M6)") && after.labor_hours === 2.5);

  // CSV export round-trips.
  const res = await page.request.get(`${BASE}/api/export/pricebook`);
  const csv = await res.text();
  check("pricebook CSV export serves the book", res.status() === 200 && csv.startsWith("code,name,category") && csv.includes(item.code));

  // CSV import: update the edited item's price + add a brand-new code.
  await page.click('summary:has-text("Edit details")'); // ensure page interactive
  const importForm = page.locator('form:has(textarea[name="csv"])');
  await importForm.locator('textarea[name="csv"]').fill(
    `code,name,category,cost,price,laborHours\n${item.code},${after.name},Imported,100,999,1\nM6-NEW,M6 Imported Widget,Imported,10,45,0.5`
  );
  await importForm.locator('button:has-text("Import rows")').click();
  await settle(page);
  const [upd] = await pz(`SELECT unit_price_cents, category FROM price_book_items WHERE id='${item.id}'`);
  const [fresh] = await pz(`SELECT name, unit_price_cents FROM price_book_items WHERE code='M6-NEW'`);
  check("CSV import upserts by code (existing updated, new row created)",
    upd.unit_price_cents === 99900 && upd.category === "Imported" && fresh?.unit_price_cents === 4500);
  check("import audited with summary", (await audits("PRICEBOOK_CSV_IMPORT"))[0]?.detail?.created >= 1);
}

// ═══ DASHBOARD ═══════════════════════════════════════════════════════════════
{
  await page.goto(`${BASE}/dashboard?from=2026-07-01&to=2026-07-31`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const body = await page.textContent("body");
  check("custom date range drives the revenue tile", body.includes("Revenue in range"));

  // Drill-through links on both scoreboards.
  const [tech] = await pz(`SELECT id FROM users WHERE role='TECH' AND active LIMIT 1`);
  const techLink = await page.locator(`a[href="/jobs?tech=${tech.id}"]`).count();
  const repLinks = await page.locator('a[href^="/commissions?user="]').count();
  check("scoreboards drill through to jobs + commissions", techLink > 0 && repLinks > 0);

  // Payments CSV export honors the range.
  const res = await page.request.get(`${BASE}/api/export/payments?from=2026-01-01&to=2026-12-31`);
  const csv = await res.text();
  const lines = csv.trim().split("\n");
  const [payCount] = await pz(`SELECT count(*)::int n FROM payments WHERE received_at >= '2026-01-01' AND received_at <= '2026-12-31T23:59:59'`);
  check(`payments CSV export matches the DB (${lines.length - 1} rows vs ${payCount.n})`,
    res.status() === 200 && lines[0].startsWith("receivedAt,invoice,customer") && lines.length - 1 === payCount.n);
}

// ═══ EARNINGS DISPUTE ════════════════════════════════════════════════════════
{
  const [tech] = await pz(`SELECT id, email, name FROM users WHERE role='TECH' AND active LIMIT 1`);
  await pz(`INSERT INTO commission_entries (id, user_id, description, amount_cents, period, status)
    VALUES ('m6-dispute', '${tech.id}', 'M6 disputed spiff', 5000, '2026-07', 'PENDING')
    ON CONFLICT (id) DO UPDATE SET status='PENDING'`);
  const ctx2 = await browser.newContext();
  const techPage = await ctx2.newPage();
  await login(techPage, tech.email);
  await techPage.goto(`${BASE}/earnings`, { waitUntil: "networkidle" });
  await techPage.waitForTimeout(700);
  const disputeDetails = techPage.locator(`details:has(form:has(input[name="entryId"][value="m6-dispute"]))`).first();
  await disputeDetails.locator("summary").click();
  await techPage.waitForTimeout(300);
  await disputeDetails.locator('input[name="reason"]').fill("Amount should be $75 per the spiff sheet");
  await disputeDetails.locator('button:has-text("Send")').click();
  await settle(techPage);
  await ctx2.close();

  const [aud] = await audits("COMMISSION_DISPUTED");
  const notified = await pz(`SELECT count(*)::int n FROM notifications WHERE title LIKE '%Commission disputed by ${tech.name}%'`);
  check("dispute audited with reason", aud?.entity_id === "m6-dispute" && aud?.detail?.reason?.includes("$75"));
  check(`dispute pinged the managers (${notified[0]?.n ?? 0} notification(s))`, (notified[0]?.n ?? 0) > 0);
}

// ═══ BULK OPERATIONS ═════════════════════════════════════════════════════════
{
  // Jobs: two closed + one open selected → 2 archived, 1 skipped.
  const closed = await pz(`SELECT id, number FROM jobs WHERE status IN ('COMPLETED','CANCELLED') AND deleted_at IS NULL LIMIT 2`);
  const [open] = await pz(`SELECT id FROM jobs WHERE status IN ('SCHEDULED','UNSCHEDULED') AND deleted_at IS NULL LIMIT 1`);
  await page.goto(`${BASE}/jobs`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  for (const j of closed) await page.locator(`input[name="ids"][value="${j.id}"]`).check();
  // The open job's checkbox is disabled by design — verify that.
  const openDisabled = await page.locator(`input[name="ids"][value="${open.id}"]`).isDisabled();
  await page.locator('#bulk-jobs button:has-text("Archive selected")').click();
  await settle(page);
  const archivedJobs = await pz(`SELECT count(*)::int n FROM jobs WHERE id IN ('${closed.map((j) => j.id).join("','")}') AND deleted_at IS NOT NULL`);
  check(`bulk job archive swept ${closed.length} closed jobs (open rows can't even be ticked)`,
    archivedJobs[0].n === closed.length && openDisabled);
  check("bulk job archive audited", (await audits("JOBS_BULK_ARCHIVED"))[0]?.detail?.archived === closed.length);

  // Leads: archive two in one sweep.
  const leadRows = await pz(`SELECT id FROM leads WHERE archived_at IS NULL LIMIT 2`);
  await page.goto(`${BASE}/leads`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  for (const l of leadRows) await page.locator(`input[name="ids"][value="${l.id}"]`).check();
  await page.locator('#bulk-leads button:has-text("Archive selected")').click();
  await settle(page);
  const archivedLeads = await pz(`SELECT count(*)::int n FROM leads WHERE id IN ('${leadRows.map((l) => l.id).join("','")}') AND archived_at IS NOT NULL`);
  check(`bulk lead archive swept ${leadRows.length} leads`, archivedLeads[0].n === leadRows.length);
  // Restore them (keep the demo pipeline healthy).
  await pz(`UPDATE leads SET archived_at=NULL WHERE id IN ('${leadRows.map((l) => l.id).join("','")}')`);

  // Invoices: bulk reminders for open invoices — queued for approval, deduped.
  const openInv = await pz(`SELECT id, number FROM invoices WHERE status IN ('SENT','PARTIAL','OVERDUE') LIMIT 2`);
  if (openInv.length > 0) {
    await page.goto(`${BASE}/invoices`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    for (const i of openInv) await page.locator(`input[name="ids"][value="${i.id}"]`).check();
    await page.locator('#bulk-inv button:has-text("Queue reminders")').click();
    await settle(page);
    const queued = await pz(`SELECT count(*)::int n FROM outbound_messages WHERE status='PENDING_APPROVAL' AND subject IN (${openInv.map((i) => `'Payment reminder — ${i.number}'`).join(",")})`);
    check(`bulk reminders queued for approval (${queued[0].n}/${openInv.length})`, queued[0].n === openInv.length);
    check("bulk reminders audited", (await audits("BULK_REMINDERS_QUEUED"))[0]?.detail?.queued === openInv.length);
  } else {
    check("open invoices exist for bulk reminders (seed)", false);
  }
}

// ═══ KB UNPUBLISHED VIEW ═════════════════════════════════════════════════════
{
  const [art] = await pz(`SELECT id, title FROM kb_articles WHERE archived_at IS NULL LIMIT 1`);
  await pz(`UPDATE kb_articles SET archived_at=now() WHERE id='${art.id}'`);
  await page.goto(`${BASE}/kb?archived=1`, { waitUntil: "networkidle" });
  const archBody = await page.textContent("body");
  await page.goto(`${BASE}/kb`, { waitUntil: "networkidle" });
  const pubBody = await page.textContent("body");
  check("KB 'Show unpublished' view lists archived articles only",
    archBody.includes(art.title) && !pubBody.includes(art.title));
  await pz(`UPDATE kb_articles SET archived_at=NULL WHERE id='${art.id}'`);
}

await ctx.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL M6 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
