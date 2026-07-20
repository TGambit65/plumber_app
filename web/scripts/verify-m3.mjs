/* E2E: Phase M3 — money layer: estimates (standalone/options/expire/reopen/
   claim-link/duplicate/optional lines), invoices (detail page, DRAFT editing,
   reference, reminder, void & duplicate), commissions (rule edit/delete,
   bulk payroll, un-approve, manual entries).
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

// ═══ ESTIMATES ═══════════════════════════════════════════════════════════════

// ── 1. Standalone estimate (no lead) — against a customer with an open claim ─
let estId;
{
  const [cust] = await pz(`SELECT c.id, c.name FROM customers c
    WHERE c.archived_at IS NULL AND EXISTS (SELECT 1 FROM claims cl WHERE cl.customer_id=c.id AND cl.status NOT IN ('CLOSED','DENIED')) LIMIT 1`);
  await page.goto(`${BASE}/estimates`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.click('summary:has-text("New estimate")');
  await page.waitForTimeout(300);
  const form = page.locator('form:has(select[name="customerId"]):has(input[name="notes"])');
  await form.locator('select[name="customerId"]').selectOption(cust.id);
  await form.locator('input[name="notes"]').fill("M3 Standalone — repipe options");
  await form.locator('button:has-text("Create draft estimate")').click();
  await page.waitForURL(/\/estimates\/[a-z0-9-]+$/, { timeout: 15000 });
  await settle(page);

  const [est] = await pz(`SELECT e.id, e.status, e.number,
    (SELECT count(*)::int FROM estimate_options o WHERE o.estimate_id=e.id) options
    FROM estimates e WHERE e.notes='M3 Standalone — repipe options'`);
  estId = est?.id;
  check(`standalone estimate created — no lead required (${est?.number}, ${est?.options} options)`,
    Boolean(est) && est.status === "DRAFT" && est.options === 3);
}

// ── 2. Option management: rename/retier, reorder, remove ────────────────────
{
  const opts = await pz(`SELECT id, name, tier, sort_order FROM estimate_options WHERE estimate_id='${estId}' ORDER BY sort_order`);
  // Rename + retier the GOOD option.
  const optDetails = page.locator(`details:has(form:has(input[name="optionId"][value="${opts[0].id}"]):has(select[name="tier"]))`).first();
  await optDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await optDetails.locator('input[name="name"]').fill("Essentials");
  await optDetails.locator('select[name="tier"]').selectOption("CUSTOM");
  await optDetails.locator('button:has-text("Save")').click();
  await settle(page);
  const [renamed] = await pz(`SELECT name, tier FROM estimate_options WHERE id='${opts[0].id}'`);
  check("option renamed + retiered (Good → Essentials/CUSTOM)", renamed.name === "Essentials" && renamed.tier === "CUSTOM");

  // Reorder: move first option right.
  await page.locator(`form:has(input[name="optionId"][value="${opts[0].id}"]):has(input[name="dir"][value="1"]) button`).click();
  await settle(page);
  const reordered = await pz(`SELECT id FROM estimate_options WHERE estimate_id='${estId}' ORDER BY sort_order`);
  check("options reorder (swap with neighbor)", reordered[1].id === opts[0].id && reordered[0].id === opts[1].id);

  // Remove the last option.
  await page.locator(`form:has(input[name="optionId"][value="${opts[2].id}"]) button:has-text("Remove")`).click();
  await settle(page);
  const left = await pz(`SELECT id FROM estimate_options WHERE estimate_id='${estId}'`);
  check("unselected option removed", left.length === 2 && !left.some((o) => o.id === opts[2].id));
}

// ── 3. Notes + financing toggle ──────────────────────────────────────────────
{
  await page.click('summary:has-text("Notes & financing")');
  await page.waitForTimeout(300);
  const form = page.locator('form:has(input[name="financingOffered"])');
  await form.locator('input[name="financingOffered"]').uncheck();
  await form.locator('button:has-text("Save")').click();
  await settle(page);
  const [est] = await pz(`SELECT financing_offered FROM estimates WHERE id='${estId}'`);
  const body = await page.textContent("body");
  check("financing toggled off (badge gone)", est.financing_offered === false && !body.includes("Financing offered"));
}

// ── 4. Optional add-on line excluded from the base total ────────────────────
{
  const [opt] = await pz(`SELECT id FROM estimate_options WHERE estimate_id='${estId}' ORDER BY sort_order LIMIT 1`);
  const addForm = page.locator(`form:has(input[name="optionId"][value="${opt.id}"]):has(select[name="priceBookItemId"])`);
  await addForm.locator('select[name="priceBookItemId"]').selectOption({ index: 1 });
  await addForm.locator('button:has-text("Add item")').click();
  await settle(page);
  await addForm.locator('select[name="priceBookItemId"]').selectOption({ index: 2 });
  await addForm.locator('button:has-text("Add item")').click();
  await settle(page);
  const lines = await pz(`SELECT id, qty, unit_price_cents FROM estimate_line_items WHERE option_id='${opt.id}'`);
  check("two lines added to the option", lines.length === 2);

  // Toggle the second line optional.
  await page.locator(`form:has(input[name="itemId"][value="${lines[1].id}"]) button:has-text("opt")`).click();
  await settle(page);
  const [optional] = await pz(`SELECT optional FROM estimate_line_items WHERE id='${lines[1].id}'`);
  const body = await page.textContent("body");
  check("line marked optional (badge shows)", optional.optional === true && body.includes("Optional add-on"));

  // Base total shown excludes the optional line (money() drops ".00" on whole dollars).
  const baseTotal = Math.round(lines[0].qty * lines[0].unit_price_cents);
  const fmt = (baseTotal / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: baseTotal % 100 === 0 ? 0 : 2,
  });
  check(`option total excludes the optional add-on (${fmt})`, body.includes(fmt));
}

// ── 5. Claim link from the builder ───────────────────────────────────────────
{
  const [est] = await pz(`SELECT customer_id FROM estimates WHERE id='${estId}'`);
  const [claim] = await pz(`SELECT id, claim_number FROM claims WHERE customer_id='${est.customer_id}' AND status NOT IN ('CLOSED','DENIED') LIMIT 1`);
  const form = page.locator('form:has(select[name="claimId"])');
  await form.locator('select[name="claimId"]').selectOption(claim.id);
  await form.locator('button:has-text("Link claim")').click();
  await settle(page);
  const [linked] = await pz(`SELECT claim_id FROM estimates WHERE id='${estId}'`);
  check(`estimate linked to insurance claim ${claim.claim_number} (dead-end closed)`, linked.claim_id === claim.id);
  check("claim link audited", (await audits("CLAIM_LINKED"))[0]?.entity_id === estId);
}

// ── 6. Manual expire + reopen ────────────────────────────────────────────────
{
  await page.click('button:has-text("Expire")');
  await settle(page);
  let [est] = await pz(`SELECT status FROM estimates WHERE id='${estId}'`);
  check(`manual expire (${est.status})`, est.status === "EXPIRED");

  const reopen = page.locator('form:has(input[name="reason"]):has(button:has-text("Reopen as draft"))');
  await reopen.locator('input[name="reason"]').fill("Customer re-engaged");
  await reopen.locator('button:has-text("Reopen as draft")').click();
  await settle(page);
  [est] = await pz(`SELECT status, sent_at, expires_at FROM estimates WHERE id='${estId}'`);
  check("reopened → DRAFT (send clock reset)", est.status === "DRAFT" && est.sent_at === null && est.expires_at === null);
  check("reopen audited with reason", (await audits("ESTIMATE_REOPENED"))[0]?.detail?.reason === "Customer re-engaged");
}

// ── 7. Auto-expire past the 30-day shelf life ────────────────────────────────
{
  const [sent] = await pz(`SELECT id, number FROM estimates WHERE status IN ('SENT','VIEWED') LIMIT 1`);
  await pz(`UPDATE estimates SET expires_at=now() - interval '1 day' WHERE id='${sent.id}'`);
  await page.goto(`${BASE}/estimates`, { waitUntil: "networkidle" });
  const [after] = await pz(`SELECT status FROM estimates WHERE id='${sent.id}'`);
  const [fu] = await pz(`SELECT count(*)::int n FROM follow_ups WHERE estimate_id='${sent.id}' AND status='PENDING'`);
  check(`stale SENT estimate auto-expired on page load (${sent.number} → ${after.status})`, after.status === "EXPIRED");
  check("auto-expire stops pending follow-ups", fu.n === 0);
}

// ── 8. Duplicate an approved estimate ────────────────────────────────────────
{
  const [approved] = await pz(`SELECT e.id, e.number,
    (SELECT count(*)::int FROM estimate_line_items li JOIN estimate_options o ON li.option_id=o.id WHERE o.estimate_id=e.id) lines
    FROM estimates e WHERE e.status='APPROVED' LIMIT 1`);
  await page.goto(`${BASE}/estimates/${approved.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.click('button:has-text("Duplicate")');
  await page.waitForURL((u) => /\/estimates\/[a-z0-9-]+$/.test(u.pathname ?? String(u)) && !String(u).includes(approved.id), { timeout: 15000 });
  await settle(page);
  const [copy] = await pz(`SELECT e.id, e.number, e.status,
    (SELECT count(*)::int FROM estimate_line_items li JOIN estimate_options o ON li.option_id=o.id WHERE o.estimate_id=e.id) lines
    FROM estimates e ORDER BY e.created_at DESC LIMIT 1`);
  check(`duplicated ${approved.number} → ${copy.number} (DRAFT, ${copy.lines}/${approved.lines} lines copied)`,
    copy.status === "DRAFT" && copy.lines === approved.lines && copy.id !== approved.id);
}

// ═══ INVOICES ════════════════════════════════════════════════════════════════

// ── 9. Standalone invoice + DRAFT line/date editing on the new detail page ──
let invId;
{
  const [cust] = await pz(`SELECT id FROM customers WHERE archived_at IS NULL ORDER BY name LIMIT 1`);
  await page.goto(`${BASE}/invoices`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.click('summary:has-text("New invoice")');
  await page.waitForTimeout(300);
  const form = page.locator('form:has(button:has-text("Create draft"))');
  await form.locator('select[name="customerId"]').selectOption(cust.id);
  await form.locator('button:has-text("Create draft")').click();
  await page.waitForURL(/\/invoices\/[a-z0-9-]+$/, { timeout: 15000 });
  await settle(page);
  invId = new URL(page.url()).pathname.split("/").pop();
  const [inv] = await pz(`SELECT status FROM invoices WHERE id='${invId}'`);
  check("standalone DRAFT invoice created → detail page", inv?.status === "DRAFT");

  // Add a price book line + a custom line.
  const pbForm = page.locator('form:has(select[name="priceBookItemId"])');
  await pbForm.locator('select[name="priceBookItemId"]').selectOption({ index: 1 });
  await pbForm.locator('button:has-text("＋ Add item")').click();
  await settle(page);
  const customForm = page.locator('form:has(input[name="description"]):has(button:has-text("Add custom"))');
  await customForm.locator('input[name="description"]').fill("After-hours service fee");
  await customForm.locator('input[name="price"]').fill("150");
  await customForm.locator('button:has-text("Add custom")').click();
  await settle(page);
  let lines = await pz(`SELECT id, description, qty, unit_price_cents FROM invoice_line_items WHERE invoice_id='${invId}' ORDER BY description`);
  check(`two lines on the draft (${lines.map((l) => l.description).join(" · ")})`, lines.length === 2 && lines[0].description === "After-hours service fee");

  // Edit qty on the custom line.
  const feeLine = lines[0];
  const lineForm = page.locator(`form:has(input[name="lineId"][value="${feeLine.id}"])`);
  await lineForm.locator('input[name="qty"]').fill("2");
  await lineForm.locator('button[title="Save qty/price"]').click();
  await settle(page);
  const [edited] = await pz(`SELECT qty FROM invoice_line_items WHERE id='${feeLine.id}'`);
  check("line qty edited while DRAFT (1 → 2)", edited.qty === 2);

  // Remove the price-book line.
  const pbLine = lines[1];
  await page.locator(`form:has(input[name="lineId"][value="${pbLine.id}"]) button[title="Remove line"]`).click();
  await settle(page);
  lines = await pz(`SELECT id FROM invoice_line_items WHERE invoice_id='${invId}'`);
  check("line removed while DRAFT", lines.length === 1);

  // Edit dates while DRAFT.
  const dateForm = page.locator('form:has(input[name="dueAt"])');
  await dateForm.locator('input[name="issuedAt"]').fill("2026-07-20");
  await dateForm.locator('input[name="dueAt"]').fill("2026-08-05");
  await dateForm.locator('button:has-text("Save dates")').click();
  await settle(page);
  const [dates] = await pz(`SELECT issued_at, due_at FROM invoices WHERE id='${invId}'`);
  check("issued/due dates edited while DRAFT", dates.issued_at !== null && new Date(dates.due_at).toISOString().startsWith("2026-08-05"));
}

// ── 10. Send → partial payment WITH reference → reminder queue ──────────────
{
  await page.click('button:has-text("Mark sent")');
  await settle(page);
  const payForm = page.locator('form:has(input[name="reference"]):has(button:has-text("Record payment"))');
  await payForm.locator('input[name="amount"]').fill("100");
  await payForm.locator('select[name="method"]').selectOption("CHECK");
  await payForm.locator('input[name="reference"]').fill("CHK-1042");
  await payForm.locator('button:has-text("Record payment")').click();
  await settle(page);
  const [pay] = await pz(`SELECT amount_cents, method, reference FROM payments WHERE invoice_id='${invId}'`);
  const [inv] = await pz(`SELECT status, number FROM invoices WHERE id='${invId}'`);
  check(`payment recorded with reference (${pay?.reference}, ${inv.status})`,
    pay?.reference === "CHK-1042" && pay.method === "CHECK" && inv.status === "PARTIAL");

  await page.click('button:has-text("Send payment reminder")');
  await settle(page);
  const [reminder] = await pz(`SELECT kind, status, subject FROM outbound_messages WHERE subject='Payment reminder — ${inv.number}'`);
  check("payment reminder QUEUED for approval (never silent)", reminder?.kind === "CUSTOMER_MESSAGE" && reminder?.status === "PENDING_APPROVAL");
}

// ── 11. Void & duplicate (the correction path) ───────────────────────────────
{
  const [orig] = await pz(`SELECT number FROM invoices WHERE id='${invId}'`);
  await page.click('button:has-text("Void & duplicate as draft")');
  await page.waitForURL((u) => /\/invoices\/[a-z0-9-]+$/.test(new URL(String(u)).pathname) && !String(u).includes(invId), { timeout: 15000 });
  await settle(page);
  const [voided] = await pz(`SELECT status FROM invoices WHERE id='${invId}'`);
  const newId = new URL(page.url()).pathname.split("/").pop();
  const [draft] = await pz(`SELECT i.status, i.number, (SELECT count(*)::int FROM invoice_line_items l WHERE l.invoice_id=i.id) lines FROM invoices i WHERE i.id='${newId}'`);
  check(`void & duplicate: ${orig.number} → VOID, ${draft.number} → DRAFT with lines copied`,
    voided.status === "VOID" && draft.status === "DRAFT" && draft.lines === 1);
  check("correction audited", (await audits("VOID_AND_DUPLICATE"))[0]?.detail?.voided === orig.number);
}

// ═══ COMMISSIONS ═════════════════════════════════════════════════════════════

// ── 12. Rule edit + delete (settings tab) ────────────────────────────────────
{
  const [rule] = await pz(`SELECT id, name, rate FROM commission_rules WHERE kind::text LIKE 'PERCENT%' LIMIT 1`);
  await page.goto(`${BASE}/settings?tab=commissions`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const details = page.locator(`details:has(input[name="ruleId"][value="${rule.id}"])`).first();
  await details.locator("summary").click();
  await page.waitForTimeout(300);
  await details.locator('input[name="rate"]').fill("7.5");
  await details.locator('button:has-text("Save rule")').click();
  await settle(page);
  const [after] = await pz(`SELECT rate FROM commission_rules WHERE id='${rule.id}'`);
  check(`rule rate edited (${rule.rate}% → ${after.rate}%) — no longer stuck forever`, after.rate === 7.5);

  // Add a throwaway rule, then delete it.
  const addForm = page.locator('form:has(button:has-text("Add rule"))');
  await addForm.locator('input[name="name"]').fill("M3 Throwaway rule");
  await addForm.locator('input[name="rate"]').fill("1");
  await addForm.locator('button:has-text("Add rule")').click();
  await settle(page);
  const [tmp] = await pz(`SELECT id FROM commission_rules WHERE name='M3 Throwaway rule'`);
  await page.locator(`form:has(input[name="ruleId"][value="${tmp.id}"]) button[title*="Delete"]`).click();
  await settle(page);
  const gone = await pz(`SELECT id FROM commission_rules WHERE id='${tmp.id}'`);
  check("rule deleted (audited)", gone.length === 0 && (await audits("RULE_DELETED"))[0]?.entity_id === tmp.id);
}

// ── 13. Manual entry → bulk approve → un-approve → bulk pay ─────────────────
{
  const period = new Date().toISOString().slice(0, 7);
  const [tech] = await pz(`SELECT id, name FROM users WHERE role='TECH' AND active LIMIT 1`);
  await page.goto(`${BASE}/commissions`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  // Manual entry.
  await page.click('summary:has-text("Manual entry")');
  await page.waitForTimeout(300);
  const manForm = page.locator('form:has(button:has-text("Add entry"))');
  await manForm.locator('select[name="userId"]').selectOption(tech.id);
  await manForm.locator('input[name="description"]').fill("M3 review spiff");
  await manForm.locator('input[name="amount"]').fill("150");
  await manForm.locator('button:has-text("Add entry")').click();
  await settle(page);
  const [manual] = await pz(`SELECT id, status, amount_cents, source_type FROM commission_entries WHERE description LIKE 'M3 review spiff%'`);
  check("manual entry created (PENDING, sourceType MANUAL)", manual?.status === "PENDING" && manual.amount_cents === 15000 && manual.source_type === "MANUAL");

  // Bulk approve the period.
  const before = await pz(`SELECT count(*)::int n FROM commission_entries WHERE period='${period}' AND status='PENDING'`);
  const approveForm = page.locator('form:has(input[name="mode"][value="approve"])');
  await approveForm.locator('button:has-text("Approve all pending")').click();
  await settle(page);
  const pendingAfter = await pz(`SELECT count(*)::int n FROM commission_entries WHERE period='${period}' AND status='PENDING'`);
  check(`bulk approve cleared the period's pending queue (${before[0].n} → ${pendingAfter[0].n})`,
    before[0].n > 0 && pendingAfter[0].n === 0);
  check("bulk approve audited with count", (await audits("BULK_APPROVE"))[0]?.detail?.count === before[0].n);

  // Un-approve the manual entry with a reason.
  await page.goto(`${BASE}/commissions?status=APPROVED`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const unDetails = page.locator(`details:has(input[name="entryId"][value="${manual.id}"])`).first();
  await unDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await unDetails.locator('input[name="reason"]').fill("Wrong amount — needs review");
  await unDetails.locator('button:has-text("Go")').click();
  await settle(page);
  const [unapproved] = await pz(`SELECT status FROM commission_entries WHERE id='${manual.id}'`);
  check("un-approve walked APPROVED back to PENDING", unapproved.status === "PENDING");
  check("un-approve audited with reason", (await audits("COMMISSION_UNAPPROVED"))[0]?.detail?.reason === "Wrong amount — needs review");

  // Bulk pay what's still approved.
  const approvedCount = await pz(`SELECT count(*)::int n FROM commission_entries WHERE period='${period}' AND status='APPROVED'`);
  await page.goto(`${BASE}/commissions`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const payForm = page.locator('form:has(input[name="mode"][value="pay"])');
  await payForm.locator('button:has-text("Mark all approved paid")').click();
  await settle(page);
  const stillApproved = await pz(`SELECT count(*)::int n FROM commission_entries WHERE period='${period}' AND status='APPROVED'`);
  check(`bulk pay ran the payroll (${approvedCount[0].n} approved → ${stillApproved[0].n} left)`,
    approvedCount[0].n > 0 && stillApproved[0].n === 0);
  // The un-approved entry stayed PENDING (PAID immutability respected end-to-end).
  const [survivor] = await pz(`SELECT status FROM commission_entries WHERE id='${manual.id}'`);
  check("un-approved entry untouched by bulk pay (still PENDING)", survivor.status === "PENDING");
}

await ctx.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL M3 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
