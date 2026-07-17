/* E2E: supplier punchout — full cXML loop, approval gate, cross-tenant isolation. */
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

let estimateUrl = "";

// ── 1. Sales punches out, supplier returns the cart ──────────────────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "sales@apexplumbing.demo");
  await page.goto(`${BASE}/estimates`);
  // E-2091 is an editable (VIEWED) estimate in the seed.
  await page.click('tbody tr:has-text("E-2091") a >> nth=0');
  await page.waitForLoadState("networkidle");
  estimateUrl = page.url();

  const btn = page.locator('button:has-text("Punch out to Ferguson")').first();
  check("Sales sees the punch-out button on an editable estimate", (await btn.count()) > 0);

  await btn.click();
  await page.waitForURL(/localhost:8903\/store/, { timeout: 15000 });
  check("Punchout redirects to the supplier's mock catalog", page.url().includes("localhost:8903/store"));

  await page.click("#submit-cart");
  await page.waitForLoadState("networkidle");
  check("Cart return lands back on the estimate (303 follow)", page.url().startsWith(estimateUrl.split("?")[0]));

  const body = await page.textContent("body");
  check("Cart review card shows returned lines", body.includes("Supplier cart") && body.includes("FRG-7741") && body.includes("Brass Ball Valve"));
  check("Supplier total is computed (4×$18.42 + $96.10 + $612.00 = $781.78)", body.includes("781.78"));
  check("Sales (no approvals.manage) sees awaiting-approver, NOT approve button", body.includes("Awaiting an approver") && !body.includes("Approve → add to estimate"));
  check("Estimate does NOT yet contain the parts as line items", !body.includes("[Ferguson #FRG-7741]"));
  await ctx.close();
}

// ── 2. Owner approves → lines land on the estimate, marked up ────────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "owner@apexplumbing.demo");
  await page.goto(estimateUrl);
  await page.waitForLoadState("networkidle");

  const approve = page.locator('button:has-text("Approve → add to estimate")');
  check("Owner sees the approve button", (await approve.count()) > 0);
  await approve.first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
  await page.goto(estimateUrl);
  await page.waitForLoadState("networkidle");

  const body = await page.textContent("body");
  check("Approved lines are on the estimate with supplier provenance", body.includes("[Ferguson #FRG-7741]") && body.includes("[Ferguson #FRG-5580]"));
  check("Cart review card is gone after approval", !body.includes("awaiting approval"));
  // markup: cost 18.42 → sell 27.63
  check("Markup applied (cost $18.42 → sell $27.63)", body.includes("27.63"));
  await ctx.close();
}

// ── 3. Cross-tenant isolation: Summit can't see the Apex estimate/cart ───────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "owner@summithvac.demo");
  const res = await page.goto(estimateUrl);
  const body = await page.textContent("body");
  check(
    "Summit owner cannot open the Apex estimate (404/not found, no cart data)",
    res.status() === 404 || body.includes("not found") || body.includes("404") || !body.includes("Ferguson")
  );
  await ctx.close();
}

// ── 4. Forged buyerCookie is rejected by the return endpoint ─────────────────
{
  const res = await fetch(`${BASE}/api/punchout/return`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      "cxml-urlencoded": `<cXML><Message><PunchOutOrderMessage><BuyerCookie>forged-cookie</BuyerCookie><ItemIn quantity="1"><ItemID><SupplierPartID>EVIL</SupplierPartID></ItemID><ItemDetail><UnitPrice><Money currency="USD">1.00</Money></UnitPrice></ItemDetail></ItemIn></PunchOutOrderMessage></Message></cXML>`,
    }),
  });
  check(`Forged buyerCookie rejected (${res.status})`, res.status === 404);
}

await browser.close();
console.log(failures === 0 ? "\nALL PUNCHOUT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
