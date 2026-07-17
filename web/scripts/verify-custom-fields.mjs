/* E2E: pack-scoped custom fields — Mascott sees + saves fuel fields, Apex sees none, forged values rejected server-side. */
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
};

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
}

// ── 1. Mascott: seeded fuel fields display + add-equipment round-trip ────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "owner@mascottfuel.demo");
  await page.goto(`${BASE}/customers`);
  await page.click('a:has-text("QuikTrip #412")');
  await page.waitForLoadState("networkidle");

  const body = await page.textContent("body");
  check("Mascott: seeded UST shows Capacity 12000 gal", body.includes("Capacity:") && body.includes("12000 gal"));
  check("Mascott: seeded UST shows Product stored Gasoline", body.includes("Product stored:") && body.includes("Gasoline"));
  check("Mascott: seeded dispenser shows Hose positions", body.includes("Hose positions:") && body.includes("2"));
  check("Mascott: seeded dispenser shows Last W&M seal", body.includes("Last W&M seal:") && body.includes("2025-08-02"));

  // Add a new AST with pack fields.
  await page.click('summary:has-text("＋ Add equipment")');
  await page.selectOption('select[name="kind"]', "Aboveground Storage Tank (AST)");
  await page.waitForTimeout(300);
  const formBody = await page.textContent("form:has(select[name=kind])");
  check("Mascott: AST form shows pack fields (Capacity, Product stored)", formBody.includes("Capacity") && formBody.includes("Product stored"));
  check("Mascott: UST-only field (Leak detection) hidden for AST", !formBody.includes("Leak detection"));

  await page.fill('input[name="brand"]', "Highland");
  await page.fill('input[name="cf_capacityGal"]', "500");
  await page.selectOption('select[name="cf_product"]', "Diesel");
  await page.check('input[name="cf_doubleWall"]');
  await page.fill('input[name="cf_installYear"]', "2024");
  await page.click('form:has(select[name=kind]) button[type="submit"]');
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);

  const after = await page.textContent("body");
  check(
    "Mascott: new AST round-trips with typed values (500 gal, Diesel, Double-wall Yes)",
    after.includes("Aboveground Storage Tank (AST)") && after.includes("500 gal") && after.includes("Diesel") && after.includes("Double-wall construction:")
  );
  await ctx.close();
}

// ── 2. Apex (plumbing): ZERO fuel-field leakage ──────────────────────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "owner@apexplumbing.demo");
  await page.goto(`${BASE}/customers`);
  await page.click("tbody tr a >> nth=0");
  await page.waitForLoadState("networkidle");

  await page.click('summary:has-text("＋ Add equipment")');
  await page.waitForTimeout(300);
  const kinds = await page.$$eval('select[name="kind"] option', (os) => os.map((o) => o.value));
  check("Apex: kinds are plumbing kinds (Water Heater present)", kinds.some((k) => k.includes("Water Heater")));
  check("Apex: NO fuel kinds leak (no UST)", !kinds.some((k) => k.includes("UST") || k.includes("Storage Tank")));
  const formBody = await page.textContent("form:has(select[name=kind])");
  check("Apex: NO fuel custom fields leak (no Capacity/Product stored)", !formBody.includes("Product stored") && !formBody.includes("Capacity ("));
  await ctx.close();
}

// ── 3. Server-side validation: forged select value is REJECTED ───────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "owner@mascottfuel.demo");
  await page.goto(`${BASE}/customers`);
  await page.click('a:has-text("QuikTrip #412")');
  await page.waitForLoadState("networkidle");
  const before = (await page.textContent("body")).split("🔩").length - 1;

  await page.click('summary:has-text("＋ Add equipment")');
  await page.selectOption('select[name="kind"]', "Underground Storage Tank (UST)");
  await page.waitForTimeout(300);
  await page.fill('input[name="cf_capacityGal"]', "1000");
  // Forge an out-of-catalog product value by injecting a rogue <option>.
  await page.evaluate(() => {
    const sel = document.querySelector('select[name="cf_product"]');
    const o = document.createElement("option");
    o.value = "Moonshine";
    o.textContent = "Moonshine";
    sel.appendChild(o);
    sel.value = "Moonshine";
  });
  await page.click('form:has(select[name=kind]) button[type="submit"]');
  await page.waitForTimeout(1500);

  await page.goto(`${BASE}/customers`);
  await page.click('a:has-text("QuikTrip #412")');
  await page.waitForLoadState("networkidle");
  const after = (await page.textContent("body")).split("🔩").length - 1;
  check(`Server rejected forged select value (equipment count ${before} → ${after}, no Moonshine row)`, after === before && !(await page.textContent("body")).includes("Moonshine"));
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "\nALL CUSTOM-FIELD CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
