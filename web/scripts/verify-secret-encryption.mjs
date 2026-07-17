/* E2E: connector secret is stored ENCRYPTED at rest but usable in-app. */
import { chromium } from "playwright";
import { Pool } from "pg";

const BASE = "http://localhost:3000";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
};

const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
await page.fill('input[name="email"]', "owner@apexplumbing.demo");
await page.fill('input[name="password"]', "demo1234");
await page.click('button[type="submit"]');
await page.waitForLoadState("networkidle");

// Configure the cXML supplier connector through the real settings form.
await page.goto(`${BASE}/settings?tab=integrations`);
await page.waitForLoadState("networkidle");
const form = page.locator('form:has(input[name="setupUrl"])');
// Open the <details> wrapping it if collapsed.
await form.locator('input[name="setupUrl"]').scrollIntoViewIfNeeded().catch(() => {});
const summary = page.locator('details:has(input[name="setupUrl"]) > summary');
if ((await summary.count()) > 0) await summary.first().click().catch(() => {});

await form.locator('input[name="supplierName"]').fill("Ferguson");
await form.locator('input[name="setupUrl"]').fill("http://localhost:8903/cxml/setup");
await form.locator('input[name="fromIdentity"]').fill("AN-APEX");
await form.locator('input[name="toIdentity"]').fill("AN-FERG");
await form.locator('input[name="sharedSecret"]').fill("mascott-shared-secret");
await form.locator('button[type="submit"]').click();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(800);

// Health handshake against the mock supplier had to DECRYPT the stored secret
// and present it — a CONNECTED status proves the round-trip works.
await page.goto(`${BASE}/settings?tab=integrations`);
await page.waitForLoadState("networkidle");
const cardText = await page.locator('form:has(input[name="setupUrl"])').locator("xpath=ancestor::*[contains(@class,'rounded')][1]").first().textContent().catch(() => "");
const bodyText = await page.textContent("body");
check("cXML supplier connector reports Connected after configure (secret decrypted + used)", /Supplier punchout[\s\S]*Connected|Connected[\s\S]*Supplier punchout/.test(bodyText) || (cardText ?? "").includes("Connected"));

// The password field must NOT be pre-filled with ciphertext.
const secretVal = await page.locator('form:has(input[name="setupUrl"]) input[name="sharedSecret"]').inputValue().catch(() => "");
check("secret field is masked in the UI (not pre-filled with ciphertext)", secretVal === "" );

await ctx.close();
await browser.close();

// Assert the DB stores ciphertext, not the plaintext secret. integration_
// connections is under RLS, so we must set the tenant context to read it —
// (a raw context-less read correctly returns zero rows).
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
await client.query("BEGIN");
await client.query(
  "SELECT set_config('app.current_org', (SELECT id FROM organizations WHERE slug='apex-plumbing'), true)"
);
const { rows } = await client.query(
  `SELECT config->>'sharedSecret' AS secret, config->>'setupUrl' AS url, status
   FROM integration_connections WHERE provider = 'CXML_SUPPLIER' LIMIT 1`
);
await client.query("COMMIT");
client.release();
await pool.end();
const row = rows[0];
check("row exists and status CONNECTED", Boolean(row) && row.status === "CONNECTED");
check("sharedSecret is CIPHERTEXT at rest (enc:v1:)", Boolean(row?.secret?.startsWith("enc:v1:")));
check("plaintext secret does NOT appear in the DB", !(row?.secret ?? "").includes("mascott-shared-secret"));
check("non-secret field (setupUrl) stays plaintext", row?.url === "http://localhost:8903/cxml/setup");

console.log(failures === 0 ? "\nALL SECRET-ENCRYPTION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
