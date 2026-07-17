/* Capture desktop + mobile screenshots of every screen, all 4 roles, as Plumb Zebra. */
import { chromium, devices } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "/tmp/shots";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const ID = {
  customer: "096b248d-4664-4a6a-9ce1-c29af79a2ecd",
  job: "6242ae2b-848b-4bab-8c27-68af658f348e",
  estimate: "5ee9e11a-983e-4243-9175-53dae9bef71f",
  lead: "ee7db8b6-47af-428f-85d7-ab820f962d9b",
  claim: "b4b5ce10-6e83-4650-b475-eaa5cd05f568",
  project: "0389c2d7-d729-4e81-8dff-42d3b4c7e470",
  inspection: "31c5d6af-58d4-48ba-b595-4a18dd2ee516",
  kbslug: "discount-policy",
  conversation: "ef1a2e2c-0c36-4fee-aa2b-70f4c7c72b9c",
};

const ROLES = {
  owner: {
    email: "owner@plumbzebra.demo",
    screens: [
      ["dashboard", "/dashboard"], ["dispatch", "/dispatch"], ["approvals", "/approvals"],
      ["pipeline", "/pipeline"], ["jobs", "/jobs"], ["job-detail", `/jobs/${ID.job}`],
      ["projects", "/projects"], ["project-detail", `/projects/${ID.project}`],
      ["customers", "/customers"], ["customer-detail", `/customers/${ID.customer}`],
      ["invoices", "/invoices"], ["claims", "/claims"], ["claim-detail", `/claims/${ID.claim}`],
      ["compliance", "/compliance"], ["inspection-detail", `/compliance/inspections/${ID.inspection}`],
      ["inventory", "/inventory"], ["pricebook", "/pricebook"], ["commissions", "/commissions"],
      ["messages", "/messages"], ["knowledge", "/kb"], ["settings", "/settings"],
      ["settings-integrations", "/settings?tab=integrations"],
    ],
  },
  dispatcher: {
    email: "office@plumbzebra.demo",
    screens: [
      ["dispatch", "/dispatch"], ["approvals", "/approvals"], ["jobs", "/jobs"],
      ["job-detail", `/jobs/${ID.job}`], ["job-closeout", `/jobs/${ID.job}/closeout`],
      ["customers", "/customers"], ["customer-detail", `/customers/${ID.customer}`],
      ["leads", "/leads"], ["invoices", "/invoices"], ["claims", "/claims"],
      ["compliance", "/compliance"], ["inventory", "/inventory"],
      ["messages", "/messages"], ["conversation", `/messages/${ID.conversation}`], ["knowledge", "/kb"],
    ],
  },
  technician: {
    email: "tech@plumbzebra.demo",
    screens: [
      ["my-day", "/my-day"], ["field-mode", "/field"], ["truck-stock", "/inventory"],
      ["knowledge", "/kb"], ["kb-article", `/kb/${ID.kbslug}`],
      ["messages", "/messages"], ["earnings", "/earnings"],
    ],
  },
  sales: {
    email: "sales@plumbzebra.demo",
    screens: [
      ["cockpit", "/cockpit"], ["leads", "/leads"], ["lead-detail", `/leads/${ID.lead}`],
      ["pipeline", "/pipeline"], ["estimates", "/estimates"], ["estimate-detail", `/estimates/${ID.estimate}`],
      ["projects", "/projects"], ["project-detail", `/projects/${ID.project}`],
      ["claims", "/claims"], ["customers", "/customers"], ["customer-detail", `/customers/${ID.customer}`],
      ["messages", "/messages"], ["knowledge", "/kb"], ["earnings", "/earnings"],
    ],
  },
};

const VIEWPORTS = [
  { key: "desktop", opts: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } },
  { key: "mobile", opts: { ...devices["iPhone 13"] } },
];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const manifest = [];
let shot = 0, fail = 0;

// Login screen first (shared, both viewports).
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext(vp.opts);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const file = `${OUT}/login_${vp.key}.png`;
  await page.screenshot({ path: file });
  manifest.push({ role: "login", screen: "login", device: vp.key, file });
  shot++;
  await ctx.close();
}

for (const [role, cfg] of Object.entries(ROLES)) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext(vp.opts);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.fill('input[name="email"]', cfg.email);
    await page.fill('input[name="password"]', "demo1234");
    await page.click('button[type="submit"]');
    await page.waitForLoadState("networkidle");

    for (const [name, path] of cfg.screens) {
      try {
        await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 25000 });
      } catch { /* continue; capture whatever rendered */ }
      // Field mode needs a beat to boot its client workspace.
      await page.waitForTimeout(path === "/field" ? 2200 : 700);
      const file = `${OUT}/${role}_${name}_${vp.key}.png`;
      try {
        await page.screenshot({ path: file });
        manifest.push({ role, screen: name, device: vp.key, path, file });
        shot++;
      } catch { fail++; }
    }
    await ctx.close();
  }
  console.log(`✓ ${role}: captured`);
}

await browser.close();
fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`\n${shot} screenshots captured (${fail} failed) → ${OUT}`);
