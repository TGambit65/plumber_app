/* E2E: Phase M5 — inventory (stock rows, locations, transfers, PO lifecycle
   incl. per-line partial receive), claims corrections, admin (user identity,
   password reset, truck assignment, real company profile).
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

async function login(page, email, password = "demo1234") {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
}
const settle = async (page, ms = 900) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(ms); };

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();
await login(page, "owner@plumbzebra.demo");

// ═══ INVENTORY ═══════════════════════════════════════════════════════════════
let truckId;
{
  await page.goto(`${BASE}/inventory`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  // Create a new truck location.
  const locForm = page.locator('form:has(select[name="kind"])');
  await locForm.locator('input[name="name"]').fill("M5 Truck 9");
  await locForm.locator('select[name="kind"]').selectOption("TRUCK");
  await locForm.locator('button:has-text("Add location")').click();
  await settle(page);
  const [truck] = await pz(`SELECT id FROM inventory_locations WHERE name='M5 Truck 9'`);
  truckId = truck?.id;
  check("new truck location created", Boolean(truck));

  // Add a stock row at the selected (first) location.
  const [warehouse] = await pz(`SELECT id FROM inventory_locations WHERE kind='WAREHOUSE' ORDER BY name LIMIT 1`);
  const [untracked] = await pz(`SELECT i.id, i.name FROM price_book_items i WHERE i.active AND NOT EXISTS
    (SELECT 1 FROM stock_levels s WHERE s.price_book_item_id=i.id AND s.location_id='${warehouse.id}') LIMIT 1`);
  await page.goto(`${BASE}/inventory?loc=${warehouse.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const addStock = page.locator('form:has(input[name="qtyOnHand"])');
  await addStock.locator('select[name="priceBookItemId"]').selectOption(untracked.id);
  await addStock.locator('input[name="qtyOnHand"]').fill("10");
  await addStock.locator('input[name="minQty"]').fill("2");
  await addStock.locator('input[name="maxQty"]').fill("12");
  await addStock.locator('input[name="bin"]').fill("Z-9");
  await addStock.locator('button:has-text("Track item")').click();
  await settle(page);
  const [stockRow] = await pz(`SELECT id, qty_on_hand, bin FROM stock_levels WHERE location_id='${warehouse.id}' AND price_book_item_id='${untracked.id}'`);
  check(`stock row created (10 on hand, bin Z-9)`, stockRow?.qty_on_hand === 10 && stockRow.bin === "Z-9");

  // Edit min/max/bin.
  const rowDetails = page.locator(`details:has(form:has(input[name="stockId"][value="${stockRow.id}"]):has(input[name="minQty"]))`).first();
  await rowDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await rowDetails.locator('input[name="minQty"]').fill("3");
  await rowDetails.locator('input[name="bin"]').fill("A-1");
  await rowDetails.locator('button:has-text("Save")').click();
  await settle(page);
  const [edited] = await pz(`SELECT min_qty, bin FROM stock_levels WHERE id='${stockRow.id}'`);
  check("min/bin edited on the stock row", edited.min_qty === 3 && edited.bin === "A-1");

  // Transfer 4 units to the new truck.
  const trDetails = page.locator(`details:has(form:has(input[name="stockId"][value="${stockRow.id}"]):has(select[name="toLocationId"]))`).first();
  await trDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await trDetails.locator('input[name="qty"]').fill("4");
  await trDetails.locator('select[name="toLocationId"]').selectOption(truckId);
  await trDetails.locator('button:has-text("Go")').click();
  await settle(page);
  const [src] = await pz(`SELECT qty_on_hand FROM stock_levels WHERE id='${stockRow.id}'`);
  const [dst] = await pz(`SELECT qty_on_hand FROM stock_levels WHERE location_id='${truckId}' AND price_book_item_id='${untracked.id}'`);
  check(`transfer moved 4 units warehouse → truck (${src.qty_on_hand} left, ${dst?.qty_on_hand} arrived)`,
    src.qty_on_hand === 6 && dst?.qty_on_hand === 4 && (await audits("STOCK_TRANSFER")).length > 0);

  // Retire guard: truck has stock → blocked; empty it → retire OK.
  await page.locator(`form:has(input[name="locationId"][value="${truckId}"]) button:has-text("Retire")`).click();
  await page.waitForTimeout(1200);
  const [stillThere] = await pz(`SELECT id FROM inventory_locations WHERE id='${truckId}'`);
  check("retire guard refuses a location with stock on hand", Boolean(stillThere));
  await pz(`UPDATE stock_levels SET qty_on_hand=0 WHERE location_id='${truckId}'`);
  await page.goto(`${BASE}/inventory`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.locator(`form:has(input[name="locationId"][value="${truckId}"]) button:has-text("Retire")`).click();
  await settle(page);
  const gone = await pz(`SELECT id FROM inventory_locations WHERE id='${truckId}'`);
  check("emptied location retires cleanly", gone.length === 0);
}

// ═══ PURCHASE ORDERS ═════════════════════════════════════════════════════════
{
  await page.goto(`${BASE}/inventory`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const poForm = page.locator('form:has(input[name="supplier"]):has(button:has-text("＋ Create PO"))');
  await poForm.locator('input[name="supplier"]').fill("M5 Winsupply");
  await poForm.locator('button:has-text("＋ Create PO")').click();
  await settle(page);
  const [po] = await pz(`SELECT id, number, status FROM purchase_orders WHERE supplier='M5 Winsupply'`);
  check(`manual PO created (${po?.number}, ${po?.status})`, po?.status === "DRAFT");

  // Add a line of 5 units.
  const [item] = await pz(`SELECT id, name FROM price_book_items WHERE active LIMIT 1`);
  const addLine = page.locator(`form:has(input[name="poId"][value="${po.id}"]):has(select[name="priceBookItemId"])`);
  await addLine.locator('select[name="priceBookItemId"]').selectOption(item.id);
  await addLine.locator('input[name="qty"]').fill("5");
  await addLine.locator('button:has-text("＋ Add")').click();
  await settle(page);
  const [line] = await pz(`SELECT id, qty FROM purchase_order_lines WHERE purchase_order_id='${po.id}'`);
  check("PO line added while open", line?.qty === 5);

  // Partial receive 2 of 5 → PARTIAL + warehouse stock bumps.
  const [warehouse] = await pz(`SELECT id FROM inventory_locations WHERE kind='WAREHOUSE' ORDER BY name LIMIT 1`);
  const [beforeStock] = await pz(`SELECT COALESCE((SELECT qty_on_hand FROM stock_levels WHERE location_id='${warehouse.id}' AND price_book_item_id='${item.id}'),0) q`);
  const recForm = page.locator(`form:has(input[name="lineId"][value="${line.id}"]):has(button:has-text("Receive"))`);
  await recForm.locator('input[name="qty"]').fill("2");
  await recForm.locator('button:has-text("Receive")').click();
  await settle(page);
  let [poNow] = await pz(`SELECT status FROM purchase_orders WHERE id='${po.id}'`);
  const [afterStock] = await pz(`SELECT qty_on_hand q FROM stock_levels WHERE location_id='${warehouse.id}' AND price_book_item_id='${item.id}'`);
  check(`per-line PARTIAL receive works (status=${poNow.status}, stock ${beforeStock.q} → ${afterStock.q})`,
    poNow.status === "PARTIAL" && Number(afterStock.q) === Number(beforeStock.q) + 2);

  // Receive the remaining 3 → RECEIVED → mark billed → BILLED.
  const recForm2 = page.locator(`form:has(input[name="lineId"][value="${line.id}"]):has(button:has-text("Receive"))`);
  await recForm2.locator('input[name="qty"]').fill("3");
  await recForm2.locator('button:has-text("Receive")').click();
  await settle(page);
  [poNow] = await pz(`SELECT status FROM purchase_orders WHERE id='${po.id}'`);
  check(`full receipt flips the PO to RECEIVED (${poNow.status})`, poNow.status === "RECEIVED");
  await page.locator(`form:has(input[name="poId"][value="${po.id}"]) button:has-text("Mark billed")`).click();
  await settle(page);
  [poNow] = await pz(`SELECT status FROM purchase_orders WHERE id='${po.id}'`);
  check(`supplier invoice closes the loop (${poNow.status})`, poNow.status === "BILLED");

  // Cancel path on a fresh PO.
  await poForm.locator('input[name="supplier"]').fill("M5 Cancel Co");
  await poForm.locator('button:has-text("＋ Create PO")').click();
  await settle(page);
  const [po2] = await pz(`SELECT id FROM purchase_orders WHERE supplier='M5 Cancel Co'`);
  await page.locator(`form:has(input[name="poId"][value="${po2.id}"]) button:has-text("Cancel PO")`).click();
  await settle(page);
  const [po2Now] = await pz(`SELECT status FROM purchase_orders WHERE id='${po2.id}'`);
  check("open PO cancelled — the new enum value works", po2Now.status === "CANCELLED");
}

// ═══ CLAIMS ══════════════════════════════════════════════════════════════════
{
  // Carrier edit (typo'd portal URL fix).
  const [carrier] = await pz(`SELECT id, name FROM carriers LIMIT 1`);
  await page.goto(`${BASE}/claims`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const carDetails = page.locator(`details:has(input[name="carrierId"][value="${carrier.id}"])`).first();
  await carDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await carDetails.locator('input[name="claimsPortalUrl"]').fill("https://portal.fixed.example.com");
  await carDetails.locator('button:has-text("Save carrier")').click();
  await settle(page);
  const [carAfter] = await pz(`SELECT claims_portal_url FROM carriers WHERE id='${carrier.id}'`);
  check("carrier portal URL corrected", carAfter.claims_portal_url === "https://portal.fixed.example.com");

  // Claim refs: fix the claim number + reassign adjuster.
  const [claim] = await pz(`SELECT c.id, c.claim_number, c.carrier_id FROM claims c WHERE c.status NOT IN ('CLOSED','DENIED') LIMIT 1`);
  const [adj] = await pz(`SELECT a.id, a.name FROM adjusters a WHERE a.carrier_id='${claim.carrier_id}' LIMIT 1`);
  await page.goto(`${BASE}/claims/${claim.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.click('summary:has-text("Edit claim #")');
  await page.waitForTimeout(300);
  const refsForm = page.locator('form:has(input[name="claimNumber"])');
  await refsForm.locator('input[name="claimNumber"]').fill(`${claim.claim_number}-FIX`);
  if (adj) await refsForm.locator('select[name="adjusterId"]').selectOption(adj.id);
  await refsForm.locator('button:has-text("Save refs")').click();
  await settle(page);
  const [claimAfter] = await pz(`SELECT claim_number, adjuster_id FROM claims WHERE id='${claim.id}'`);
  check("claim number + adjuster corrected (audited)",
    claimAfter.claim_number === `${claim.claim_number}-FIX` && (!adj || claimAfter.adjuster_id === adj.id) && (await audits("CLAIM_REFS_UPDATED"))[0]?.entity_id === claim.id);

  // Reopen a DENIED claim.
  await pz(`UPDATE claims SET status='DENIED' WHERE id='${claim.id}'`);
  await page.goto(`${BASE}/claims/${claim.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const reopenForm = page.locator('form:has(input[name="reason"]):has(button:has-text("Reopen"))');
  await reopenForm.locator('input[name="reason"]').fill("Carrier reconsidered scope");
  await reopenForm.locator('button:has-text("Reopen")').click();
  await settle(page);
  const [reopened] = await pz(`SELECT status FROM claims WHERE id='${claim.id}'`);
  check("DENIED claim reopened → DOCUMENTING (audited)", reopened.status === "DOCUMENTING" && (await audits("CLAIM_REOPENED"))[0]?.entity_id === claim.id);

  // Supplement edit while DRAFT (bootstrap one if the seed has none).
  let [sup] = await pz(`SELECT s.id, s.claim_id FROM claim_supplements s WHERE s.status='DRAFT' LIMIT 1`);
  if (!sup) {
    [sup] = await pz(`INSERT INTO claim_supplements (id, claim_id, number, description, amount_cents, status)
      SELECT 'm5-sup', c.id, 'SUP-99', 'M5 draft supplement', 100000, 'DRAFT' FROM claims c LIMIT 1
      ON CONFLICT (id) DO UPDATE SET status='DRAFT', amount_cents=100000 RETURNING id, claim_id`);
  }
  if (sup) {
    await page.goto(`${BASE}/claims/${sup.claim_id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const supDetails = page.locator(`details:has(form:has(input[name="supplementId"][value="${sup.id}"]))`).first();
    await supDetails.locator("summary").click();
    await page.waitForTimeout(300);
    await supDetails.locator('input[name="amount"]').fill("2222");
    await supDetails.locator('button:has-text("Save")').click();
    await settle(page);
    const [supAfter] = await pz(`SELECT amount_cents FROM claim_supplements WHERE id='${sup.id}'`);
    check("DRAFT supplement edited (decided ones stay records)", supAfter.amount_cents === 222200);
  } else {
    check("a DRAFT supplement exists (seed)", false);
  }
}

// ═══ SETTINGS / ADMIN ════════════════════════════════════════════════════════
{
  // User identity edit.
  const [tech] = await pz(`SELECT id, name, email FROM users WHERE role='TECH' AND active LIMIT 1`);
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const idDetails = page.locator(`details:has(form:has(input[name="userId"][value="${tech.id}"]):has(input[name="email"]))`).first();
  await idDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await idDetails.locator('input[name="phone"]').fill("509-555-9999");
  await idDetails.locator('button:has-text("Save")').click();
  await settle(page);
  const [techAfter] = await pz(`SELECT phone FROM users WHERE id='${tech.id}'`);
  check("user phone edited from the Team tab", techAfter.phone === "509-555-9999");

  // Password reset → the user can sign in with the temp password.
  const pwDetails = page.locator(`details:has(form:has(input[name="userId"][value="${tech.id}"]):has(input[name="password"]))`).first();
  await pwDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await pwDetails.locator('input[name="password"]').fill("temppass99");
  await pwDetails.locator('button:has-text("Reset")').click();
  await settle(page);
  check("password reset audited", (await audits("PASSWORD_RESET"))[0]?.entity_id === tech.id);
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await login(page2, tech.email, "temppass99");
  const loggedIn = !page2.url().includes("/login");
  check("the temp password actually signs the user in", loggedIn);
  await ctx2.close();

  // Truck assignment from the Team tab.
  const [freeTruck] = await pz(`INSERT INTO inventory_locations (id, name, kind) VALUES ('m5-truck-assign','M5 Assign Truck','TRUCK')
    ON CONFLICT (id) DO UPDATE SET user_id=NULL RETURNING id`);
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const truckForm = page.locator(`form:has(input[name="userId"][value="${tech.id}"]):has(select[name="locationId"])`);
  await truckForm.locator('select[name="locationId"]').selectOption(freeTruck.id);
  await truckForm.locator('button:has-text("Assign")').click();
  await settle(page);
  const [assigned] = await pz(`SELECT user_id FROM inventory_locations WHERE id='${freeTruck.id}'`);
  check("truck assigned to the tech from the Team tab", assigned.user_id === tech.id);

  // Company tab writes real org data.
  await page.goto(`${BASE}/settings?tab=company`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const orgForm = page.locator('form:has(input[name="licenseNumber"])');
  await orgForm.locator('input[name="businessPhone"]').fill("509-555-0100");
  await orgForm.locator('input[name="licenseNumber"]').fill("WA-PL-2026-777");
  await orgForm.locator('input[name="serviceArea"]').fill("Spokane + 30-mile radius");
  await orgForm.locator('button:has-text("Save company profile")').click();
  await settle(page);
  const [org] = await pz(`SELECT business_phone, license_number, service_area FROM organizations WHERE slug='plumb-zebra'`);
  check("Company tab saves REAL data (no more hardcoded JSX)",
    org.business_phone === "509-555-0100" && org.license_number === "WA-PL-2026-777" && org.service_area === "Spokane + 30-mile radius");
  check("org update audited", (await audits("ORG_UPDATED")).length > 0);
}

await ctx.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL M5 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
